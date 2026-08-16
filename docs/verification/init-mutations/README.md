# Init lane mutation battery

38 mutations over `engine/src/init/`, each removing one mechanism and naming the test that
catches it. `mutate-output.txt` is a captured run: declared 38, executed 38, killed 38.

    node mutate.mjs                  # private copy, the only sane default
    node mutate.mjs <dir>            # a tree you already prepared
    MUTATE_IN_PLACE=1 node mutate.mjs <shared>   # announced, and only on purpose

## Why it is in the tree

It used to live in session scratch. An uncommitted battery cannot carry a demonstrated
refusal, cannot be reviewed, and cannot be re-run by anyone else, so compliance that lives in
scratch is a claim rather than bytes. It had also already survived one session boundary by
luck.

## The incident it was rewritten for

The previous version mutated `engine/src` IN PLACE. Other lanes ran their suites through
those windows and saw failures, and because every window belonged to the init lane's files,
every captured failure landed in the init surface: the evidence pointed at init's code while
the cause was init's tooling. That is the flake D-0032 exists to end, and this battery caused
it.

## The four properties

Three are D-0032's, taken from gym-porter's tested pattern at
`docs/verification/p4-mutations/d0032-pattern.mjs`. The fourth is one this battery learned the
hard way and is offered back.

1. **Private copy by default.** A mutation is a window in which the source on disk is
   deliberately broken; no other process may be able to read it.
2. **Structural refusal of the shared tree**, with a loud override. Demonstrated firing in
   `refusal-demo.txt`, because a check nobody has seen fail is not yet a check.
3. **Three-hash assertion per mutation**: before, after mutating, after restoring. The middle
   must differ, or the anchor matched nothing and NOTHING WAS TESTED while the run still
   looks successful. The last must equal the first, or every later mutation runs against a
   tree nobody described. Both are reported as their own outcomes, `dead-anchor` and
   `not-restored`, and both exit non-zero.
4. **Baseline control before any mutation.** Not in the pattern module, and it is the check
   that caught this battery lying.

## The lie property 4 caught, worth reading before trusting any battery

The first private-copy version copied only `src`, `test` and `package.json`. But
`engine/src/store/sqlite.js` imports `../../../adapters/`, which resolves OUTSIDE the engine
root, so in the private tree every test file failed to resolve. Every run was red. Every one
of the 38 mutations was therefore scored **killed**, and the battery printed a perfect
`38 of 38` that meant nothing at all: no test had executed under any mutation.

A broken tree produces a flawless-looking battery. The fix is the copy list (gym-porter's
pattern says to widen it rather than fall back to the shared tree, which is what happened
here), and the guard is the baseline: the unmutated tree must be green or the run refuses,
because a gate that fails on baseline and candidate alike carries no signal.

## Outcomes

| outcome | meaning |
| --- | --- |
| `killed` | the mechanism is pinned: removing it fails a named test |
| `survived` | the mechanism is NOT pinned. A problem, not a note |
| `dead-anchor` | the expression matched nothing, so nothing was tested. Repair the anchor |
| `not-restored` | the file was left changed; the run stops rather than continuing blind |

Anything that is not `killed` exits non-zero, and `declared` versus `executed` is printed so a
table that silently shrank is visible.

## Files

| file | what it is |
| --- | --- |
| `mutate.mjs` | the battery |
| `mutations.json` | the 38 mutations, as data |
| `mutate-output.txt` | a captured clean run |
| `refusal-demo.txt` | the shared-tree refusal firing |
