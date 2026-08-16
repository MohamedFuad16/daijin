// P3.5: adopt an existing knowledge folder as-is, deterministically.
//
// The plan's init pipeline offers a repo with a curated folder two paths: "ingest an
// existing agent folder as-is, or generate". Generation is Layer 1 (scaffold.js). This is
// the other path, and it is the DETERMINISTIC HALF only: read what a human wrote, split it
// the way it was written, type it by the convention it follows, and index it. The auditor's
// drift check (sampled claim validation against the current code) is LLM work and stays
// behind the spend boundary; nothing here narrates, summarises or rewrites.
//
// The one real design decision is GRANULARITY, and it is the reason this file exists rather
// than a loop that indexes each file whole. A curated folder is not a set of documents, it
// is a set of RECORDS that happen to share files: decisions.md holds 58 ADRs, errors.md
// holds a bullet per lesson. Indexed whole, decisions.md is a single 110 KB unit that wins
// or loses retrieval as a block and cannot fit any token budget. Split on its own record
// boundaries, it is 58 units of roughly the size the platform's curated brain uses.
//
// So the split rule is mechanical, declared, and REPORTED per file, because a granularity
// decision made silently would be indistinguishable from a bug when the numbers come out:
//
//   headings  three or more level-2 headings: one unit per section
//   bullets   no headings but three or more top-level bullet blocks: one unit per bullet
//   whole     anything else stays as it is
//
// Adopted units are marked `generated: false`. They are the only units in a Daijin brain a
// human wrote, and a reader who cannot tell them from machine output has lost the thing
// that makes them worth more.
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ALLOWED_TYPE_SET } from '../rag/types.js';
import { compareStrings, readTextFile } from './walk.js';

export const ADOPT_GENERATOR = 'daijin-adopt';

/** A file needs at least this many records before it is treated as a record file. */
export const SPLIT_MINIMUM_RECORDS = 3;

/**
 * Filename to unit type, following the agent-folder convention the platform's own
 * knowledge base uses. A folder that does not follow it still adopts; unknown files take
 * the windowed default rather than being dropped, because dropping a human's document
 * because it was named unexpectedly is the worst available outcome.
 */
export const TYPE_BY_STEM = Object.freeze({
  decisions: 'decision',
  decision: 'decision',
  errors: 'lesson',
  lessons: 'lesson',
  conventions: 'convention',
  principles: 'principle',
  exemplars: 'exemplar',
  patterns: 'exemplar',
  architecture: 'architecture',
  components: 'architecture',
  data: 'architecture',
  setup: 'architecture',
  graph: 'architecture',
  state: 'workflow',
  tests: 'workflow',
  workflow: 'workflow',
  agent: 'architecture',
});

export const DEFAULT_ADOPTED_TYPE = 'architecture';

