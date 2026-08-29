// The owner spend gate. Ported in discipline from the platform (platform/exam/paid-gate.js),
// not in mechanism, and the difference is deliberate and stated here because it is a
// WEAKENING of the platform's control.
//
// The platform requires the gate to be a file tracked in HEAD with no uncommitted diff, so
// opening it is a reviewed commit. Daijin cannot require that: the gate lives in the user's
// repo under .daijin/, and the gym never touches the user's git (plan line: "Gym writes only
// to its own store, never the user's git"). Requiring a commit would make the product's
// first spend depend on the user committing a file into their own history.
//
// What is kept, and what replaces the commit requirement:
//
//  - BLOCKED BY DEFAULT. A missing gate, an unparseable gate, a gate with an unknown status
//    and a gate without a reason all REFUSE. Every failure mode of the file is a refusal;
//    none of them is an open gate.
//  - The gate is the OWNER's file. This module exports readers, an asserter, and exactly one
//    writer, and that writer can only ever write `blocked` (the platform's automatic safety
//    closure after a paid operation). There is no code path anywhere in the gym that writes
//    an open gate; `gateWriterOffenders` is the mechanical check that keeps it that way.
//  - Refusal is JSON-RPC -32050 carrying the gate PATH, per the RPC v4 error convention, so
//    the TUI can tell the user which file to flip instead of saying "not allowed".
//  - The reason is required and is recorded into every run's provenance, so a scored record
//    can always answer why this spend was authorized.

import { readFile as readFileNative, rename, writeFile as writeFileNative } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../runtime/atomic.js';

/** Scopes a gate may authorize. A scope names an operation that calls a provider. */
export const GYM_SPEND_SCOPES = Object.freeze(['gym-cycle', 'exam-mining', 'gym-resume']);

/** RPC v4 error convention: spend-gated refusals use -32050 with the gate path in data. */
export const SPEND_REFUSED_CODE = -32050;

/** Statuses the gate file may carry. `open` authorizes any gym scope; `authorized` names
 *  one. Anything else, including anything absent, is blocked. */
export const GATE_STATUSES = Object.freeze(['open', 'authorized', 'blocked']);

export class SpendRefusedError extends Error {
  constructor(message, { gate, hint }) {
    super(message);
    this.name = 'SpendRefusedError';
    this.code = SPEND_REFUSED_CODE;
    // The RPC data field, verbatim: `hint` is displayed to the user, `gate` is the path.
    this.data = { hint: hint || message, gate };
  }
}

/** Where the gate lives for a repo. One gate per connected repo, beside the brain. */
export function gymSpendGatePath(repoPath) {
  return path.join(path.resolve(repoPath), '.daijin', 'GATE');
}

/** Parse a gate document. Pure, so every refusal branch is testable without a filesystem.
 *  Returns the gate shape the rest of the engine reads: `open` is the only field a caller
 *  should branch on, and it is false for every malformed input. */
export function parseSpendGate(raw, { file }) {
  const blocked = (reason, hint) => ({
    file, open: false, status: 'blocked', scope: null, reason, hint: hint || reason,
  });
  if (raw === null || raw === undefined) {
    return blocked('No gate file.', `Spend is blocked: no gate at ${file}. The owner opens it; the gym never does.`);
  }
  let gate;
  try {
    gate = JSON.parse(raw);
  } catch (error) {
    return blocked(`Gate file is not valid JSON: ${error.message}`, `Spend is blocked: ${file} is not valid JSON.`);
  }
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    return blocked('Gate file must be a JSON object.', `Spend is blocked: ${file} must be a JSON object.`);
  }
  if (!GATE_STATUSES.includes(gate.status)) {
    return blocked(
      `Gate status must be one of ${GATE_STATUSES.join(', ')}.`,
      `Spend is blocked: ${file} carries status ${JSON.stringify(gate.status ?? null)}.`,
    );
  }
  const reason = typeof gate.reason === 'string' ? gate.reason.trim() : '';
  if (!reason) {
    return blocked('Gate reason is required.', `Spend is blocked: ${file} has no reason. An authorization without a reason is not auditable.`);
  }
  if (gate.status === 'blocked') {
    if (Object.hasOwn(gate, 'scope')) {
      return blocked('A blocked gate cannot carry a scope.', `Spend is blocked: ${file} carries a scope while blocked.`);
    }
    return { file, open: false, status: 'blocked', scope: null, reason, hint: `Spend is blocked by ${file}: ${reason}` };
  }
  if (gate.status === 'authorized') {
    if (!GYM_SPEND_SCOPES.includes(gate.scope)) {
      return blocked(
        `An authorized gate needs a known scope (${GYM_SPEND_SCOPES.join(', ')}).`,
        `Spend is blocked: ${file} authorizes unknown scope ${JSON.stringify(gate.scope ?? null)}.`,
      );
    }
    return { file, open: true, status: 'authorized', scope: gate.scope, reason, hint: null };
  }
  if (Object.hasOwn(gate, 'scope')) {
    return blocked('An open gate authorizes every scope and cannot name one.', `Spend is blocked: ${file} is open and also names a scope; use status authorized for one scope.`);
  }
  return { file, open: true, status: 'open', scope: null, reason, hint: null };
}

