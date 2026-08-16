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
import path from 'node:path';

export const ROLES = Object.freeze(['engineer', 'teacher', 'auditor', 'watcher']);
export const AGENT_FILES = Object.freeze(['student', 'teacher', 'auditor', 'watcher']);

/** Retrieval defaults: the anchor budget, and the k the committed floor was measured at. */
export const DEFAULT_SETTINGS = Object.freeze({
  roles: ROLES.map((role) => ({
    role,
    preset: null,
    model: null,
    endpoint: null,
    keyRef: null,
    keyMasked: null,
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
  spendGate: { open: false, path: null },
  charts: { radar: 'unicode' },
});

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
  await mkdir(path.dirname(file), { recursive: true });
  // Unique PER WRITE, not per process. `${file}.tmp-${process.pid}` was the same name for
  // every concurrent write inside one daemon, so two writes clobbered each other's temp
  // file and one rename failed with ENOENT. Measured: it failed at two concurrent writes,
  // and nine of ten under load.
  writeCounter += 1;
  const temporary = `${file}.tmp-${process.pid}-${writeCounter}-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
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
    return { ...structuredClone(DEFAULT_SETTINGS), ...stored };
  }

  /// The display form: every role's key is a masked pointer, never a value.
  async settings() {
    const settings = await this.rawSettings();
    settings.roles = (settings.roles || []).map((role) => ({
      ...role,
      keyMasked: maskKeyRef(role.keyRef),
    }));
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
        role[key] = value;
      }
    }
    for (const key of ['retrieval', 'storage', 'charts']) {
      if (patch[key]) settings[key] = { ...settings[key], ...patch[key] };
    }
    await writeJsonAtomic(this.settingsFile, settings);
    return this.settings();
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
