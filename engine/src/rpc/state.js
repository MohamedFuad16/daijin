// Daemon state that is not a repo's brain: which repos are attached, the settings, and
// the board. File-backed JSON under a state root, so a restart does not lose the home
// screen and so tests can point it at a temp directory.
//
// SECRETS ARE POINTERS, NEVER VALUES. A role carries `keyRef`, the name of an environment
// variable or a file path, and the daemon never reads a key into a response. settingsGet
// returns `keyMasked` for display. This is the platform's `secrets.md is pointers-only`
// rule applied to the surface a GUI can reach.

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { writeJsonAtomic as sharedWriteJsonAtomic } from '../runtime/atomic.js';

import { checkKeyRef, keyRefRefusal, parseKeyRef } from '../roles/keys.js';
import { checkRoleProvider, describeRoleModel } from '../roles/providers.js';

export const ROLES = Object.freeze(['engineer', 'teacher', 'auditor', 'watcher']);
export const AGENT_FILES = Object.freeze(['student', 'teacher', 'auditor', 'watcher']);

/** Retrieval defaults: the anchor budget, and the k the committed floor was measured at. */
export const DEFAULT_SETTINGS = Object.freeze({
  roles: ROLES.map((role) => ({
    role,
    // `provider` replaces the removed `preset` (D-0037). preset was declared here, written
    // by nothing, and rendered as a column by the TUI that was populated only in its mock
    // data, so against a real engine that column was always blank. A name like "Claude" is
    // a RENDERING of provider plus model rather than a stored value, and keeping both
    // fields is how two names for one fact drift apart.
    //
    // The value is a vendor id from engine/config/providers.json, validated at set time
    // against that catalog. The catalog owns the closed set; this file does not repeat it.
    provider: null,
    model: null,
    // Null is the ONLY encoding of "this model has no reasoning control". A string like
    // 'none' would read as a supported setting deliberately turned off, which is a
    // different claim about the model.
    reasoningEffort: null,
    endpoint: null,
    keyRef: null,
    keyMasked: null,
    // ZAI web tools (web_search; Reader and Zread share its quota): a list of tool ids
    // the role's calls should carry, or null for none. Stored per role because the
    // engineer may want search the teacher must not have.
    tools: null,
    // A Claude Code sub-agent id (agentCatalog row) when provider is claude-code. The
    // role then runs headless through the local claude CLI instead of an API key.
    agentRef: null,
    // v5: `ping: null` is the canonical encoding for a NEVER-VERIFIED role. rolePing is
    // spend-touching and never fires automatically, so "never paid for" has to be
    // representable. An object full of nulls would read as a ping that ran and returned
    // nothing, which is a different and worse claim; clients render null as "never".
    ping: null,
  })),
  instructionFiles: [],
  // The measured retrieval configuration, plus which embedder builds and serves the index.
  // Embedding lives under `retrieval` rather than as a seventh top-level key because the
  // contract fixes settingsGet's key set, and the embedder IS a retrieval parameter: every
  // absolute threshold here sits on one embedder's similarity distribution.
  retrieval: {
    tokenBudget: 4000,
    k: 8,
    slotFloor: 0.55,
    perCandidateCapRatio: 0.22,
    embeddingModel: 'bge-m3',
    embeddingDimension: 1024,
    ollamaBaseUrl: null,
  },
  storage: { backend: 'sqlite' },
  // Where the attach dialog looks for repositories to offer. ENGINE-SIDE because it is a
  // user preference that must survive the client: a scan root kept in a TUI config is lost
  // the first time the owner uses a different front end against the same daemon.
  repoScanRoots: [path.join(homedir(), 'Documents'), path.join(homedir(), 'Documents', 'GitHub')],
  spendGate: { open: false, path: null },
  charts: { radar: 'unicode' },
});

