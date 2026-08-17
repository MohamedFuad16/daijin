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
    // Split on UNESCAPED pipes only. A cell may legitimately contain `\|`, which is how
    // Markdown carries an alternation like `"layer1+layer2" \| "gym"`, and splitting
    // naively mis-columns the row: budgetEstimate and agentFileGet both returned their
    // PARAMS cell as their returns cell, so the reader reported them as undocumented. A
    // gate that under-covers because of its own parser is worse than no gate, because the
    // uncovered set looks covered.
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (cells[1] !== `\`${method}\``) continue;
    return cells[3] ?? null;
  }
  return null;
}

/**
 * The values a row DOCUMENTS for one enum field, read from the row itself.
 *
 * The other direction of a vocabulary check, and the one my first gate could not do. That
 * gate asserted every value the CODE produces is named in the row, which catches a value a
 * client cannot look up and cannot catch a value the row names that the engine can never
 * produce. Subset is half a vocabulary check wearing the name of a whole one, which
 * tui-builder found in their gate and which mine had in the mirror direction: I named
 * "documented and reachable are different claims" and then shipped an instrument that
 * checked only one of them.
 *
 * It reads all three notations the contract uses for one idea, rather than requiring the
 * document to be rewritten around the parser: backtick-pipe, quote-pipe and comma lists.
 * The scan starts at the field name and stops at the first token that is not part of a
 * list, so the prose that follows an enum is not swept in.
 */
export function documentedEnum(row, field) {
  if (!row) return null;
  const token = '(?:`[a-z0-9+.-]+`|"[a-z0-9+.-]+")';
  const separator = '(?:\\s*\\\\?\\|\\s*|,\\s+|\\s+or\\s+)';
  // EVERY occurrence of the field name, not the first. A row explains its fields in prose
  // as well as declaring them, so the first mention is often a sentence about the field
  // rather than its vocabulary: `classification` appears in gatesGet's amendment history
  // long before the list. Anchoring on the first match read the wrong part of the row and
  // returned null, which would have reported a documented enum as undocumented.
  for (const anchor of row.matchAll(new RegExp(`\`${field}\`|\\b${field}:`, 'g'))) {
    const tail = row.slice(anchor.index + anchor[0].length);
    const run = new RegExp(`^.{0,40}?(${token}(?:${separator}${token})+)`).exec(tail);
    if (!run) continue;
    return [...run[1].matchAll(/`([a-z0-9+.-]+)`|"([a-z0-9+.-]+)"/g)]
      .map((match) => match[1] ?? match[2]).sort();
  }
  return null;
}

/**
 * The WHOLE row for a method, params and returns together.
 *
 * `contractRow` returns the returns cell, which is the right scope for a shape. It is the
 * wrong scope for a VOCABULARY: `initBrain`'s modes are named in the params cell, and an
 * enum check reading only the returns cell reported them missing when a reader would find
 * them immediately. The question an enum check asks is whether the contract names the value
 * where someone reading the method would see it, and the row is that place.
 */
