// Standing units: the Brain's procedural memory.
//
// WHY THIS EXISTS
// Platform cycle 31 lost two of five exams to the same defect: the engineer declared a
// helper and never called it. `global.lesson.helper-call-sites` says exactly that,
// records that two earlier exams already failed the same way, and was retrieved for NONE
// of the five.
//
// It never had a fair chance. Semantic retrieval ranks by similarity to the task, and a
// task about gig filters or Gmail races reads nothing like "a declared helper that
// nothing calls is not a finished implementation." These units are not about any task,
// they are about how to work at all. Making them compete on similarity against task
// specific documents guarantees they lose exactly when they are needed, because the
// engineer who is about to forget a call site is not thinking about call sites.
//
// So they are not retrieved. They are always present, the way a house style is always
// present, and they are deliberately kept OUT of the k and token budget: procedural
// memory should not cost the task its evidence. That is a real context increase (about
// 2,100 tokens on the platform corpus) paid because an exam lost to this defect costs
// far more.
//
// THE NAMESPACE IS THE CONTRACT
// A `global.` id already means "applies to every surface in this repository", which is
// what distinguishes it from `web.`, `ios.`, and `contracts.`. Pinning exactly that
// namespace needs no second list to maintain and no judgement call per document.
//
// EXCLUSION STILL WINS
// A standing unit that is the answer to the exam being graded is dropped like any other.
// Gold provenance exclusion is what keeps the exam honest, and "always present" is not a
// licence to leak an answer.
//
// The SQL that fetches them belongs to the Store; only the namespace contract lives here.
const STANDING_ID_PREFIX = 'global.';

/// True when an id belongs to the standing namespace. Used by the gold set scorer to
/// report which hits were earned by ranking and which were guaranteed by pinning.
export function isStandingId(id, prefix = STANDING_ID_PREFIX) {
  return String(id).startsWith(prefix);
}

/// Shape a store's standing rows into retrieval entries.
export function asStandingUnits(rows) {
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    path: row.path,
    area: row.meta?.area || null,
    tags: row.tags || [],
    content: row.content,
    standing: true,
  }));
}

export { STANDING_ID_PREFIX };