/** Read the gate. Never throws for a bad gate: a bad gate is a blocked gate, and the
 *  caller that must refuse is `assertSpendGate`. serveStatus reads this one. */
export async function readSpendGate({ repoPath, file, readFile = readFileNative } = {}) {
  const target = file || gymSpendGatePath(repoPath);
  let raw;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    // Unreadable for ANY reason is blocked, and the reason is carried rather than
    // flattened: a permissions error and a missing file are both refusals, but only one of
    // them is fixed by writing a gate.
    const unreadable = parseSpendGate(null, { file: target });
    return error.code === 'ENOENT' ? unreadable : {
      ...unreadable,
      reason: `Gate file is unreadable: ${error.message}`,
      hint: `Spend is blocked: ${target} could not be read (${error.code || 'error'}).`,
    };
  }
  return parseSpendGate(raw, { file: target });
}

/** The guard in front of every provider-calling operation. Throws SpendRefusedError, which
 *  the RPC layer renders as -32050 with `data.gate`. */
export async function assertSpendGate(scope, options = {}) {
  if (!GYM_SPEND_SCOPES.includes(scope)) throw new Error(`Unknown gym spend scope: ${scope ?? '<missing>'}`);
  const gate = await readSpendGate(options);
  if (!gate.open) {
    throw new SpendRefusedError(`Gym spend for ${scope} is blocked by ${gate.file}: ${gate.reason}`, {
      gate: gate.file, hint: gate.hint,
    });
  }
  if (gate.status === 'authorized' && gate.scope !== scope) {
    throw new SpendRefusedError(`Gate authorizes ${gate.scope}, not ${scope}: ${gate.file}`, {
      gate: gate.file,
      hint: `Spend is blocked: ${gate.file} authorizes ${gate.scope}, and this operation is ${scope}.`,
    });
  }
  return gate;
}

/** The platform's automatic safety closure, and the ONLY writer in this module.
 *
 *  It writes `blocked` and nothing else: the status is a literal here rather than a
 *  parameter precisely so no caller, present or future, can reach an open gate through it.
 *  The platform commits the closure; here the write is the closure, because the gym does
 *  not touch the user's git. */
export async function autoBlockSpendGate({
  repoPath, file, reason, readFile = readFileNative, writeFile = writeFileNative, renameFile = rename,
} = {}) {
  const target = file || gymSpendGatePath(repoPath);
  const before = await readSpendGate({ file: target, readFile });
  // A gate that is already refusing is left exactly as it is, malformed gates included: the
  // closure exists to end an authorization, not to normalize the owner's file.
  if (!before.open) return { changed: false, ...before };
  const closure = {
    status: 'blocked',
    reason: reason || 'Automatic safety closure after gym spend; the owner opens a new authorization before further paid work.',
  };
  // Through the shared writer, same class fix. This one matters most of the three: it is
  // the AUTOMATIC GATE CLOSURE after paid work, so a collided temp name here fails the
  // write that re-blocks spending.
  await writeJsonAtomic(target, closure, { writeFile, rename: renameFile });
  const after = await readSpendGate({ file: target, readFile });
  if (after.open) throw new Error(`Gym gate auto-closure did not persist a blocked gate: ${target}`);
  return { changed: true, ...after };
}

