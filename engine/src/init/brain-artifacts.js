// D-0031 invariant 3: THE BRAIN IS DURABLE MARKDOWN, THE DB IS DERIVED.
//
// Layer 1 used to hand units straight to the store, which made the index the only place the
// brain existed. Corrected: the scaffold writes .daijin/brain/ as canonical, human-readable
// artifacts, ingest READS those files, and the index is regenerable from them at any time.
// Delete the index and the project keeps its memory.
//
// Two properties decide the format.
//
// SELF-DESCRIBING. Each file states its own schema and each record carries its own id,
// type, area and citations. Nothing outside the file is needed to read it correctly. A
// schema that lived only in the manifest would make a hand-copied or partially restored
// brain directory unreadable, or worse, silently misread under the wrong rules; and the
// index being regenerable from these files only holds if the files are sufficient alone.
//
// HUMAN-FIRST. The metadata rides in an HTML comment, which markdown renderers hide, so
// what a person opens is prose with headings and what the reader parses is exact. The
// alternative, a metadata block per record, puts machine bookkeeping in front of the
// content on every screen, and these files are meant to be read.
//
// The record layout follows the convention a curated agent folder already uses, one `##`
// section per record, which is not a coincidence worth hiding: it means adopt.js and this
// module produce the same shape, and a generated brain can be hand-edited into a curated
// one without a format migration.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { compareStrings } from './walk.js';

/** Bumped when the on-disk shape changes in a way an older reader would misread. */
export const BRAIN_SCHEMA = 1;

/**
 * Which file a unit type is written to. Directories hold one record per file because those
 * types accumulate one record at a time and a user edits them individually; single files
 * hold record sections because those are read top to bottom.
 *
 * errors.md is listed even though Layer 1 writes nothing into it. That is deliberate: the
 * file exists and is EMPTY, which is the honest artifact of the rule that errors.md starts
 * empty and the gym writes the first real entry. An absent file would read as "not
 * implemented yet" rather than as "nothing has been learned yet".
 */
export const ARTIFACT_LAYOUT = Object.freeze({
  architecture: { file: 'architecture.md', title: 'Architecture' },
  convention: { file: 'conventions.md', title: 'Conventions' },
  workflow: { file: 'workflow.md', title: 'Workflow' },
  principle: { file: 'principles.md', title: 'Principles' },
  lesson: { directory: 'lessons', title: 'Lessons', alsoEmptyFile: 'errors.md' },
  decision: { directory: 'decisions', title: 'Decisions' },
  exemplar: { directory: 'exemplars', title: 'Exemplars' },
});

const MARKER = /^<!--\s*daijin\s+(.*?)\s*-->$/;

function encodeAttributes(attributes) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}="${String(value).replaceAll('"', "'")}"`)
    .join(' ');
}

function decodeAttributes(text) {
  const attributes = {};
  for (const match of text.matchAll(/(\w+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  return attributes;
}

/**
 * The comment a renderer hides and the reader trusts.
 *
 * Every attribute here is consumed by something NAMED, which is the test for whether it
 * belongs. Once the index is derived from these files, the gold-set miner reads the
 * round-tripped units too, so a meta field that does not survive silently changes what gets
 * mined: `preamble` is how the miner tells an index from a record, and `splitRule` is how it
 * knows a title was human-authored rather than invented by the splitter. Both were lost in
 * the first version of this format and the miner's behaviour changed without any error.
 */
export function unitMarker(unit, { shift = 0 } = {}) {
  return `<!-- daijin ${encodeAttributes({
    id: unit.id,
    type: unit.type,
    area: unit.meta?.area ?? '',
    layer: unit.meta?.layer ?? '',
    generated: unit.meta?.generated === false ? 'false' : 'true',
    adopted: unit.meta?.adopted ? 'true' : '',
    preamble: unit.meta?.preamble ? 'true' : '',
    split: unit.meta?.splitRule ?? '',
    source: unit.meta?.sourceFile ?? '',
    cites: (unit.citations || []).join(','),
    shift: shift || '',
  })} -->`;
}

function frontMatter({ generator }) {
  return ['---', `daijin-schema: ${BRAIN_SCHEMA}`, `generator: ${generator}`, '---', ''].join('\n');
}

/**
 * Shift a body's headings clear of the record separator, and back.
 *
 * A record is a `##` section and unit bodies carry their own headings, so a body heading must
 * never render at `##`. A FIXED one-level shift is not enough, and real content proved it:
 * portfolio-mine's decisions.md carries an `# Decisions` h1 inside its index section, which a
 * one-level shift turned into `## Decisions`, which the reader then took as a NEW record. The
 * unit was truncated at that line and the remainder became an orphan fragment with no marker.
 *
 * So the shift is computed per record, enough to put the SHALLOWEST body heading at `###`,
 * and it is recorded in the marker so the reader undoes exactly what the writer did rather
 * than guessing. A body whose headings would pass `######` cannot be represented; that is not
 * silently clipped, it is left to fail the round-trip check, which refuses the run.
 */