// EVERY ROLE CARRIES THE FULL KEY SET, whatever is on disk.
//
// The top-level merge is shallow, so a stored settings.json replaces the default `roles`
// array wholesale. Without this, an owner who configured roles BEFORE a field was added
// keeps rows missing that field, and the contract promises a closed key set: the shape
// would be right on a fresh state root and wrong on the only machine that matters. The
// same reasoning retires `preset`, which is dropped here rather than left to linger in
// one person's settings file forever.
//
// Unknown keys are dropped rather than preserved. A settings file is not a place to keep
// data nothing reads: it reappears in settingsGet, where a client cannot tell a retired
// field from a live one.
function normalizeRoles(stored) {
  const byRole = new Map((stored || []).map((role) => [role.role, role]));
  return DEFAULT_SETTINGS.roles.map((template) => {
    const found = byRole.get(template.role) || {};
    const row = { ...structuredClone(template) };
    for (const key of Object.keys(template)) {
      if (key !== 'role' && found[key] !== undefined) row[key] = found[key];
    }
    return row;
  });
}

function maskKeyRef(keyRef) {
  if (!keyRef) return null;
  // A pointer is not a secret, but it can still name one, so the display form keeps the
  // shape and drops the tail.
  const text = String(keyRef);
  return text.length <= 8 ? `${text.slice(0, 2)}...` : `${text.slice(0, 4)}...${text.slice(-2)}`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    // A corrupt state file must not take the daemon down: the home screen is recoverable
    // by re-attaching, and refusing to start would strand the user with no UI at all.
    return fallback;
  }
}

let writeCounter = 0;

/**
 * Write JSON atomically: temp file, then rename.
 *
 * EXPORTED so the unique-temp-name property can be tested on its own. The serialization
 * queue means EngineState never calls this concurrently today, so a test driven through
 * EngineState cannot fail if the temp name goes back to being shared, which would make
 * that fix dead coverage. This function is safe on its own terms, and is tested that way,
 * because the next caller to write state might not come through the queue.
 */
export async function writeJsonAtomic(file, value) {
  // DELEGATED, not duplicated. The rule this function was fixed for (a temp name unique per
  // WRITE rather than per process) survived unfixed at three other sites, because the fix
  // lived here as an expression rather than as a thing others could use. Keeping a second
  // copy of it here would repeat exactly that.
  return sharedWriteJsonAtomic(file, value);
}

export class EngineState {
  /**
   * Serializes every read-modify-write.
   *
   * The daemon lock protects the state files from another PROCESS. Nothing protected them
   * from another CONNECTION inside one daemon, and those are different problems: attach,
   * detach and settings patches all read the whole file, change it, and write it back, so
   * two overlapping calls interleave and the later write is computed from a stale read.
   *
   * Not reachable while one sequential stdio client is the only caller, which is exactly
   * why it survived this long. It becomes reachable the moment a second client attaches or
   * a job writes state, so it is fixed ahead of both rather than alongside whichever
   * arrives first.
   */
  #queue = Promise.resolve();