export async function contractLine(method, { file = METHODS_MD } = {}) {
  const text = await readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (cells[1] === `\`${method}\``) return line;
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
    const body = nestedBody(shape, field);
    return body === null ? null : splitKeys(stripNested(body));
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

/**
 * The span from `open` to its MATCHING close, counting depth.
 *
 * The one bracket walker, shared. Both readers in this file used their own shallow regex
 * (`[^\]]*` in the strip, `[^}]*` in the field reader) and BOTH broke on the same input for
 * the same reason: a nested list ends at the first closing bracket, which belongs to the
 * inner list rather than the outer one. Two expressions of one rule in two places is how a
 * fix at one site leaves the other broken, so the rule lives here now.
 */
function balancedEnd(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === '[' || character === '{') depth += 1;
    if (character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/// The members of `field: [{ ... }]` or `field: { ... }`, or null when it is not documented.
function nestedBody(shape, field) {
  const marker = new RegExp(`\\b${field}\\s*:\\s*`).exec(shape);
  if (!marker) return null;
  let open = marker.index + marker[0].length;
  if (shape[open] === '[') {
    const listEnd = balancedEnd(shape, open);
    if (listEnd === -1) return null;
    open = shape.indexOf('{', open);
    if (open === -1 || open > listEnd) return null;
  }
  if (shape[open] !== '{') return null;
  const end = balancedEnd(shape, open);
  return end === -1 ? null : shape.slice(open + 1, end);
}

/// Remove `name: [{ ... }]` bodies so the top level keeps the NAME and drops the members.
///
/// DEPTH AWARE, and it was not before. The old version matched `:\s*\[[^\]]*\]`, which stops
/// at the FIRST closing bracket, so a shape nesting a list inside a list left a dangling
/// ` }]` glued to the following key. That key then failed the identifier test in
/// splitEntries and was DROPPED FROM THE DOCUMENTED SET ENTIRELY, so the gate compared the
/// engine against a contract it had silently mis-parsed and reported the missing key as an
/// ENGINE EXTRA. A gate that quietly narrows what it checks is the failure this suite
/// exists to prevent, so the walk below counts brackets and braces instead.
function stripNested(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character !== ':') { out += character; index += 1; continue; }
    // A colon opens a nested body only if the next non-space character opens one.
    let scan = index + 1;
    while (scan < text.length && /\s/.test(text[scan])) scan += 1;
    if (text[scan] !== '[' && text[scan] !== '{') { out += character; index += 1; continue; }
    const end = balancedEnd(text, scan);
    index = end === -1 ? text.length : end + 1;
  }
  return out;
}

function splitKeys(text) {
  return splitEntries(text).map((entry) => entry.name).sort();
}

function splitEntries(text) {
  return text
    .split(',')
    .map((entry) => entry.replace(/`/g, '').split(':')[0].trim())
    .filter((entry) => entry && /^[A-Za-z_][A-Za-z0-9_]*\??$/.test(entry))
    .map((entry) => ({ name: entry.replace(/\?$/, ''), optional: entry.endsWith('?') }));
}

/**
 * The documented shape with OPTIONALITY kept, which the names-only reader throws away.
 *
 * `quarantineReason?` is a real thing the contract says: the key is documented and may be
 * absent, because an exam that was never quarantined has no reason. A reader that strips
 * the marker turns every optional field into a divergence, and an exemption list that
 * fills with false entries stops meaning anything, which is the failure this gate exists
 * to prevent one level down.
 */
export async function documentedShape(method, { field = null, file = METHODS_MD, seen = [] } = {}) {
  const cell = await contractRow(method, { file });
  if (!cell) return null;
  const shape = shapeTextOf(cell);

  // A ROW MAY REFERENCE ANOTHER ROW'S SHAPE by name, which is how examVeto and examUpdate
  // say "the updated exam record, in the `examList` row shape" without restating ten keys.
  // Following the reference is what makes that form checkable rather than decorative; a
  // reader that stopped at the reference would leave those rows in the prose bucket, which
  // is the outcome the amendment was meant to end.
  const reference = shape.match(/in the `([a-zA-Z]+)` row shape/);
  if (reference && !field) {
    const target = reference[1];
    // A cycle would otherwise recurse forever, and a row referencing itself is a mistake
    // worth reporting as unreadable rather than hanging the suite.
    if (seen.includes(target) || target === method) return null;
    return documentedShape(target, { file, seen: [...seen, method] });
  }

  let body = null;
  if (field) {
    const match = shape.match(new RegExp(`${field}\\s*:\\s*\\[\\s*\\{([^}]*)\\}`));
    body = match ? match[1] : null;
  } else {
    const opened = shape.indexOf('{');
    if (opened !== -1) {
      let depth = 0;
      for (let index = opened; index < shape.length; index += 1) {
        if (shape[index] === '{') depth += 1;
        if (shape[index] === '}') {
          depth -= 1;
          if (depth === 0) { body = stripNested(shape.slice(opened + 1, index)); break; }
        }
      }
    }
  }
  if (body === null) return null;
  const entries = splitEntries(body);
  return {
    required: entries.filter((entry) => !entry.optional).map((entry) => entry.name).sort(),
    optional: entries.filter((entry) => entry.optional).map((entry) => entry.name).sort(),
  };
}
