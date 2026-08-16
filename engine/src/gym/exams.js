// The exam record, and the two orthogonal status axes.
//
// Ported from platform/exam/exams.js, with the authoring axis the platform never had (it
// approved task details by ADR instead) added because Daijin's bank is authored by the
// AUDITOR and vetoed by the user through RPC (examVeto, examUpdate).
//
// TWO AXES PLUS A SPLIT FLAG, per RPC v4 methods.md examList, and they are orthogonal on
// purpose:
//
//  - `status` is the AUTHORING pipeline: draft, validated, promoted, vetoed. It answers
//    "may this exam be handed to a student at all".
//  - `benchmarkStatus` is MEASUREMENT INTEGRITY: active or quarantined. It answers "may a
//    result from this exam be counted". A promoted exam can be quarantined (the platform's
//    cap-death case, ADR-0148 lineage) without being un-promoted, and un-quarantining it is
//    a separate act from re-authoring it. Collapsing the two axes into one enum is how a
//    quarantined exam quietly returns to the cohort when someone edits its task.
//  - `heldOut` is neither: it is the train/measure split, and a held-out exam is a perfectly
//    active, promoted exam that the training loop may not draw and harvest may not read.
//
// `quarantineReason` is required at 20 characters minimum, exactly as the platform requires
// it, because "quarantined: bad" is not a record anyone can act on later.

const EXAM_ID = /^exam-\d{4}$/;
const SHA = /^[0-9a-f]{40}$/;

export const AUTHORING_STATUSES = Object.freeze(['draft', 'validated', 'promoted', 'vetoed']);
export const BENCHMARK_STATUSES = Object.freeze(['active', 'quarantined']);
export const SCOPE_TIERS = Object.freeze(['S', 'M', 'L']);
export const MIN_QUARANTINE_REASON = 20;

/** Provenance of an exam record: how it entered the bank. `auditor-override` records a
 *  superseding decision the auditor made against the deterministic default (funnel rule). */
export const EXAM_PROVENANCE_SOURCES = Object.freeze([
  'commit-mining', 'auditor-selection', 'auditor-override', 'imported',
]);

/** Sources whose exam was AUTHORED BY A MODEL, and therefore must record which one.
 *  `commit-mining` is deterministic: a filter and a diff have no author, so there is no
 *  independence question to answer. */
export const AUTHORED_SOURCES = Object.freeze(['auditor-selection', 'auditor-override']);

/**
 * The identity of an agent that authored or graded something (P7 clause 4).
 *
 * Keyed on MODEL AND ENDPOINT rather than on role, and that choice is the whole clause.
 * Keying on role would make the check unfalsifiable: the auditor authors and the teacher
 * grades, so the roles differ by construction and the refusal would never fire, which is a
 * gate that cannot fail. The realistic failure is a user with one API key configuring the
 * auditor and the teacher to the SAME model, at which point one model writes the exam and
 * grades the answer, and role separation is a diagram rather than a fact.
 */
export function agentIdentity(agent) {
  const role = typeof agent?.role === 'string' ? agent.role.trim() : '';
  const rawModel = typeof agent?.model === 'string' ? agent.model.trim() : '';
  if (!rawModel) throw new Error('An agent identity needs a model id; role alone cannot establish independence.');
  const rawEndpoint = typeof agent?.endpoint === 'string' && agent.endpoint.trim() ? agent.endpoint.trim() : 'default';
  const model = normalizeModelId(rawModel);
  const endpoint = normalizeEndpoint(rawEndpoint);
  return {
    role: role || null,
    model,
    endpoint,
    key: `${model}@${endpoint}`,
    // The values as CONFIGURED, kept rather than destroyed by normalization, for the same
    // reason a differing self-report is kept as reportedAuthor: the record should show what
    // someone actually typed, and a normalized key is a comparison tool, not the truth.
    configured: { model: rawModel, endpoint: rawEndpoint },
  };
}