export function typeForDocument(file) {
  const stem = path.basename(file).replace(/\.mdx?$/i, '').toLowerCase();
  const inferred = TYPE_BY_STEM[stem] ?? DEFAULT_ADOPTED_TYPE;
  return ALLOWED_TYPE_SET.has(inferred) ? inferred : DEFAULT_ADOPTED_TYPE;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Split a document into records, and say which rule fired.
 *
 * Returns { rule, records: [{ title, body }] }. The title of a heading record is its
 * heading text; a bullet record takes its first sentence, because a bullet has no title and
 * inventing one would be narration.
 */
export function splitRecords(content, { minimum = SPLIT_MINIMUM_RECORDS } = {}) {
  const lines = content.split('\n');
  const headingIndexes = lines
    .map((line, index) => (/^##\s+\S/.test(line) ? index : -1))
    .filter((index) => index !== -1);

  if (headingIndexes.length >= minimum) {
    const records = headingIndexes.map((start, position) => {
      const end = headingIndexes[position + 1] ?? lines.length;
      const title = lines[start].replace(/^##\s+/, '').trim();
      return { title, body: lines.slice(start, end).join('\n').trim() };
    });
    // Anything before the first heading is a PREAMBLE and it is a record too. Dropping it
    // silently loses real content: in the P3.5 target it was decisions.md's ADR index, 58
    // rows of title and status that no other record carries.
    const preamble = lines.slice(0, headingIndexes[0]).join('\n').trim();
    if (preamble) {
      const heading = preamble.match(/^#\s+(.+)$/m)?.[1]?.trim();
      records.unshift({ title: heading ? `${heading} (overview)` : 'Overview', body: preamble, preamble: true });
    }
    return { rule: 'headings', records: records.filter((record) => record.body) };
  }

  // A top-level bullet plus its indented continuation lines is one record. This is how a
  // hand-written errors.md is actually shaped: no headings, one bullet per lesson.
  const bulletStarts = lines
    .map((line, index) => (/^[-*]\s+\S/.test(line) ? index : -1))
    .filter((index) => index !== -1);
  if (bulletStarts.length >= minimum) {
    const records = bulletStarts.map((start, position) => {
      const end = bulletStarts[position + 1] ?? lines.length;
      const body = lines.slice(start, end).join('\n').trim();
      const flattened = body.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
      const sentence = flattened.match(/^[^.!?]*[.!?]/)?.[0] ?? flattened;
      return { title: sentence.slice(0, 100).trim(), body };
    });
    // Same rule for a bullet file: the lead-in before the first bullet is a record.
    const preamble = lines.slice(0, bulletStarts[0]).join('\n').trim();
    if (preamble) {
      const heading = preamble.match(/^#\s+(.+)$/m)?.[1]?.trim();
      records.unshift({ title: heading ? `${heading} (overview)` : 'Overview', body: preamble, preamble: true });
    }
    return { rule: 'bullets', records: records.filter((record) => record.body) };
  }

  return { rule: 'whole', records: [] };
}

/**
 * Turn one curated file into units.
 *
 * `namespace` keeps adopted ids separate from generated ones so a brain that has been both
 * generated and adopted cannot collide, and so a reader can tell the provenance from the id
 * alone.
 */
export function adoptDocument({ file, content, namespace = 'adopted' }) {
  const type = typeForDocument(file);
  const stem = slugify(path.basename(file).replace(/\.mdx?$/i, ''));
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file);
  const { rule, records } = splitRecords(content);

  const build = ({ id, unitTitle, body, sectionTitle, preamble = false }) => {
    const unitContent = body;
    return {
      id,
      type,
      path: file,
      title: unitTitle,
      tags: ['adopted', stem, type],
      body: unitContent.replace(/^#{1,6}\s+.*\n?/, '').trim() || unitContent,
      content: unitContent,
      contentHash: sha256(unitContent),
      // The whole record is the core: a curated record cut in half has lost the claim it
      // was written to make, and unlike a generated card there is no claim line to keep.
      core: unitContent.split('\n').slice(0, 3).join('\n'),
      citations: [file],
      meta: {
        area: stem,
        // The distinction that matters most in a mixed brain: a human wrote this.
        generated: false,
        adopted: true,
        generator: ADOPT_GENERATOR,
        layer: 0,
        sourceFile: file,
        ...(sectionTitle ? { section: sectionTitle } : {}),
        ...(preamble ? { preamble: true } : {}),
        splitRule: rule,
        citations: [file],
      },
    };
  };

  if (rule === 'whole') {
    return { rule, units: [build({ id: `${namespace}.${type}.${stem}`, unitTitle: title, body: content })] };
  }

  const seen = new Map();
  const units = records.map((record, index) => {
    // Ids come from the record's own title, with a positional suffix ONLY on collision, so
    // a stable document keeps stable ids across adoptions.
    let key = slugify(record.title);
    if (seen.has(key)) {
      const next = seen.get(key) + 1;
      seen.set(key, next);
      key = `${key}-${next}`;
    } else {
      seen.set(key, 1);
    }
    return build({
      id: `${namespace}.${type}.${stem}.${key || index}`,
      unitTitle: record.title || `${title} (${index + 1})`,
      body: record.body,
      sectionTitle: record.title,
      preamble: Boolean(record.preamble),
    });
  });
  return { rule, units };
}

/**
 * Adopt every markdown document in the detected knowledge folder.
 *
 * @returns {Promise<{ units, files, granularity, notes }>}
 */
export async function adoptKnowledgeFolder(repoPath, {
  directory,
  files = [],
  namespace = 'adopted',
  maxFiles = 500,
} = {}) {
  if (!directory) throw new Error('adoptKnowledgeFolder needs the detected knowledge folder directory.');
  const prefix = `${directory}/`;
  const markdown = files
    .filter((file) => file.startsWith(prefix) && /\.mdx?$/i.test(file))
    .sort(compareStrings)
    .slice(0, maxFiles);

  const units = [];
  const perFile = [];
  const notes = [];
  for (const file of markdown) {
    const content = await readTextFile(repoPath, file);
    if (!content?.trim()) {
      notes.push(`${file}: unreadable or empty, adopted as nothing.`);
      continue;
    }
    const adopted = adoptDocument({ file, content, namespace });
    units.push(...adopted.units);
    perFile.push({ file, rule: adopted.rule, units: adopted.units.length, bytes: content.length });
  }

  if (units.length === 0) notes.push(`No markdown adopted from ${directory}.`);
  return {
    units,
    files: perFile,
    // The granularity outcome, reported because it is the axis the curated-versus-generated
    // comparison turns on and because a silent split is indistinguishable from a bug.
    granularity: {
      documents: perFile.length,
      units: units.length,
      byRule: perFile.reduce((totals, entry) => {
        totals[entry.rule] = (totals[entry.rule] || 0) + 1;
        return totals;
      }, {}),
    },
    notes,
  };
}
