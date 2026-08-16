// The student prompt scaffold, and the audit that keeps it honest.
//
// Lineage: platform run.js buildEngineerPrompt plus platform/orchestrator/engineer-prompt.md
// (prompt-version 2), whose "Completion gauge" and "Integration seam first" sections ADR-0167
// made campaign defaults. Both sections ship in agents-defaults/student.md.
//
// The instruction files are USER-EDITABLE by design (settings shows a modified-from-default
// badge). That creates a measurement hazard the platform never had: ADR-0167's defaults are
// two sections of prose, and a user who deletes them changes what is being measured while
// every number keeps its old name. The harness does not re-inject them, because silently
// overriding the user's file makes the badge a lie. It AUDITS instead: every run records
// which ADR-0167 sections its prompt actually carried, and a scored run missing one is a
// board finding rather than a footnote nobody reads.

const FIX_MODE = /\b(fix|bug|broken|failure|incorrect|wrong|crash|regression)\b/i;

/** The ADR-0167 prompt sections, by the evidence each one must show. The markers are the
 *  load-bearing phrases rather than the heading text: a user retitling a heading has not
 *  removed the rule, and a user deleting the rule while keeping the heading has. */
export const PROMPT_SECTIONS = Object.freeze([
  {
    id: 'completion-gauge',
    // The gauge is three claims: audit every criterion, do not stop merely on elapsed
    // effort, and the budget consequence (unverified edits die at the seal, verified
    // progress earns extensions) that makes the extension policy legible to the student.
    markers: [/criteri/i, /\bMET\b/, /\bUNMET\b/, /unverified edits/i, /extension/i],
  },
  {
    id: 'integration-first',
    markers: [/end-to-end|end to end/i, /wire|wiring|register the route/i, /before|first|only after/i],
  },
]);

export function studentMode(task) {
  return FIX_MODE.test(String(task || '')) ? 'fix-bug' : 'implement-feature';
}

export function modeRule(mode) {
  return mode === 'fix-bug'
    ? 'Reproduce or establish the failure, fix its root cause, and add regression evidence without masking symptoms.'
    : 'Implement the requested behavior completely, including contracts, tests, and documented side duties.';
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Which ADR-0167 sections this instruction text actually carries.
 *
 * A section counts as present only when EVERY one of its markers appears. Partial credit
 * would be the worst outcome: a gauge that says "audit your criteria" without the budget
 * consequence reads as present in the record while the student never learns that unverified
 * edits are discarded, which is the half that changes behavior.
 */
export function promptScaffoldAudit(rules) {
  const text = String(rules || '');
  const sections = {};
  for (const section of PROMPT_SECTIONS) {
    sections[section.id] = section.markers.every((marker) => marker.test(text));
  }
  const missing = Object.entries(sections).filter(([, present]) => !present).map(([id]) => id);
  return { sections, missing, complete: missing.length === 0 };
}

/**
 * Compose the prompt handed to the student.
 *
 * The task is wrapped in a tagged block and XML-escaped for the same reason the platform
 * does it: the task text is owner data inside a prompt, and an unescaped angle bracket in a
 * task about HTML would close the block. The brain context follows the rules and the task,
 * unchanged, because retrieval parity depends on the context bytes being what retrieve()
 * produced.
 */
export function buildStudentPrompt({ rules, task, context = '', taskLabel = 'owner task data' }) {
  const rulesText = String(rules || '').trim();
  if (!rulesText) throw new Error('Student instruction file is empty; refusing to run a student with no rules.');
  const taskText = String(task || '').trim();
  if (!taskText) throw new Error('Exam task is empty.');
  const mode = studentMode(taskText);
  return {
    mode,
    audit: promptScaffoldAudit(rulesText),
    prompt: `${rulesText}\n\n## Mode-specific rule (${mode})\n\n${modeRule(mode)}\n\n`
      + 'Inspect the sandbox, make your edits, then submit the solution. '
      + 'The harness derives and reapplies the final unified diff before running objective gates. '
      + 'Never request or infer a hidden reference solution.\n\n'
      + `<task note="${taskLabel}">\n${escapeXml(taskText)}\n</task>\n\n${context}`,
  };
}
