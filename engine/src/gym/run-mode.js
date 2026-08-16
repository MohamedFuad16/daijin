// Mode quarantine. Ported from the platform (platform/exam/run-mode.js) and narrowed to
// the three modes Daijin ships.
//
// The platform carries five modes; two of them (harness-smoke, infra-probe) name platform
// operations that have no product equivalent, so they are not imported. Adding a mode is a
// contract change: every scoring path in the ledger filters on `evaluation` and a fourth
// mode that nobody taught the ledger about would either vanish from the record or leak into
// it, and which of the two it does would depend on where it was added.
//
// The rule this module exists to make structural: ONLY `evaluation` touches the scored
// record. Fourteen-plus experimental runs on the platform stayed out of the scored record
// because the mode was checked in code rather than remembered by an operator.

/** The three modes, in decreasing order of consequence. */
export const RUN_MODES = Object.freeze(['evaluation', 'experiment', 'harness-debug']);

/** The mode a run gets when nothing says otherwise. Loud rather than convenient: an
 *  unset mode is the operator forgetting to say what this run is, and the safe reading of
 *  a forgotten mode is the one that cannot reach the scored record. The platform defaults
 *  the other way (unset stays `evaluation`) because there the caller is a committed
 *  run-order script; here the caller is an RPC method a TUI button reaches. */
export const DEFAULT_RUN_MODE = 'harness-debug';

export function assertRunMode(mode) {
  if (!RUN_MODES.includes(mode)) {
    throw new Error(`Unsupported gym run mode: ${mode ?? '<missing>'}. Modes: ${RUN_MODES.join(', ')}.`);
  }
  return mode;
}

/** Scoreable means: this run's row may be counted by a published number. */
export function isScoreableRun(mode) {
  return assertRunMode(mode) === 'evaluation';
}

/** Gradable means: a teacher may be asked for a rubric. An experiment is graded so its
 *  arm can be compared, and is still never scored. */
export function isGradableRun(mode) {
  return assertRunMode(mode) === 'evaluation' || mode === 'experiment';
}

/** The guard every scored write passes through. Named so a stack trace says which rule
 *  refused, because "constraint failed" from SQLite would not. */
export function assertScoredWrite(mode, what = 'this record') {
  if (!isScoreableRun(mode)) {
    throw new Error(`Run mode ${mode} may not write ${what} to the scored record; only evaluation rows are scored.`);
  }
  return mode;
}