// ---------------------------------------------------------------------------------------
// The mechanical form of "no code path exists that opens the gate".
//
// WIDENED 2026-08-16 (D-0023, verifier finding 73). The previous scanner caught 1 of the
// verifier's 4 planted offenders, including the demo-helper scenario its own comment named
// as its purpose. Two design errors, both the same mistake in different clothes: it reasoned
// about the write TARGET (a target can be concatenated, templated, or held in a variable),
// and inside the gate module it demanded a gate reference AND an open literal in the same
// forward window (an owner-shaped mutant has neither, because the module's own helpers
// supply both from elsewhere).
//
// I argued for the narrower rule on the grounds that a scanner everyone learns to silence is
// worse than one that fires honestly. The argument was heard and recorded; the PLANTS
// decided, and they decided against it. What follows is the widened design, and the
// burden-of-proof inversion that makes the owner rule immune to target shape:
//
//  - OWNER (spend-gate.js): every write call is GUILTY UNLESS PROVABLY BLOCKED. A write here
//    passes only when a `status: 'blocked'` literal sits in its immediate neighborhood. Not
//    "no open literal nearby", which any indirection defeats, but "the blocked literal is
//    right there", which nothing but an actual blocked write satisfies. A refactor that moves
//    the closure object away from its write breaks this and should: adjacency is the proof.
//  - FOREIGN (everything else): a module that writes files AND names the gate anywhere is an
//    offender unless it holds an explicit allowlist entry. Naming covers the helper, quoted
//    and template paths ending in /GATE, and shell redirection into one.
//  - ALLOWLISTED foreign modules are still not excused for writes NEAR the gate: an entry
//    buys "mentions the gate and writes files elsewhere", never "writes where the gate is
//    named". Otherwise the allowlist is the silence I was worried about.
//
// False positives behind an allowlist are the correct trade for a rule whose failure mode is
// silence. Two bounds on the widening, because a rule that fires on everything is the same
// silence with extra steps: a module that writes files and never names the gate is CLEAN
// (writeFile(resultPath, ...) must stay clean, or nobody can write a file in this engine),
// and prose is not a reference (an unquoted mention of the gate in a comment is not a path).

