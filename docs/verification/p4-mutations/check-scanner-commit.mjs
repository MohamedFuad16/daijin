#!/usr/bin/env node
// Makes the declaration-versus-widening rule (c8267a0) MECHANICAL.
//
// The rule is sound and its enforcement was a person reading a diff. Three instances this
// session had exactly the violating shape and nobody caught them by reading, which is the
// argument: a claim that depends on someone noticing is not a claim anyone should rely on.
//
// The two acts are structurally distinct IN THE BYTES, which is what makes this checkable at
// all rather than a lint over intent:
//
//   DECLARATION  adds a directory to SCANNED in engine/test/gym-spend-gate.test.js. Coverage
//                grows, nothing is excused, the guarantee is strictly stronger.
//   WIDENING     adds an entry to GATE_SCAN_ALLOWLIST in engine/src/gym/spend-gate.js. One
//                file is excused from the ownership rule; the guarantee weakens.
//
// So two properties, each refusing in one direction:
//
//   1. A message CLAIMING a declaration must contain no allowlist addition. The lie this
//      catches is a widening riding inside a commit that says it is strictly stronger.
//   2. An allowlist addition must SAY it is one, and carry a reason specific enough to argue
//      with. The bar is the layout.js entry, which names the module, what it writes, why it
//      names the gate, and what still holds it.
//
// Intended as a commit-msg hook. The leader wires .git/hooks; this supplies only the check.
//   node check-scanner-commit.mjs <message-file> [--staged | --diff <file>]
//   node check-scanner-commit.mjs --self-test
//
// Exit 0 accepts, 1 refuses with the reason on stderr.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const DECLARATION_CLAIM = /scanned-set declaration, strictly stronger/i;
export const WIDENING_CLAIM = /allowlist widening:/i;

/** The reason bar, measured from the ruled standard rather than guessed. The layout.js entry
 *  runs well past this; a one-liner like "needed for tests" does not. */
export const MIN_REASON_LENGTH = 60;

/** An added line that puts a new entry into GATE_SCAN_ALLOWLIST.
 *
 *  Deliberately keyed on `path:` inside an added line of spend-gate.js rather than on the
 *  array name: the entry is added several lines below the name, so a diff hunk containing
 *  the addition usually never mentions GATE_SCAN_ALLOWLIST at all. */
const ALLOWLIST_FILE = 'engine/src/gym/spend-gate.js';
const ADDED_ENTRY = /^\+\s*path:\s*['"`]/;
const ADDED_REASON = /^\+\s*reason:/;

/** Split a unified diff into per-file added-line groups. */
export function addedLinesByFile(diff) {
  const files = new Map();
  let current = null;
  for (const line of String(diff).split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) { current = header[1]; files.set(current, files.get(current) ?? []); continue; }
    if (current && line.startsWith('+') && !line.startsWith('+++')) files.get(current).push(line);
  }
  return files;
}