  /// Run `body` after every previously queued mutation, whatever their outcome. A rejection
  /// must not break the chain, or one failed write would wedge every write after it.
  #serialize(body) {
    const result = this.#queue.then(body, body);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  constructor({ stateRoot }) {
    if (!stateRoot) throw new Error('EngineState requires a stateRoot.');
    this.stateRoot = path.resolve(stateRoot);
    this.reposFile = path.join(this.stateRoot, 'repos.json');
    this.settingsFile = path.join(this.stateRoot, 'settings.json');
    this.boardFile = path.join(this.stateRoot, 'board.json');
    this.consentFile = path.join(this.stateRoot, 'consent.jsonl');
  }

  async repos() {
    const rows = await readJson(this.reposFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  async attachRepo(repoPath) {
    return this.#serialize(async () => this.#attachRepo(repoPath));
  }

  async #attachRepo(repoPath) {
    const resolved = path.resolve(repoPath);
    const rows = await this.repos();
    const existing = rows.find((row) => row.path === resolved);
    if (existing) return existing;
    // health starts at no-brain and is corrected by serveStatus, which reads the real
    // store. analyze().hasBrainFolder is authoritative per the contract, and it costs a
    // filesystem scan, so attach does not pay for it.
    const repo = { path: resolved, health: 'no-brain', floorScore: null, mcpActive: false };
    rows.push(repo);
    await writeJsonAtomic(this.reposFile, rows);
    return repo;
  }

  async detachRepo(repoPath) {
    return this.#serialize(async () => this.#detachRepo(repoPath));
  }

  async #detachRepo(repoPath) {
    const resolved = path.resolve(repoPath);
    const rows = await this.repos();
    const kept = rows.filter((row) => row.path !== resolved);
    if (kept.length === rows.length) return false;
    await writeJsonAtomic(this.reposFile, kept);
    return true;
  }

  async isAttached(repoPath) {
    const resolved = path.resolve(repoPath);
    return (await this.repos()).some((row) => row.path === resolved);
  }

  async rawSettings() {
    const stored = await readJson(this.settingsFile, null);
    if (!stored) return structuredClone(DEFAULT_SETTINGS);
    const merged = { ...structuredClone(DEFAULT_SETTINGS), ...stored };
    merged.roles = normalizeRoles(merged.roles);
    // EVERY OBJECT-VALUED SECTION GETS ITS DEFAULTS BACK, for the same reason roles do and
    // as the same defect: the spread above is SHALLOW, so a stored `retrieval` replaces the
    // default one entirely rather than filling in around it. A settings.json written before
    // `embeddingDimension` existed therefore lost that default, and serveStatus sent
    // `dimension: null` on exactly the machines with the longest history: aged state, which
    // is the only state a real owner has.
    //
    // Done for the CLASS rather than for retrieval alone. Three other sections have the
    // same shape, and fixing the one with a visible symptom would leave the next one to be
    // found by whoever adds a key to `storage` or `charts`.
    //
    // ARRAYS ARE NOT MERGED, deliberately: a stored list REPLACES its default, because a
    // list is data rather than a shape and a merge cannot express removing an entry. The
    // owner who deleted a scan root must not have it handed back.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (Array.isArray(value) || value === null || typeof value !== 'object') continue;
      merged[key] = { ...structuredClone(value), ...(merged[key] || {}) };
    }
    return merged;
  }

  /**
   * The display form: every role's key is a masked pointer, never a value.
   *
   * `keyResolvable` answers "can this role reach its key" WITHOUT handing the key over, so
   * a settings screen can render ready or not-ready without a secret crossing the RPC
   * boundary. It is a filesystem read per configured role, which is why an unconfigured
   * role short-circuits to null rather than reporting false: never configured is not the
   * same claim as configured and broken.
   */
  async settings() {
    const settings = await this.rawSettings();
    settings.roles = await Promise.all((settings.roles || []).map(async (role) => ({
      ...role,
      keyMasked: maskKeyRef(role.keyRef),
      ...(role.keyRef
        ? await checkKeyRef(role.keyRef).then((checked) => ({ keyResolvable: checked.resolvable, keyReason: checked.reason }))
        : { keyResolvable: null, keyReason: null }),
      // Derived, never stored, exactly like keyResolvable: a model that is in the catalog
      // today can leave it tomorrow when the file is corrected, and a stored answer would
      // outlive the question. Three states, same encoding as keyResolvable: null is no
      // model configured, which is a different claim from configured-and-unrecognised.
      ...(await describeRoleModel(role)),
    })));
    return settings;
  }

  async patchSettings(patch = {}) {
    return this.#serialize(async () => this.#patchSettings(patch));
  }

  async #patchSettings(patch = {}) {
    const settings = await this.rawSettings();
    for (const rolePatch of patch.roles || []) {
      const role = (settings.roles || []).find((entry) => entry.role === rolePatch.role);
      if (!role) continue;
      // `ping` is a MEASUREMENT, never a setting. Accepting it from a patch would let a
      // client mark its own roles ready without a provider ever answering.
      for (const [key, value] of Object.entries(rolePatch)) {
        if (key === 'role' || key === 'ping' || key === 'keyMasked') continue;
        // Derived, never stored: writing them back would let a client claim a role is
        // reachable without anything having checked.
        if (key === 'keyResolvable' || key === 'keyReason') continue;
        if (key === 'modelKnown' || key === 'modelReason') continue;
        // A malformed pointer is refused AT SET TIME. Stored unchecked it fails later, at
        // the moment of a provider call, where the user reads it as the provider being
        // down rather than as a setting they mistyped. A bare name is the common mistake
        // and is deliberately not accepted: it reads as an environment variable to one
        // person and a relative path to another.
        if (key === 'keyRef' && value !== null && !parseKeyRef(value)) {
          // The REASON, not just the rejection. A refusal that lists three accepted forms
          // leaves the reader diffing their own string against examples to find the one
          // character that is wrong, and for the commonest case (a relative path) the
          // answer can simply be handed to them.
          throw new Error(`Unusable key pointer for the ${role.role} role. ${keyRefRefusal(value)}`);
        }
        role[key] = value;
      }
      // THE TRIO IS VALIDATED AFTER THE WHOLE PATCH IS APPLIED, not per key, because a
      // client sets provider and model together and either one alone reads as invalid
      // against the other's old value. Refused at set time for the same reason keyRef is:
      // stored unchecked it fails at the moment of a provider call, where the user reads
      // it as the provider being down rather than as a setting they mistyped.
      const reason = await checkRoleProvider(role);
      if (reason) throw new Error(`Unusable provider settings for the ${role.role} role: ${reason}`);
    }
    for (const key of ['retrieval', 'storage', 'charts']) {
      if (patch[key]) settings[key] = { ...settings[key], ...patch[key] };
    }
    if (patch.repoScanRoots !== undefined) {
      // REPLACED WHOLESALE, never merged: it is a list, and spreading a list over a list
      // by key would leave a shorter new list wearing the tail of the old one. Removing a
      // scan root has to be possible, and a merge cannot express removal.
      if (!Array.isArray(patch.repoScanRoots) || patch.repoScanRoots.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        throw new Error('repoScanRoots must be a list of non-empty directory paths.');
      }
      settings.repoScanRoots = patch.repoScanRoots.map((entry) => path.resolve(entry.trim()));
    }
    await writeJsonAtomic(this.settingsFile, settings);
    return this.settings();
  }

  /**
   * Record a role's ping MEASUREMENT. A separate method from patchSettings on purpose:
   * patchSettings refuses `ping` from clients because a client writing its own ping is a
   * client marking its roles verified without a provider answering. The engine measured
   * this one, so it enters through the engine's own door.
   */
  async recordRolePing(roleName, ping) {
    return this.#serialize(async () => {
      const settings = await this.rawSettings();
      const role = (settings.roles || []).find((entry) => entry.role === roleName);
      if (!role) throw new Error(`unknown role ${roleName}`);
      role.ping = ping;
      await writeJsonAtomic(this.settingsFile, settings);
      return this.settings();
    });
  }

  /**
   * Append a consent record. Append-only, one JSON object per line.
   *
   * The audit trail for a spend path has to show WHAT THE USER SAW, not merely that they
   * agreed: consent to an estimate of 800,000 tokens is not consent to 8,000,000, and six
   * weeks later the only way to tell those apart is a record made at the moment.
   *
   * It lives here rather than in a job record because the spend-touching jobs do not exist
   * yet, and a consent that is only recorded once the job exists is not recorded at the
   * moment of consent. When P3 and P4 write real job records they should carry the same
   * fields and can join on `at`.
   */
  async recordConsent({ method, repoPath = null, budget = null, at = new Date().toISOString() }) {
    // An append does not read-modify-write, so it cannot lose a record. It shares the queue
    // anyway so the trail's line order matches the order consent was actually given, which
    // is the property anyone reading an audit trail assumes without being told.
    return this.#serialize(async () => {
      const row = { at, method, repoPath, budget };
      await mkdir(this.stateRoot, { recursive: true });
      await appendFile(this.consentFile, `${JSON.stringify(row)}\n`, 'utf8');
      return row;
    });
  }

  /// Every consent recorded, newest last. Reads tolerate a truncated final line, because a
  /// crash mid-append must not make the whole trail unreadable.
  async consentLog() {
    try {
      return (await readFile(this.consentFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async board() {
    const rows = await readJson(this.boardFile, []);
    return Array.isArray(rows) ? rows : [];
  }

  async addBoardFinding(row) {
    return this.#serialize(async () => this.#addBoardFinding(row));
  }

  async #addBoardFinding(row) {
    const rows = await this.board();
    rows.unshift(row);
    await writeJsonAtomic(this.boardFile, rows);
    return row;
  }
}