// Any identifier CONTAINING write, not a closed list of spellings. The closed list was
// blind to the two spellings this codebase actually uses - writeFileNative( (the alias
// THIS FILE imports and writes the gate with) and writeJsonAtomic( - so the owner file
// matched zero writes and the licence apparatus below never ran on the one module it
// exists to audit. The comment beside the blocked write claimed the regex "must SEE this
// call"; it did not. Demonstrated with two bypass strings before widening.
const WRITE_CALL = /\b[\w$]*[wW]rite[\w$]*\s*\(|\b(?:appendFile|appendFileSync|outputFile)\s*\(/g;

/** Naming the gate: the helper, a quoted or template path that ends at a GATE segment, or a
 *  shell command redirecting into one. Quotes are required so prose stays prose. */
const GATE_REFERENCE = /gymSpendGatePath|['"`][^'"`]*(?:\/|^)GATE(?:['"`]|\$|\s|\\n)|['"`]GATE['"`]|\.daijin\/GATE/;

/** A shell write into the gate, which no file-write regex would ever see. */
const SHELL_GATE_WRITE = /['"`][^'"`]*(?:>>?|tee)\s*[^'"`]*GATE[^'"`]*['"`]/;

const OPEN_STATUS_LITERAL = /status\s*:\s*['"`](open|authorized)['"`]|\\?"status\\?"\s*:\s*\\?"(open|authorized)/;
/** The one licensed opening write (D-0060). The marker is CODE, not a comment (comments are
 *  stripped before scanning), and it is written INTO the gate file, so the file itself
 *  records that a TUI owner action produced it. */
const OWNER_ACTION_LITERAL = /ownerAction\s*:\s*['"`]OWNER-ACTION GATE WRITE \(D-0060\)['"`]/;
const BLOCKED_STATUS_LITERAL = /status\s*:\s*['"`]blocked['"`]|\\?"status\\?"\s*:\s*\\?"blocked/;

/** How far around a write call counts as its neighborhood. Backwards as well as forwards:
 *  a payload is built before it is written, and a forward-only window is exactly how the
 *  owner-variable-target plant walked past the previous scanner. */
const WINDOW_BACK = 500;
const WINDOW_FORWARD = 300;

/** A variable bound to the gate path, tracked so a write to it is caught at any distance. */
const GATE_PATH_ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?gymSpendGatePath\s*\(/g;

/** Modules permitted to write files while naming the gate, each with the reason it is
 *  allowed. An entry is a decision someone has to defend, which is the point of writing it
 *  here rather than loosening a rule. */
export const GATE_SCAN_ALLOWLIST = Object.freeze([
  {
    path: 'methods.js',
    reason: 'The RPC surface reads the gate path for serveStatus and writes score history, '
      + 'agent files and gates.yaml. It never writes the gate, and the near-write rule below '
      + 'still holds it to that.',
  },
  {
    path: 'layout.js',
    reason: 'The state-layout module DEFINES where the gate lives (D-0031), so it necessarily '
      + 'names it, and it writes manifest.json and origin.json. It never writes the gate '
      + 'itself, and the near-write rule still holds it to that. Added when the scanned-set '
      + 'test caught src/state appearing, which is the test doing its job rather than a '
      + 'nuisance: a new directory that knows where the gate is must be decided about.',
  },
]);

/** Lines that are wholly prose: a line comment, or a line inside a JSDoc block. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/**
 * Drop whole comment LINES, and nothing else.
 *
 * A text scanner reads prose as code unless told otherwise, and this file's own comments
 * discuss `writeFile(...)` and the gate by name, so the scan flagged the scanner itself.
 *
 * The obvious fix, a real comment tokenizer, was written first and REJECTED after it failed
 * here: this file is full of regex literals, several containing quote characters inside
 * character classes, and a quote-tracking tokenizer desynchronizes on the first one and then
 * misreads every comment after it. That failure is silent and points the wrong way, since a
 * desynchronized tokenizer can swallow REAL code and take the scan quiet with it.
 *
 * Line-based is worse at its job and safe in the direction that matters. It cannot
 * desynchronize, because it never carries state across a line. It cannot hide a line of code,
 * because a line of code does not begin with a comment marker. What it can do is keep a
 * trailing comment after code, and keep a commented-out block whose lines are unprefixed,
 * both of which cost a FALSE POSITIVE and never a miss. Flagging commented-out gate-opening
 * code is a feature: that line is one uncomment away from being real.
 */
export function stripCommentLines(source) {
  return String(source).split('\n').filter((line) => !COMMENT_LINE.test(line)).join('\n');
}

function neighborhood(text, index) {
  return text.slice(Math.max(0, index - WINDOW_BACK), index + WINDOW_FORWARD);
}

function matchesAllowlist(file, allowlist) {
  return allowlist.some((entry) => file === entry.path || file.endsWith(`/${entry.path}`));
}

/** Names imported un-aliased from the owner module, with the laundering routes closed.
 *  A name is disqualified by an `as` binding anywhere in the file (import { opener as
 *  closer } is the obvious plant) and by any local rebinding, because after either the
 *  text no longer proves the call reaches the audited module. */
const OWNER_MODULE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*spend-gate(?:\.js)?['"]/g;

function ownerModuleImports(text) {
  const names = [];
  for (const match of text.matchAll(OWNER_MODULE_IMPORT)) {
    for (const piece of match[1].split(',')) {
      const token = piece.trim();
      if (token && !/\sas\s/.test(token)) names.push(token);
    }
  }
  return names.filter((name) => !new RegExp(`\\bas\\s+${name}\\b`).test(text)
    && !new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`).test(text));
}

/**
 * @param {{path: string, source: string}[]} files
 * @param {{ownerFile?: string, allowlist?: {path: string, reason: string}[]}} options
 * @returns {{path: string, reason: string}[]} offenders, empty when the rule holds
 */
export function gateWriterOffenders(files, { ownerFile = 'spend-gate.js', allowlist = GATE_SCAN_ALLOWLIST } = {}) {
  const offenders = [];
  const flag = (path, reason) => offenders.push({ path, reason });

  for (const { path: file, source } of files) {
    const text = stripCommentLines(source);
    const isOwner = file === ownerFile || file.endsWith(`/${ownerFile}`);
    const blessed = isOwner ? [] : ownerModuleImports(text);
    // Two exclusions from the widened net, each an argument rather than a convenience:
    //  - A DEFINITION is not a call. `function gateWriterOffenders(` and `function
    //    writeBlockedSpendGate(` match the net and write nothing; without this the scanner
    //    flags itself.
    //  - A call to a name imported UN-ALIASED from the owner module is safe by
    //    construction: that module's own writes are fully audited below, so its exported
    //    closer can only write a blocked gate. The exemption dies the moment the text
    //    stops proving what the call reaches - an `as` laundering the name or a local
    //    rebinding disqualifies it (ownerModuleImports enforces both).
    const writes = [...text.matchAll(WRITE_CALL)].filter((match) => {
      if (/function\s+$/.test(text.slice(Math.max(0, match.index - 40), match.index))) return false;
      const identifier = /^[\w$]+/.exec(match[0])?.[0];
      return !(identifier && blessed.includes(identifier));
    });

    // A shell redirection into the gate is a write no file-write regex would see, and it is
    // checked before anything else because it needs no write call at all.
    if (!isOwner && SHELL_GATE_WRITE.test(text)) {
      flag(file, 'a shell command redirects into the gate file');
      continue;
    }
    if (writes.length === 0) continue;

    if (isOwner) {
      // Guilty unless provably blocked, with ONE licensed exception (D-0060): the single
      // owner-action write, recognized by the ownerAction marker in its own payload, which
      // travels into the gate file so the authorization is auditable at rest. A second
      // marked write is flagged: one licence, not a pattern.
      let ownerActionWrites = 0;
      for (const match of writes) {
        const window = neighborhood(text, match.index);
        if (BLOCKED_STATUS_LITERAL.test(window) && !OPEN_STATUS_LITERAL.test(window)) continue;
        if (OWNER_ACTION_LITERAL.test(window)) {
          ownerActionWrites += 1;
          if (ownerActionWrites > 1) {
            flag(file, 'the gate module carries more than one owner-action write; the D-0060 licence covers exactly one');
            break;
          }
          continue;
        }
        flag(file, OPEN_STATUS_LITERAL.test(window)
          ? 'a write in the gate module carries an open-status payload without the owner-action marker'
          : 'a write in the gate module cannot be shown to write a blocked gate');
        break;
      }
      continue;
    }

    const namesGate = GATE_REFERENCE.test(text);
    const allowed = matchesAllowlist(file, allowlist);
    if (namesGate && !allowed) {
      flag(file, `only ${ownerFile} may write the gate file; this module writes files and names the gate, and holds no allowlist entry`);
      continue;
    }
    if (!namesGate) continue;

    // Allowlisted, so the module may name the gate and write files. It still may not write
    // WHERE the gate is named, and it still may not carry an open-status payload into a
    // write: the entry buys distance, not permission.
    let flagged = false;
    for (const match of writes) {
      const window = neighborhood(text, match.index);
      if (GATE_REFERENCE.test(window) || OPEN_STATUS_LITERAL.test(window)) {
        flag(file, `${file} is allowlisted to name the gate, but this write sits where the gate is named`);
        flagged = true;
        break;
      }
    }
    if (flagged) continue;
    // Distance-independent alias check, which is the one case the neighborhood cannot reach:
    // an allowlisted module that binds the gate path near the top of the file and writes to
    // that variable hundreds of lines later.
    const aliases = [...text.matchAll(GATE_PATH_ALIAS)].map((match) => match[1]);
    if (aliases.length && writes.some((match) => aliases.some(
      (alias) => new RegExp(`\\(\\s*${alias}\\b`).test(text.slice(match.index, match.index + WINDOW_FORWARD)),
    ))) {
      flag(file, `${file} is allowlisted to name the gate, but it writes to a variable holding the gate path`);
    }
  }
  return offenders;
}

/** Write a BLOCKED gate. Callable from anywhere through this module: closing is always safe,
 *  and the spend jobs re-block through this in their finally (D-0060). */
export async function writeBlockedSpendGate(file, reason = 'Blocked.') {
  // Corrected 2026-08-29: this comment used to claim the mutation guard's write regex
  // "must SEE this call" - it did not. The call is spelled writeFileNative, and the old
  // closed-list WRITE_CALL required a `(` straight after `writeFile`, so the owner file
  // matched zero writes and the licence audit below never ran. The widened net sees this
  // spelling now, and the blocked-status payload in this window is what licences it.
  await writeFileNative(file, `${JSON.stringify({ status: 'blocked', reason }, null, 2)}\n`, 'utf8');
  return readSpendGate({ file });
}

/**
 * THE ONE OPENING WRITE (D-0060). Only ever reached from spendGateSet, which sits behind an
 * explicit owner button press, a written reason, and recorded consent. The ownerAction
 * marker below is load-bearing twice: the mutation guard licenses exactly this write by it,
 * and it lands in the gate file so the authorization is auditable at rest.
 */
export async function ownerAuthorizeSpendGate(file, { scope, reason }) {
  if (!GYM_SPEND_SCOPES.includes(scope)) throw new Error(`Unknown gym spend scope: ${scope ?? '<missing>'}`);
  const written = String(reason || '').trim();
  if (written.length < 20) throw new Error('Opening a spend gate needs a written reason of at least 20 characters.');
  await writeFileNative(file, `${JSON.stringify({
    status: 'authorized',
    scope,
    reason: written,
    ownerAction: 'OWNER-ACTION GATE WRITE (D-0060)',
  }, null, 2)}\n`, 'utf8');
  return readSpendGate({ file });
}