/** Does this diff add an allowlist entry, and does it carry a reason? */
export function allowlistAdditions(diff) {
  const added = addedLinesByFile(diff).get(ALLOWLIST_FILE) ?? [];
  const entries = added.filter((line) => ADDED_ENTRY.test(line));
  // Reason text is joined because an entry's reason is usually a multi-line concatenation.
  const reasonText = added.filter((line) => ADDED_REASON.test(line) || /^\+\s*\+ '/.test(line))
    .join(' ').replace(/^\+\s*/gm, '');
  return { count: entries.length, entries, reasonText };
}

/**
 * The check. Returns { ok, refusals } rather than throwing, so the self-test can assert on
 * both directions without catching.
 */
export function checkScannerCommit({ message, diff }) {
  const refusals = [];
  const claimsDeclaration = DECLARATION_CLAIM.test(message);
  const claimsWidening = WIDENING_CLAIM.test(message);
  const allowlist = allowlistAdditions(diff);

  // Property 1: a declaration claim must be true.
  if (claimsDeclaration && allowlist.count > 0) {
    refusals.push(
      'This message claims "scanned-set declaration, strictly stronger" but the diff ADDS '
      + `${allowlist.count} entr${allowlist.count === 1 ? 'y' : 'ies'} to GATE_SCAN_ALLOWLIST. `
      + 'A declaration grows coverage and excuses nothing; an allowlist entry excuses a file and '
      + 'weakens the guarantee. They are different acts and the second goes through the leader '
      + 'in a freeze window. Split the commit.',
    );
  }

  // Property 2: a widening must announce itself and justify itself.
  if (allowlist.count > 0 && !claimsWidening) {
    refusals.push(
      `This diff adds ${allowlist.count} allowlist entr${allowlist.count === 1 ? 'y' : 'ies'}, which WEAKENS the `
      + 'gate-writer guarantee, but the message does not say so. Start the subject or body with '
      + '"allowlist widening:" and state why the file may name the gate while writing files.',
    );
  }
  if (allowlist.count > 0 && claimsWidening && allowlist.reasonText.trim().length < MIN_REASON_LENGTH) {
    refusals.push(
      `The allowlist entry's reason is ${allowlist.reasonText.trim().length} characters, below the `
      + `${MIN_REASON_LENGTH} the ruled standard sets. An exemption is a claim someone has to be able `
      + 'to argue with later: name the module, what it writes, why it names the gate, and what still '
      + 'holds it to not writing the gate.',
    );
  }
  return { ok: refusals.length === 0, refusals, claimsDeclaration, claimsWidening, allowlist: allowlist.count };
}

/** Both refusals firing, and an honest declaration passing. A check nobody has watched fail
 *  is not yet a check, and this one guards a rule whose whole point is that reading does not
 *  catch it. */
export function selfTest() {
  const entryDiff = [
    `+++ b/${ALLOWLIST_FILE}`,
    "+  {",
    "+    path: 'newcomer.js',",
    "+    reason: 'It writes files and names the gate.',",
    "+  },",
  ].join('\n');
  const goodReason = [
    `+++ b/${ALLOWLIST_FILE}`,
    "+  {",
    "+    path: 'layout.js',",
    "+    reason: 'The state-layout module DEFINES where the gate lives, so it necessarily names '",
    "+      + 'it, and it writes manifest.json and origin.json. It never writes the gate itself, '",
    "+      + 'and the near-write rule still holds it to that.',",
    "+  },",
  ].join('\n');
  const declarationDiff = [
    '+++ b/engine/test/gym-spend-gate.test.js',
    "+export const SCANNED = ['gym', 'newcomer', 'roles', 'rpc', 'state'];",
  ].join('\n');

  const cases = [
    ['a widening hiding inside a declaration claim', {
      message: 'gym: declare src/newcomer\n\nscanned-set declaration, strictly stronger',
      diff: entryDiff,
    }, false, /claims "scanned-set declaration/],
    ['a widening that does not announce itself', {
      message: 'gym: let layout.js through the scanner',
      diff: goodReason,
    }, false, /does not say so/],
    ['a widening whose reason is too thin to argue with', {
      message: 'allowlist widening: newcomer.js',
      diff: entryDiff,
    }, false, /below the 60 the ruled standard sets/],
    ['an honest declaration', {
      message: 'init: add src/newcomer\n\nscanned-set declaration, strictly stronger',
      diff: declarationDiff,
    }, true, null],
    ['an honest widening with the ruled reason', {
      message: 'allowlist widening: layout.js defines the gate path\n\nIt writes manifest files.',
      diff: goodReason,
    }, true, null],
    ['an ordinary commit touching neither', {
      message: 'gym: rename a variable',
      diff: '+++ b/engine/src/gym/budget.js\n+const renamed = 1;',
    }, true, null],
  ];

  let failures = 0;
  for (const [name, input, expectOk, expectMatch] of cases) {
    const result = checkScannerCommit(input);
    const matched = expectMatch ? result.refusals.some((reason) => expectMatch.test(reason)) : true;
    const pass = result.ok === expectOk && matched;
    if (!pass) failures += 1;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${result.ok ? '' : `  ->  ${result.refusals[0].slice(0, 60)}...`}`);
  }
  console.log(failures === 0 ? '\nself-test PASSED: both refusals fire and honest commits pass.' : `\nself-test FAILED: ${failures}`);
  return failures === 0;
}

function currentDiff(argv) {
  const explicit = argv.indexOf('--diff');
  if (explicit !== -1) return readFileSync(argv[explicit + 1], 'utf8');
  return execFileSync('git', ['diff', '--cached', '--unified=0'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1;
} else if (process.argv[2]) {
  const message = readFileSync(process.argv[2], 'utf8');
  const result = checkScannerCommit({ message, diff: currentDiff(process.argv) });
  if (!result.ok) {
    console.error('\nCOMMIT REFUSED by the scanner governance check (ruling c8267a0):\n');
    for (const refusal of result.refusals) console.error(`  ${refusal}\n`);
    process.exitCode = 1;
  }
}