export function headingShiftFor(body) {
  const levels = [...String(body).matchAll(/^(#{1,6})\s/gm)].map((match) => match[1].length);
  if (levels.length === 0) return 0;
  return Math.max(0, 3 - Math.min(...levels));
}

export function demoteHeadings(body, shift) {
  if (!shift) return body;
  return body.replace(/^(#{1,6})\s/gm, (match, hashes) => `${'#'.repeat(hashes.length + shift)} `);
}

export function promoteHeadings(body, shift) {
  if (!shift) return body;
  return body.replace(/^(#{1,6})\s/gm, (match, hashes) => `${'#'.repeat(Math.max(1, hashes.length - shift))} `);
}

/** A unit as one markdown record: heading, hidden marker, body. */
export function renderUnit(unit) {
  const heading = `## ${unit.title}`;
  const raw = String(unit.content).replace(/^#\s+.*\n?/, '').trim();
  const shift = headingShiftFor(raw);
  return `${heading}\n\n${unitMarker(unit, { shift })}\n\n${demoteHeadings(raw, shift)}`;
}

function slugForFile(id) {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100);
}

/**
 * Write the brain. Returns what was written, so the caller can report it rather than
 * assume it.
 *
 * The directory is REPLACED, not merged: a stale record left behind by a previous run would
 * be indexed on the next ingest and would outlive the evidence that produced it, which is
 * the orphan problem the atomic prune solves on the store side. Same rule, other tree.
 */
export async function writeBrainArtifacts(brainRoot, units, { generator = 'daijin-layer1' } = {}) {
  await rm(brainRoot, { recursive: true, force: true });
  await mkdir(brainRoot, { recursive: true });

  const byType = new Map();
  for (const unit of units) {
    const list = byType.get(unit.type) || [];
    list.push(unit);
    byType.set(unit.type, list);
  }

  const written = [];
  for (const [type, layout] of Object.entries(ARTIFACT_LAYOUT)) {
    const group = (byType.get(type) || []).slice().sort((left, right) => compareStrings(left.id, right.id));

    if (layout.directory) {
      if (group.length > 0) await mkdir(path.join(brainRoot, layout.directory), { recursive: true });
      for (const unit of group) {
        const file = path.join(layout.directory, `${slugForFile(unit.id)}.md`);
        await writeFile(
          path.join(brainRoot, file),
          `${frontMatter({ generator })}# ${layout.title}\n\n${renderUnit(unit)}\n`,
        );
        written.push({ file, units: 1, type });
      }
      // The empty file that says nothing has been learned yet, rather than nothing exists.
      if (layout.alsoEmptyFile && group.length === 0) {
        await writeFile(
          path.join(brainRoot, layout.alsoEmptyFile),
          `${frontMatter({ generator })}# ${layout.title}\n\n`
          + 'No entries. Layer 1 writes no error records: a lesson enters the brain after it is\n'
          + 'validated against a real commit, or after the gym earns it. This file being empty is a\n'
          + 'measurement, not a gap.\n',
        );
        written.push({ file: layout.alsoEmptyFile, units: 0, type });
      }
      continue;
    }

    if (group.length === 0) continue;
    const body = group.map(renderUnit).join('\n\n');
    await writeFile(
      path.join(brainRoot, layout.file),
      `${frontMatter({ generator })}# ${layout.title}\n\n${body}\n`,
    );
    written.push({ file: layout.file, units: group.length, type });
  }

  const unknown = [...byType.keys()].filter((type) => !ARTIFACT_LAYOUT[type]);
  return { written, units: units.length, unknownTypes: unknown };
}

/** Parse one artifact file back into units. */
export function parseBrainFile(text, { file }) {
  const schema = Number(text.match(/^daijin-schema:\s*(\d+)\s*$/m)?.[1] ?? 0);
  const lines = text.split('\n');
  const starts = lines
    .map((line, index) => (/^##\s+\S/.test(line) ? index : -1))
    .filter((index) => index !== -1);

  const units = [];
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1] ?? lines.length;
    const block = lines.slice(start, end);
    const title = block[0].replace(/^##\s+/, '').trim();
    const markerLine = block.find((line) => MARKER.test(line.trim()));
    if (!markerLine) continue;
    const attributes = decodeAttributes(MARKER.exec(markerLine.trim())[1]);
    const body = promoteHeadings(
      block
        .slice(1)
        .filter((line) => !MARKER.test(line.trim()))
        .join('\n')
        .trim(),
      Number(attributes.shift || 0),
    );
    const citations = attributes.cites ? attributes.cites.split(',').filter(Boolean) : [];
    units.push({
      id: attributes.id,
      type: attributes.type,
      path: `${file}#${attributes.id}`,
      title,
      tags: [attributes.type, attributes.area].filter(Boolean),
      content: `# ${title}\n\n${body}`,
      body,
      citations,
      meta: {
        area: attributes.area || null,
        generated: attributes.generated !== 'false',
        layer: attributes.layer ? Number(attributes.layer) : null,
        ...(attributes.adopted === 'true' ? { adopted: true } : {}),
        ...(attributes.preamble === 'true' ? { preamble: true } : {}),
        ...(attributes.split ? { splitRule: attributes.split } : {}),
        ...(attributes.source ? { sourceFile: attributes.source } : {}),
        citations,
        sourceArtifact: file,
        schema,
      },
    });
  }
  return { schema, units };
}

/**
 * Read the whole brain back.
 *
 * This is what ingest consumes, so the index is provably derived from the files rather than
 * from whatever the generator happened to hold in memory. A round trip that lost a field
 * would show up here as a unit that no longer matches its gold-set answer.
 */
export async function readBrainArtifacts(brainRoot) {
  let entries;
  try {
    entries = await readdir(brainRoot, { withFileTypes: true, recursive: true });
  } catch {
    return { units: [], files: [], schema: null, present: false };
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.relative(brainRoot, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort(compareStrings);

  const units = [];
  const read = [];
  let schema = null;
  for (const file of files) {
    const text = await readFile(path.join(brainRoot, file), 'utf8');
    const parsed = parseBrainFile(text, { file });
    if (schema === null && parsed.schema) schema = parsed.schema;
    units.push(...parsed.units);
    read.push({ file, units: parsed.units.length, schema: parsed.schema });
  }
  return { units, files: read, schema, present: true };
}
