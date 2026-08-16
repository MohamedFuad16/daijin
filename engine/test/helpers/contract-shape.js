// Read a method's DOCUMENTED shape out of methods.md, so a test can compare what the
// engine emits against what the contract says rather than against a list copied by hand.
//
// D-0035's instrument, first installment. The defect it exists for is not any one
// divergence but the class: the contract is a document that no test executes. In one day
// this build found `repoPath` absent from it, `ungradedCode` absent from it, `attempts`
// disagreeing with it, and a terminal event missing from both. Each was found by a human
// meeting real data. A comparison that runs cannot be told a plausible story.
//
// A duplicated key list in a test is NOT this. It asserts that the engine matches the test,
// which is true by construction the moment someone updates both together; the contract is
// the document a client author reads, so the contract has to be the authority.
//
// WHAT IT PARSES, stated because a parser with an unstated scope is its own kind of lie:
// the returns cell of a method's table row, up to the first bracketed prose addition. Shape
// text is `{ a, b, c }` with optional `name: [{ ... }]` for a list of objects. Prose
// additions in square brackets are ignored deliberately: they carry the reasoning and the
// dated amendments, and parsing English is how a gate starts producing confident nonsense.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const METHODS_MD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'rpc', 'methods.md');

/// The raw returns cell for one method, or null when the method has no table row.
export async function contractRow(method, { file = METHODS_MD } = {}) {
  const text = await readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells[1] !== `\`${method}\``) continue;
    return cells[3] ?? null;
  }
  return null;
}

/// Strip the prose additions, which open with a dated marker.
///
/// NOT "cut at the first `[`": a shape can legitimately contain one, and
/// `attempts: [{ ... }]` is exactly that. Cutting there silently truncated the shape and
/// the parser returned null for a field that was documented, which is the failure mode a
/// gate can least afford, since null reads as "not documented" and would have excused the
/// very divergence this is built to catch.
function shapeTextOf(cell) {
  const note = cell.search(/\[(Amended|Addition|Added|added|Corrected|corrected)\b/);
  return (note === -1 ? cell : cell.slice(0, note)).trim();
}

/**
 * The key names documented for `method`, optionally for a named list-of-objects field.
 *
 * `documentedKeys('examDetail', { field: 'attempts' })` returns the keys inside
 * `attempts: [{ ... }]`. Without a field it returns the top-level keys, and a nested
 * `name: [{...}]` contributes only `name`, which is what a top-level key set means.
 *
 * Returns null when the method or field is not documented, so a caller can tell "the
 * contract says nothing" from "the contract says nothing is there". Those are different
 * facts and a gate that conflated them would pass on a missing row.
 */
export async function documentedKeys(method, { field = null, file = METHODS_MD } = {}) {
  const cell = await contractRow(method, { file });
  if (!cell) return null;
  const shape = shapeTextOf(cell);

  if (field) {
    const match = shape.match(new RegExp(`${field}\\s*:\\s*\\[\\s*\\{([^}]*)\\}`));
    return match ? splitKeys(match[1]) : null;
  }

  const opened = shape.indexOf('{');
  if (opened === -1) return null;
  // Walk to the matching brace so a nested list does not end the top-level shape early.
  let depth = 0;
  let closed = -1;
  for (let index = opened; index < shape.length; index += 1) {
    if (shape[index] === '{') depth += 1;
    if (shape[index] === '}') {
      depth -= 1;
      if (depth === 0) { closed = index; break; }
    }
  }
  if (closed === -1) return null;
  return splitKeys(stripNested(shape.slice(opened + 1, closed)));
}

/// Remove `name: [{ ... }]` bodies so the top level keeps the NAME and drops the members.
function stripNested(text) {
  return text.replace(/:\s*\[[^\]]*\]/g, '').replace(/:\s*\{[^}]*\}/g, '');
}

function splitKeys(text) {
  return text
    .split(',')
    .map((entry) => entry.replace(/`/g, '').split(':')[0].trim())
    .filter((entry) => entry && /^[A-Za-z_][A-Za-z0-9_]*\??$/.test(entry))
    .map((entry) => entry.replace(/\?$/, ''))
    .sort();
}