/**
 * Normalization exists because the evasions are ACCIDENTS, not attacks (finding 77).
 *
 * A user who types GLM-5.2 into one role and glm-5.2 into the other has configured one key
 * into both roles; a user whose endpoint carries a trailing slash in one field and not the
 * other has done the same. Without normalization the independence refusal never fires, the
 * grade lands, and the record shows a clean cycle. The failure is silent, which is what makes
 * it worth normalizing rather than documenting.
 *
 * Model ids are compared casefolded because providers treat them that way.
 */
export function normalizeModelId(model) {
  return String(model).trim().toLowerCase();
}

/**
 * Endpoints: the scheme and host are casefolded because they are case-insensitive by
 * definition, the trailing slash is stripped, and THE PATH KEEPS ITS CASE because a URL path
 * is case-sensitive and two deployments can legitimately differ only there. A blunter
 * lowercase-everything would conflate deployments that are genuinely different, which is the
 * opposite error and just as silent.
 */
export function normalizeEndpoint(endpoint) {
  const text = String(endpoint).trim().replace(/\/+$/, '') || 'default';
  try {
    const url = new URL(text);
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    // Not a URL: a bare name, or the 'default' sentinel. Casefold it, since there is no path
    // to preserve.
    return text.toLowerCase();
  }
}

/**
 * May this grader grade this exam?
 *
 * Returns a reason string when it may not, null when it may. Three cases, and the middle one
 * is the one people expect to be missing:
 *  - The exam has no model author (deterministic mining): independence holds by construction.
 *  - The grader's identity equals the author's: REFUSED. An author grading its own exam
 *    calibrates its own instrument.
 *  - An authored exam whose author was never recorded: REFUSED. Absent is not empty; without
 *    the record we cannot show independence, and a certification-grade claim cannot rest on
 *    an absence of evidence. `parseExamRecord` refuses to store such an exam in the first
 *    place, so reaching this branch means a record arrived from somewhere else.
 */
export function graderIndependenceRefusal(exam, grader) {
  const author = exam?.provenance?.authoredBy ?? null;
  if (!author) {
    if (AUTHORED_SOURCES.includes(exam?.provenance?.source)) {
      return `${exam.examId} was authored by a model (${exam.provenance.source}) but records no authoring identity, so independence cannot be shown.`;
    }
    return null;
  }
  const graderIdentity = agentIdentity(grader);
  if (author.key === graderIdentity.key) {
    return `${exam.examId} was authored by ${author.key} and cannot be graded by the same identity; `
      + 'configure a different model for the teacher role so the author is not the grader.';
  }
  return null;
}

