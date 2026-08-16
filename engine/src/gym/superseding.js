// Superseding commits: deterministic detection, latest-wins default, auditor override.
//
// The rule from the owner's funnel review: detection is DETERMINISTIC (diff overlap across
// candidates plus revert detection), and the auditor is told the relation as computed fact
// rather than asked to find it. Default latest-wins: the later commit enters the bank, the
// superseded one is excluded as an exam and reclassified as Layer 2 brain material (a
// decision or lesson with evidence). Auditor overrides are allowed for partial overlaps and
// each writes its reasoning into the exam's provenance record.
//
// Why this matters more than it looks: an exam whose gold commit was later reverted or
// rewritten teaches the student to reproduce code the repository has since rejected, and it
// grades as correct while doing it. The backstop for anything that slips through is
// harvest-time citation validation against CURRENT code, but a backstop is not a reason to
// skip the check.

/** Jaccard overlap over touched files. Deliberately not weighted by line counts: a
 *  three-line change that rewrites the same function as a hundred-line one supersedes it
 *  just as thoroughly, and weighting by size would rank the big commit as the real one. */
export function fileOverlap(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const file of a) if (b.has(file)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const REVERT_SUBJECT = /^Revert\s+"(.+)"\s*$/;

/** Does this commit revert that one? Two independent signals, either sufficient:
 *  the conventional revert subject naming the earlier subject, or an exactly inverted
 *  numstat over the identical file set (added and deleted swapped file by file). */
export function isRevertOf(later, earlier) {
  const subjectMatch = String(later.subject || '').match(REVERT_SUBJECT);
  if (subjectMatch && subjectMatch[1].trim() === String(earlier.subject || '').trim()) return 'revert-subject';
  const laterByFile = new Map((later.entries || []).map((entry) => [entry.file, entry]));
  const earlierEntries = earlier.entries || [];
  if (earlierEntries.length === 0 || laterByFile.size !== earlierEntries.length) return null;
  for (const entry of earlierEntries) {
    const inverse = laterByFile.get(entry.file);
    if (!inverse) return null;
    if (inverse.added !== entry.deleted || inverse.deleted !== entry.added) return null;
  }
  return 'inverted-numstat';
}

/**
 * Compute the superseding relations over a candidate set.
 *
 * Candidates are compared oldest to newest by date, and only later-supersedes-earlier
 * relations are emitted, so the relation graph carries the arrow of time rather than a
 * symmetric similarity. Ties on date fall back to commit id so the output is deterministic
 * on a repository where two commits share a timestamp.
 */
export function supersedingRelations(candidates, { overlapThreshold = 0.5 } = {}) {
  const ordered = [...candidates].sort((left, right) => (
    String(left.date).localeCompare(String(right.date)) || String(left.commit).localeCompare(String(right.commit))
  ));
  const relations = [];
  for (let later = 1; later < ordered.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      const a = ordered[earlier];
      const b = ordered[later];
      const revert = isRevertOf(b, a);
      const overlap = fileOverlap(a.files, b.files);
      if (revert) {
        relations.push({ earlier: a.commit, later: b.commit, kind: 'revert', signal: revert, overlap });
      } else if (overlap >= overlapThreshold) {
        relations.push({ earlier: a.commit, later: b.commit, kind: 'overlap', signal: 'file-overlap', overlap });
      }
    }
  }
  return relations;
}

/**
 * Apply the superseding rule.
 *
 * Default latest-wins. A superseded commit leaves the bank and becomes Layer 2 brain
 * material, carrying the relation that displaced it as its evidence: the pair "this was done,
 * then undone" is exactly the shape of a decision or a lesson.
 *
 * An override names a commit the auditor keeps despite the relation, and REQUIRES a
 * rationale of substance. An override without a reason is indistinguishable from a mistake
 * six months later, and the whole point of recording it in provenance is that someone can
 * disagree with it later on the merits.
 *
 * A REVERT relation cannot be overridden: an exam whose gold the repository has since undone
 * teaches the student to write code the project rejected, and no rationale makes that a
 * measurement. Overriding one is refused loudly rather than silently ignored.
 */
export function applySupersedingRule(candidates, relations, { overrides = [] } = {}) {
  const byCommit = new Map(candidates.map((candidate) => [candidate.commit, candidate]));
  const overrideByCommit = new Map();
  for (const override of overrides) {
    const rationale = String(override?.rationale || '').trim();
    if (!override?.commit) throw new Error('An auditor override must name a commit.');
    if (rationale.length < 20) {
      throw new Error(`Auditor override for ${override.commit} needs a rationale of at least 20 characters; an unexplained override cannot be reviewed later.`);
    }
    overrideByCommit.set(override.commit, rationale);
  }

  const supersededBy = new Map();
  for (const relation of relations) {
    if (!byCommit.has(relation.earlier) || !byCommit.has(relation.later)) continue;
    if (overrideByCommit.has(relation.earlier)) {
      if (relation.kind === 'revert') {
        throw new Error(`Auditor override refused for ${relation.earlier}: it was reverted by ${relation.later}, and a reverted gold is not a measurement.`);
      }
      continue;
    }
    const existing = supersededBy.get(relation.earlier);
    // Keep the LATEST superseder when several exist, so the provenance chain points at the
    // commit that actually stands today rather than at an intermediate step.
    if (!existing || String(byCommit.get(relation.later).date) > String(byCommit.get(existing.later).date)) {
      supersededBy.set(relation.earlier, relation);
    }
  }

  const bank = [];
  const layer2Material = [];
  for (const candidate of candidates) {
    const relation = supersededBy.get(candidate.commit);
    if (!relation) {
      const override = overrideByCommit.get(candidate.commit);
      bank.push(override
        ? { ...candidate, provenanceNote: { kind: 'auditor-override', rationale: override } }
        : candidate);
      continue;
    }
    layer2Material.push({
      commit: candidate.commit,
      subject: candidate.subject,
      files: candidate.files,
      reason: relation.kind === 'revert' ? 'reverted-by-later-commit' : 'superseded-by-later-commit',
      supersededBy: relation.later,
      signal: relation.signal,
      overlap: relation.overlap,
    });
  }
  return { bank, layer2Material };
}
