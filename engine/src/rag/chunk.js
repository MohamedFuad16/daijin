// Type aware chunking. Copied from the platform (platform/ingest/chunk.js); the only
// change is that the two type sets and the window policy are injected rather than being
// literals in a default parameter, per the extraction report's portability note (2a).
import { tokens } from './tokens.js';
import { ATOMIC_TYPES, WINDOWED_TYPES } from './types.js';

// The document-identity chunk's reserved ordinal. Multi window documents lose their
// whole document meaning at embedding time: each window is one narrow section, so no
// window resembles the document itself, which is the chunk dilution failure the
// 2026-08-14 aggregation experiment isolated (every window semantically weak; a support
// bonus fixed nothing and broke g007). The identity chunk is a deterministic document
// level index card (title, tags, each section's breadcrumb and first sentence) embedded
// like any chunk so the DOCUMENT can win retrieval, but retrieval only: the query path
// substitutes real chunk content for ordinal -1, so this text is a ranking beacon and
// never engineer context. No LLM, no paid call.
export const IDENTITY_ORDINAL = -1;

export const DEFAULT_WINDOW_POLICY = Object.freeze({ target: 700, overlap: 80, threshold: 800 });

function headingSections(body, title) {
  const headings = [];
  const stack = [];
  let current = { breadcrumb: title, text: '' };
  for (const line of body.split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      if (current.text.trim()) headings.push(current);
      const level = match[1].length;
      stack.length = level - 1;
      stack[level - 1] = match[2].trim();
      current = { breadcrumb: [title, ...stack.filter(Boolean)].join(' > '), text: `${line}\n` };
    } else {
      current.text += `${line}\n`;
    }
  }
  if (current.text.trim()) headings.push(current);
  return headings;
}

function tokenWindows(text, policy = DEFAULT_WINDOW_POLICY) {
  const { target, overlap, threshold } = policy;
  const words = tokens(text);
  if (words.length <= threshold) return [text.trim()];
  const windows = [];
  for (let start = 0; start < words.length; start += target - overlap) {
    windows.push(words.slice(start, start + target).join(' '));
    if (start + target >= words.length) break;
  }
  return windows;
}

// The card's per section sentence must carry MEANING, not identifiers: g024's card led
// with "Project `resume-841f9`." and a code fence path listing, so the query's actual
// concepts (where user data lives, who reads it) never reached the embedding. Fenced code
// is stripped before sentence selection, and a lead sentence that is identifier noise
// (under four words, or mostly backticked) yields to the first prose sentence after it.
function firstSentence(text) {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ');
  const flattened = withoutCode.replace(/^#{1,6} .*$/gm, ' ').replace(/\s+/g, ' ').trim();
  const sentences = flattened.match(/[^.!?]*[.!?](?=\s|$)/g) || (flattened ? [flattened] : []);
  const meaningful = (sentence) => {
    const words = sentence.trim().split(/\s+/);
    if (words.length < 4) return false;
    const backticked = sentence.match(/`[^`]*`/g)?.join('').length || 0;
    return backticked / sentence.length < 0.5;
  };
  const chosen = sentences.find(meaningful) || sentences[0] || '';
  return chosen.trim();
}

export function identityChunk(document, sections) {
  const lines = [document.title.trim()];
  const tags = (document.tags || []).filter(Boolean);
  if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
  for (const section of sections) {
    const sentence = firstSentence(section.text);
    if (sentence) lines.push(`${section.breadcrumb}: ${sentence}`);
  }
  return { ordinal: IDENTITY_ORDINAL, content: lines.join('\n') };
}

export function chunkDocument(document, policy = {}) {
  const atomicTypes = policy.atomicTypes || ATOMIC_TYPES;
  const windowedTypes = policy.windowedTypes || WINDOWED_TYPES;
  const windowPolicy = policy.window || DEFAULT_WINDOW_POLICY;
  if (atomicTypes.has(document.type)) return [{ ordinal: 0, content: document.content }];
  if (!windowedTypes.has(document.type)) {
    throw new Error(`${document.path}: unsupported document type ${document.type}.`);
  }

  const sections = headingSections(document.body, document.title);
  const chunks = [];
  for (const section of sections) {
    for (const window of tokenWindows(section.text, windowPolicy)) {
      chunks.push({
        ordinal: chunks.length,
        content: `Breadcrumb: ${section.breadcrumb}\n\n${window}`,
      });
    }
  }
  if (chunks.length === 0) chunks.push({ ordinal: 0, content: `Breadcrumb: ${document.title}\n\n${document.body}` });
  // Single window documents already ARE their own identity; only genuinely multi chunk
  // documents get the beacon.
  if (chunks.length > 1) chunks.push(identityChunk(document, sections));
  return chunks;
}

export const chunkPolicy = { atomicTypes: ATOMIC_TYPES, windowedTypes: WINDOWED_TYPES, window: DEFAULT_WINDOW_POLICY };
export { tokens };