function requireString(value, field, source, { min = 1 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw new Error(`${source}: ${field} is required (at least ${min} characters).`);
  return text;
}

/** Longest a derived title may be before it is cut at a word boundary. */
export const MAX_TITLE_LENGTH = 80;

/**
 * The human-readable one-liner examList carries (RPC v5: "the bank was unreadable by id
 * alone").
 *
 * Derived from the auditor's task statement when the record does not carry one, because a
 * title is a display concern and a bank mined before this field existed should still read.
 * Derivation is deterministic and never invents words: it is the first sentence of the task,
 * cut at a word boundary.
 */
export function examTitle(explicit, task) {
  const given = typeof explicit === 'string' ? explicit.trim() : '';
  if (given) return given;
  const firstSentence = String(task).split(/(?<=[.!?])\s/)[0].trim();
  if (firstSentence.length <= MAX_TITLE_LENGTH) return firstSentence.replace(/\.$/, '');
  const cut = firstSentence.slice(0, MAX_TITLE_LENGTH);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > 20 ? cut.slice(0, boundary) : cut).trimEnd()}...`;
}

/**
 * Validate one exam record. Input is a plain object (parsed YAML, an RPC patch, or a row
 * from the gym store); output is the canonical shape the rest of the gym reads.
 */
export function parseExamRecord(raw, source = 'exam') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source}: expected an exam object.`);
  const examId = String(raw.examId ?? raw.id ?? '');
  if (!EXAM_ID.test(examId)) throw new Error(`${source}: invalid exam id ${JSON.stringify(examId)}; expected exam-NNNN.`);

  const status = raw.status ?? 'draft';
  if (!AUTHORING_STATUSES.includes(status)) throw new Error(`${source}: invalid status ${JSON.stringify(status)}.`);

  const benchmarkStatus = raw.benchmarkStatus ?? 'active';
  if (!BENCHMARK_STATUSES.includes(benchmarkStatus)) {
    throw new Error(`${source}: invalid benchmarkStatus ${JSON.stringify(benchmarkStatus)}.`);
  }
  const quarantineReason = typeof raw.quarantineReason === 'string' ? raw.quarantineReason.trim() : null;
  if (benchmarkStatus === 'quarantined') {
    if (!quarantineReason || quarantineReason.length < MIN_QUARANTINE_REASON) {
      throw new Error(`${source}: a quarantined exam requires quarantineReason of at least ${MIN_QUARANTINE_REASON} characters.`);
    }
  } else if (quarantineReason) {
    throw new Error(`${source}: an active exam cannot carry quarantineReason.`);
  }

  if (typeof raw.heldOut !== 'boolean') throw new Error(`${source}: heldOut must be a boolean.`);

  const scopeTier = raw.scopeTier ?? raw.tier;
  if (!SCOPE_TIERS.includes(scopeTier)) throw new Error(`${source}: invalid scopeTier ${JSON.stringify(scopeTier)}.`);

  const baseCommit = String(raw.baseCommit ?? '');
  const goldCommit = String(raw.goldCommit ?? '');
  if (!SHA.test(baseCommit) || !SHA.test(goldCommit)) {
    throw new Error(`${source}: baseCommit and goldCommit must be full 40-character SHAs.`);
  }
  if (baseCommit === goldCommit) throw new Error(`${source}: baseCommit and goldCommit must differ.`);

  const task = requireString(raw.task, 'task', source, { min: 35 });

  const scopeFiles = raw.scopeFiles;
  const scopeInsertions = raw.scopeInsertions;
  if (!Number.isInteger(scopeFiles) || scopeFiles < 1) throw new Error(`${source}: scopeFiles must be a positive integer.`);
  if (!Number.isInteger(scopeInsertions) || scopeInsertions < 0) throw new Error(`${source}: scopeInsertions must be a non-negative integer.`);

  // ADR-0148: a per-exam cap override is a documented decision, not drift, so it carries a
  // reason under the same rule quarantine does.
  const workTokenCap = raw.workTokenCap ?? null;
  let workTokenCapReason = null;
  if (workTokenCap !== null) {
    if (!Number.isInteger(workTokenCap) || workTokenCap < 100_000 || workTokenCap > 1_000_000) {
      throw new Error(`${source}: workTokenCap must be an integer from 100000 to 1000000.`);
    }
    workTokenCapReason = requireString(raw.workTokenCapReason, 'workTokenCapReason', source, { min: MIN_QUARANTINE_REASON });
  } else if (raw.workTokenCapReason) {
    throw new Error(`${source}: workTokenCapReason without workTokenCap.`);
  }

  const provenance = raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : null;
  if (!provenance) throw new Error(`${source}: provenance is required; an exam with no recorded origin cannot be audited.`);
  if (!EXAM_PROVENANCE_SOURCES.includes(provenance.source)) {
    throw new Error(`${source}: provenance.source must be one of ${EXAM_PROVENANCE_SOURCES.join(', ')}.`);
  }
  // P7 clause 4: an exam a model authored records WHICH model, at write time, because the
  // grading refusal is only as good as the field it compares against. Refusing here rather
  // than at grading time means the unusable record never enters the bank.
  let authoredBy = null;
  if (provenance.authoredBy) {
    authoredBy = agentIdentity(provenance.authoredBy);
  } else if (AUTHORED_SOURCES.includes(provenance.source)) {
    throw new Error(
      `${source}: provenance.authoredBy is required when the source is ${provenance.source}; `
      + 'an exam a model wrote must record which model, or author-grader independence cannot be shown.',
    );
  }
  if (status === 'vetoed') requireString(raw.vetoReason, 'vetoReason', source, { min: MIN_QUARANTINE_REASON });

  return {
    examId,
    title: examTitle(raw.title, task),
    status,
    benchmarkStatus,
    quarantineReason,
    heldOut: raw.heldOut,
    scopeTier,
    scopeFiles,
    scopeInsertions,
    baseCommit,
    goldCommit,
    task,
    taskDetail: raw.taskDetail ?? null,
    goldNotes: typeof raw.goldNotes === 'string' ? raw.goldNotes.trim() : null,
    workTokenCap,
    workTokenCapReason,
    vetoReason: status === 'vetoed' ? String(raw.vetoReason).trim() : null,
    provenance: {
      source: provenance.source,
      authoredBy,
      commit: provenance.commit ?? null,
      supersedes: Array.isArray(provenance.supersedes) ? [...provenance.supersedes] : [],
      supersededBy: provenance.supersededBy ?? null,
      auditorRationale: provenance.auditorRationale ?? null,
      minedAt: provenance.minedAt ?? null,
    },
  };
}

