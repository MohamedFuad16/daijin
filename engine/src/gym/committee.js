// The exam committee: the auditor's judgment over the eligible candidates,
// wrapped so mining.js's stage-2 seam receives exactly the shape it froze.
//
// The committee is the LLM step and only the LLM step. Everything either
// side of it is mechanical and already built: the deterministic filter picks
// who may be considered, superseding relations arrive computed, and the
// selection is validated against the eligible set ("the auditor proposes;
// mechanics accept"). What the auditor ADDS is judgment plus authorship: the
// task statement each exam is run under, written without leaking the
// solution, because the student will read it.
//
// The reply contract is STRICT JSON. A committee whose output needed a
// second model to interpret would put an unauditable step inside the one
// pipeline whose whole design is auditability; a malformed reply is an
// error carried to the step stream, never a shrug.

const FENCE = /^```[a-z]*\n?|\n?```$/g;

/** The prompt, deterministic over its inputs so a re-run is comparable. */
export function committeePrompt({ candidates, relations, target }) {
  const lines = candidates.map((candidate) => {
    const files = candidate.files.slice(0, 8).join(', ') + (candidate.files.length > 8 ? `, +${candidate.files.length - 8} more` : '');
    return `- commit ${candidate.commit}\n  date ${candidate.date}\n  subject: ${candidate.subject}\n  ${candidate.files.length} file(s), ${candidate.changedLines} changed line(s): ${files}`;
  });
  const relationLines = (relations || []).map((relation) => (
    `- ${relation.later} supersedes ${relation.earlier} (${relation.kind ?? relation.reason ?? 'overlap'})`
  ));
  return [
    'You are the exam committee for a coding gym. From the candidate commits below, select',
    `up to ${target} that make good exams: one coherent intent, a task statement you can`,
    'write WITHOUT leaking the solution, and real code surfaces (not wiring or churn).',
    'Prefer spread across areas and difficulty. Mark roughly one in five heldOut: true',
    '(the held-out split is never trained against).',
    '',
    'Superseding relations, computed for you (a superseded commit is already excluded):',
    relationLines.length ? relationLines.join('\n') : '- none',
    '',
    'Candidates:',
    lines.join('\n'),
    '',
    'Reply with STRICT JSON only, no prose and no code fences, exactly this shape:',
    '{"chosen": [{"commit": "<full sha>", "title": "<short imperative title>",',
    '  "task": "<the task statement the student will read; at least 35 characters;',
    '   describe the OUTCOME to achieve, never the diff that achieves it>",',
    '  "rationale": "<one sentence: why this commit makes a good exam>",',
    '  "heldOut": false}]}',
  ].join('\n');
}

/** Parse the committee's reply. Throws with the defect named; never repairs. */
export function parseCommitteeReply(text) {
  const stripped = String(text || '').trim().replace(FENCE, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // A model that wrapped its JSON in prose gets ONE mechanical second
    // chance: the outermost object literal, found by brace matching. This is
    // extraction, not repair - the JSON itself is still parsed strictly.
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The committee reply is not JSON and contains no object literal.');
    parsed = JSON.parse(stripped.slice(start, end + 1));
  }
  if (!Array.isArray(parsed?.chosen)) throw new Error('The committee reply has no chosen array.');
  for (const entry of parsed.chosen) {
    if (!entry?.commit) throw new Error('A chosen entry has no commit.');
    if (typeof entry.task !== 'string' || entry.task.trim().length < 35) {
      throw new Error(`The task for ${entry.commit} is missing or under 35 characters; a student cannot be run against it.`);
    }
  }
  return { chosen: parsed.chosen };
}

/**
 * The auditor object mining.js stage 2 expects, over a role generate function.
 * `identity` is recorded into every exam's provenance (P7 clause 4: an exam a
 * model authored records WHICH model, at write time).
 */
export function buildCommitteeAuditor(generate, { target = 10 } = {}) {
  return {
    async selectExamBank({ candidates, relations }) {
      const { text } = await generate({
        prompt: committeePrompt({ candidates, relations, target }),
        maxTokens: 16_384,
      });
      return parseCommitteeReply(text);
    },
  };
}
