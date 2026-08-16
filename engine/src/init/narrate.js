// Layer 2 seam: evidence tables in, prose units out, with the provider call stubbed.
//
// This file exists so the shape of the spend boundary is CODE rather than a plan bullet,
// and so P3 can be finished and measured without a key. What is built here:
//
//   the seam        narrationInputs() turns the deterministic evidence into the exact
//                   tables a narrator is allowed to see, and acceptNarration() validates
//                   what comes back. Both are pure and fully tested.
//   the refusal     narrate() with no injected narrator, or with the spend gate closed,
//                   or with no per-call budget confirmation, REFUSES. Refusal is the
//                   default path, not an error path.
//
// What is deliberately NOT built here: any code that talks to a provider. RPC v4 lists
// `initBrain` with mode `layer1+layer2` among exactly four spend-touching methods, and
// D-0010's ruling is that adding a spend path is a contract change rather than an
// implementation detail. When the narrator lands it is injected through this same seam.
//
// The rule the narrator serves under, from the plan: "THE LLM PROPOSES, MECHANICS ACCEPT:
// cited paths and commits must exist or the unit is dropped." acceptNarration enforces it
// and cannot be bypassed by the narrator, because the narrator never touches the store.
import { validateCitations } from './scaffold.js';
import { ALLOWED_TYPE_SET } from '../rag/types.js';

/** JSON-RPC code for a spend-gated refusal (methods.md, error convention). */
export const SPEND_REFUSED_CODE = -32050;

export class SpendRefusedError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.name = 'SpendRefusedError';
    this.code = SPEND_REFUSED_CODE;
    this.data = { hint: message, ...data };
  }
}

/** Types Layer 2 is allowed to author. Layer 1 authors none of them. */
export const NARRATABLE_TYPES = Object.freeze(['decision', 'lesson', 'exemplar', 'principle']);

/**
 * The evidence a narrator sees.
 *
 * Scoped on purpose: a narrator handed the whole repo would rediscover facts, and the
 * plan's line is that "the LLM never discovers facts, it narrates verified ones". So the
 * inputs are tables, each row already measured, and the narrator's only job is prose over
 * rows it did not choose.
 */
export function narrationInputs(evidence, { areas = null, maxRows = 40 } = {}) {
  const wanted = areas?.length ? new Set(areas) : null;
  return {
    repo: { name: evidence.name, files: evidence.files, languages: evidence.languages.slice(0, 10) },
    areas: evidence.areas
      .filter((area) => !wanted || wanted.has(area.area))
      .slice(0, maxRows)
      .map((area) => ({
        area: area.area, fileCount: area.fileCount, files: area.files.slice(0, 20),
        importsOut: area.importsOut, importedBy: area.importedBy, commits: area.commits,
      })),
    dependencies: evidence.dependencies,
    conventions: evidence.conventions,
    // The candidate lessons: fix and revert commits, each with its real sha, so every
    // proposal can be validated against the commit it claims to come from.
    repairCandidates: {
      fixCommits: (evidence.history.fixCommits || []).slice(0, maxRows),
      revertCommits: (evidence.history.revertCommits || []).slice(0, maxRows),
    },
    coChange: (evidence.history.coChange || []).slice(0, maxRows),
  };
}

/**
 * Accept or drop what a narrator proposed.
 *
 * Three mechanical checks, in order, each of which drops rather than repairs:
 *   shape        a unit must carry an id, a narratable type, a title and content
 *   citations    every cited path must exist in the tree and every cited sha in the log
 *   grounding    the unit must cite at least one thing; an uncited claim is prose, not
 *                knowledge, and the brain is not a place for prose
 */
export function acceptNarration(proposed, { files = [], commits = new Set(), namespace = 'daijin' } = {}) {
  const shaped = [];
  const dropped = [];
  for (const candidate of proposed || []) {
    if (!candidate?.id || !candidate?.title || !candidate?.content) {
      dropped.push({ id: candidate?.id || '(no id)', reason: 'missing id, title or content' });
      continue;
    }
    if (!NARRATABLE_TYPES.includes(candidate.type) || !ALLOWED_TYPE_SET.has(candidate.type)) {
      dropped.push({ id: candidate.id, reason: `type ${candidate.type} is not narratable at Layer 2` });
      continue;
    }
    if (!Array.isArray(candidate.citations) || candidate.citations.length === 0) {
      dropped.push({ id: candidate.id, reason: 'no citations: an uncited unit cannot be validated and is dropped' });
      continue;
    }
    shaped.push({
      ...candidate,
      id: candidate.id.startsWith(`${namespace}.`) ? candidate.id : `${namespace}.${candidate.type}.${candidate.id}`,
      meta: {
        ...(candidate.meta || {}),
        generated: true,
        generator: 'daijin-layer2',
        layer: 2,
        citations: candidate.citations,
      },
    });
  }
  const validated = validateCitations(shaped, { files, commits });
  return {
    accepted: validated.accepted,
    dropped: [...dropped, ...validated.dropped.map((entry) => ({ id: entry.id, reason: `citations not found: ${entry.missing.join(', ')}` }))],
  };
}

/**
 * Run Layer 2. Refuses by default; that is the feature.
 *
 * @param {object} options
 * @param {object} options.evidence          deterministic evidence tables
 * @param {Function|null} options.narrator   injected async fn(inputs) returning proposed units
 * @param {{open:boolean, path:string}} options.spendGate
 * @param {number|null} options.confirmedBudget  the user's explicit per-call confirmation
 */
export async function narrate({
  evidence,
  narrator = null,
  spendGate = { open: false, path: null },
  confirmedBudget = null,
  areas = null,
  files = [],
  commits = new Set(),
} = {}) {
  if (!spendGate?.open) {
    throw new SpendRefusedError(
      'Layer 2 narration is spend-touching and the spend gate is closed. The gate is opened by the owner, never by the engine.',
      { gate: spendGate?.path || null },
    );
  }
  if (!Number.isFinite(confirmedBudget) || confirmedBudget <= 0) {
    throw new SpendRefusedError(
      'Layer 2 narration needs a per-call budget confirmed by an explicit user action before it runs.',
      { gate: spendGate?.path || null },
    );
  }
  if (typeof narrator !== 'function') {
    throw new SpendRefusedError(
      'No narrator is wired in this build. Layer 1 is complete and zero-spend; Layer 2 lands with the provider client behind this same seam.',
      { gate: spendGate?.path || null },
    );
  }
  const inputs = narrationInputs(evidence, { areas });
  const proposed = await narrator(inputs, { budget: confirmedBudget });
  return { ...acceptNarration(proposed, { files, commits }), inputs };
}