/**
 * May this exam be DRAWN for a run in this mode?
 *
 * Returns a reason string when it may not, null when it may. A string rather than a boolean
 * because every refusal here has to reach the operator: the platform's "exam is quarantined
 * from execution" error names the quarantine reason, and a bare false would not.
 *
 * The rules, and note that each axis refuses independently:
 *  - Quarantined: never drawn, in any mode. Quarantine is about measurement integrity, and
 *    a harness-debug run against a broken exam still burns a slot and confuses a reader.
 *  - Not promoted: never drawn in evaluation mode. A draft exam may be exercised in
 *    harness-debug, which is what the mode is for; it may never produce a scored row.
 *  - Vetoed: never drawn, in any mode. A veto is the user's, and the modes are ours.
 *  - Held out: refused for a training cohort, allowed when the caller asks for the held-out
 *    split explicitly. The refusal is what keeps the reserved exams an honest yardstick.
 */
export function examDrawRefusal(exam, { mode = 'evaluation', cohort = 'training' } = {}) {
  if (exam.status === 'vetoed') return `${exam.examId} is vetoed: ${exam.vetoReason}`;
  if (exam.benchmarkStatus === 'quarantined') {
    return `${exam.examId} is quarantined from execution: ${exam.quarantineReason}`;
  }
  if (mode === 'evaluation' && exam.status !== 'promoted') {
    return `${exam.examId} is ${exam.status}, not promoted; only a promoted exam may produce a scored row.`;
  }
  if (exam.heldOut && cohort !== 'held-out') {
    return `${exam.examId} is held out; it is drawn only by an explicit held-out cohort.`;
  }
  if (!exam.heldOut && cohort === 'held-out') {
    return `${exam.examId} is not held out and cannot fill a held-out cohort slot.`;
  }
  return null;
}

/** The examList row shape, RPC v4. Kept beside the parser so the wire format and the
 *  validator cannot drift apart. */
export function examListRow(exam) {
  return {
    examId: exam.examId,
    // v5: the bank was unreadable by id alone.
    title: exam.title,
    status: exam.status,
    benchmarkStatus: exam.benchmarkStatus,
    ...(exam.quarantineReason ? { quarantineReason: exam.quarantineReason } : {}),
    heldOut: exam.heldOut,
    tier: exam.scopeTier,
    provenance: exam.provenance,
  };
}

/** Quarantine an exam in place. The reason is required here too rather than only in the
 *  parser, so a caller cannot construct the invalid state and then fail to persist it. */
export function quarantineExam(exam, reason) {
  const text = requireString(reason, 'quarantineReason', exam.examId, { min: MIN_QUARANTINE_REASON });
  return parseExamRecord({ ...exam, benchmarkStatus: 'quarantined', quarantineReason: text }, exam.examId);
}

export function vetoExam(exam, reason) {
  const text = requireString(reason, 'vetoReason', exam.examId, { min: MIN_QUARANTINE_REASON });
  return parseExamRecord({ ...exam, status: 'vetoed', vetoReason: text }, exam.examId);
}
