# P4 verification evidence

Durable evidence for the P4 gym port: the mutation battery, the gate-scanner acceptance
instrument, and the captured output of both. Session scratch dies; the evidence should not.

| file | what it is |
| --- | --- |
| `mutate.sh` | the 77-mutation battery, P4 and P7. Exits non-zero on any survivor, skip, or declared-but-unexecuted mutation. Every line must read KILLED. |
| `mutate-output.txt` | its captured output, with the run timestamp in the header. |
| `gate-scanner-plants.mjs` | THE ARBITER for D-0023, authored by the VERIFIER, unmodified. Exit 0 is acceptance. |
| `gate-scanner-plants-output.txt` | its captured output run against the landed scanner. |
| `gate-plants.mjs` | gym-porter's extended plant set (12 plants, 4 controls), per the verifier's standing note that four plants is ten minutes of thought and not a bound. |
| `gate-plants-output.txt` | its captured output. |

## Measured 2026-08-16 18:05 JST (2026-08-16 09:05Z)

- `node docs/verification/p4-mutations/gate-scanner-plants.mjs`: caught 4/4 plants, control
  clean, ACCEPTANCE MET, exit 0. The verifier's four plants are also pinned inside
  `engine/test/gym-spend-gate.test.js` so `npm test` enforces the same bar; if the two ever
  disagree, the script wins and the test copy is the stale one.
- `node docs/verification/p4-mutations/gate-plants.mjs`: 12 plants, 4 controls, 0 failures.
- `bash docs/verification/p4-mutations/mutate.sh`: 77 mutations, 77 KILLED, exit 0, declared 77
  and executed 77.
- `node --test "test/gym-*.test.js"` from `engine/`: tests 131, pass 131, fail 0.
- `npm test` from `engine/`: 503 tests, 503 pass, 0 fail. Suite-count caveat per D-0014: the
  engine suite is written by several workers at once, so every total here is a timestamped
  snapshot of a moving number.
- Mutation battery history: two mutations SURVIVED on their first run and are recorded as
  prominently as the kills, because each was a test that looked like coverage and was not:
  1. The exam parser's quarantine-reason minimum. Only `quarantineExam()` covered it, so a
     record arriving by any other path (an RPC patch, a YAML import, a restored row) could
     have carried "broken" as its entire audit trail.
  2. The step-0 extension disable. The first version of the live test used a script whose
     first-edit check PASSED, so no boundary check would have run whatever the step was.
     Rewritten to satisfy every boundary condition except the step.
  3. Finding 77's trailing-slash strip, which survived because the URL branch strips the
     slash a second time; only a BARE-NAME endpoint exercises the first strip, and that case
     did not exist until the mutation asked for it.
  4. P7 clause 18's provider scan. Its positive control was ONE example that matched four
     alternatives of the pattern at once (a fetch, to an https URL, with a Bearer header), so
     neutering any single branch left the control green. Rewritten as a table exercising every
     branch separately. A positive control that passes for the wrong reason is a gate that
     cannot fail, one level up.

## Three ways this battery has lied, and the three checks that stopped it

1. A SURVIVOR means the code is not pinned. Counted.
2. A SKIP means the expression matched nothing, so nothing was tested. Two happened when a
   refactor moved anchors out from under expressions. Counted, and the message says
   RE-ANCHOR THIS.
3. A DECLARED-BUT-UNEXECUTED mutation, and the counter that catches it must itself be
   robust: the declared grep matches leading whitespace (finding 81), because an INDENTED
   run_mutation would otherwise be invisible to the declared side while still incrementing
   the executed side, leaving the comparison balanced and wrong. Six were once appended after the summary block's
   `exit` and never ran, while the script printed "All mutations killed." The declared count
   is now compared against the executed count, and nothing may be appended below the summary.

All three are the same defect wearing different clothes: an instrument reporting a result for
a check that did not run. The exit code is trustworthy only because all three are counted.

## A skipped mutation is not evidence

Two mutations were SKIPPED on 2026-08-16 because a refactor of mine moved the anchors their
expressions matched. The script printed SKIPPED and carried on, which reads like a result at a
glance. It no longer does: skips and survivors are both counted, the message says RE-ANCHOR
THIS, and the script exits non-zero on either.

## The battery mutates a PRIVATE COPY (D-0032)

A mutation is a WINDOW in which the source on disk is deliberately broken. Run against the
shared tree, every other process's `npm test` can read that broken source, which produced a
1-in-5 suite flake across the whole build whose cause was invisible from the failure: another
lane's gate failing for a defect that existed for two seconds and belonged to nobody.

The battery now copies `src`, `test` and `package.json` to a temp directory, links
`node_modules`, and mutates there; the shared tree is never modified. `DAIJIN_MUTATE_IN_PLACE=1`
is the explicit override for someone debugging a test that depends on the tree's real
location, and it announces itself loudly. Proven per run rather than asserted: hashing the
shared tree before and after a full battery gives an identical digest.

## Reading mtimes after a run

The battery restores each file with `mv file.bak file`. Content is byte-identical; mtime is
new. A tree that has had the battery run over it shows a wall of fresh mtimes with zero
content change, so during a verification hold this directory is a trap for anyone bounding
drift by timestamp. Bound drift by hash.

## History, and why the manifest still exists

[UPDATED 2026-08-16: the repository now HAS commits, owner-authorized, and verdicts pin
commits from here. The finding below is resolved in the strong direction and the paragraph is
kept rather than deleted, because the reasoning is what earned the change.]

For the first day of this build `git log` reported no commits at all, so nothing had history:
no worker could prove a past byte state, and every byte-check was a read of a live,
concurrently edited working tree. That produced one unsettleable disagreement about what a
file contained at a given minute. The manifest below was the workaround and is kept as the
cheap check: a hash answers "did this move" without cloning or diffing anything.

## Content hashes of the P4 tree as reviewed (sha256)

This file is deliberately EXCLUDED from its own manifest. A file carrying its own hash can
never match it: writing the hash changes the bytes that produced it. The first version
included itself and was stale the moment it was saved, which is the same class of mistake as
a gate that cannot fail.

Regenerate with:

    cd /Users/mfuad16/Documents/daijin && shasum -a 256 \
      engine/src/gym/*.js engine/src/gym/agents-defaults/*.md engine/test/gym-*.test.js \
      $(ls docs/verification/p4-mutations/* | grep -v README.md)

```
371d6cac74c75ac008942c28dee02438351d7ecef32416ced67c24195e014f5f  engine/src/gym/agent-files.js
3fe8fd092de9f666ac6e765a538c6bf35adc405bd9f6dd881df5c8db58cc818c  engine/src/gym/budget.js
8f763135b1a584f76efa4b080e89c38fac4b0644e36b63758e19d87a7d7d501d  engine/src/gym/cycle.js
31ded9ef38c14466a8fa7d22b5739dbfa8cb4a20cd84495f875d925839408d2c  engine/src/gym/exams.js
a233c422750bd1a88c65fbfe7a14938bc895ca20e75379fece3fed0e9a2065ab  engine/src/gym/gates.js
56dc33f9a4fc107f58446911c33a830eef8bcb94c44b27556d4ebba2350c344f  engine/src/gym/grading.js
e1500a6e6f7f6829a9fd85d227a94cf8276d6cda275b8b82a36d05c2857281f5  engine/src/gym/harvest.js
08e020422b0ec248561a87512abceac205d28f9e1bfe767196bdd105ef8974d8  engine/src/gym/ledger.js
0dfa4cd31200abb73dac41e8b93cf8d2ecb09130f098963814966327e28c8297  engine/src/gym/mining.js
6a1ea7e9d6845b7b93b2c6a8fd97ea4ccf96a0ba2e39269b41e66bb08c128768  engine/src/gym/prompt.js
cc967362c8e6e8ba8286caae25a2c6b0cebedfe03b21d504a942914bcc4a2440  engine/src/gym/provenance.js
78b0aa8224ebac6fbacc382a9394924be9115d34220d9a6a55d0ac3a16f60597  engine/src/gym/result-files.js
57ca7b4bb4946c29f85e044f497f3d619e8f276315f0377ffdbadfa5533a0a3b  engine/src/gym/run-mode.js
e1151dc4f7ca74f462043af607d575db63eaee4f287d069f59923380afa17c68  engine/src/gym/sandbox.js
425693fd833231e1e20530c250b9a4545f62f5d07556a7265b27aacd8fe97d6e  engine/src/gym/spend-gate.js
17daa19c7a0cd9d34a90220545ef83d879c3ff05d70dbf7cd1b4722dfe50b005  engine/src/gym/student-loop.js
a25f2336cfc8c9090cdadfd76e498241e6da4451c69dfced4d3cd64676043ffb  engine/src/gym/superseding.js
df9b5cecc85f5f31b17fb638b22222e98283aecba5c8ab812744a11c10dabc9e  engine/src/gym/RPC-SHAPES.md
f6f70c93ee4107298c86f1d75beb26b11a3fcce2ed9c28fd4c7027ef35c924e3  engine/src/gym/agents-defaults/auditor.md
1645258a6395d6e5db283bb83126bc8a24b6e486a1ac6948b5ff6397d7db69e0  engine/src/gym/agents-defaults/student.md
1892967ec2dc7a126950b0a1a8a7078b1349dcf90f618878344564eae0b840bd  engine/src/gym/agents-defaults/teacher.md
f7b8e3dae1400d84bc6ca619a6dc2ccc0d72f24fad3a675d12742f4124bfa657  engine/src/gym/agents-defaults/watcher.md
10f00af4ed71a5e9d1e819117dc17222334846d931530020232fea13710d7e0e  engine/test/gym-agent-files.test.js
daf8e57d3ca351ed5457f061ae44c8247c98b0ac534178970c123da1dab38404  engine/test/gym-budget.test.js
b5488c6ec01edc05dcbe9efcbd7c82b85b198ec1653d998257b45a9c38a20bc3  engine/test/gym-cycle.test.js
045aff93e4f7cce13bae3b0101f9510c06a219d52f6678e613640b80d79733b7  engine/test/gym-discipline.test.js
dfe587fb7f9eb8133e7debe4d90c44f1d216b3b236ef339042f6d2436819a3c5  engine/test/gym-grading.test.js
4834bba9aa63bbeb4b2ac3608a99fbb63f09dbf671cf18afde5e0532e09f69ca  engine/test/gym-harness.test.js
e6650cdb2eae627c12bbcbfb1aaf2bea7bcc030703e261d9fb77a9f6a3467494  engine/test/gym-harvest.test.js
eb34e69d70556bbd4266ac05e5345d6c7805416158e573d2826af7f2874c6982  engine/test/gym-ledger.test.js
574fd593a48afd80dd31b8b3e8c79f15f99c840f97027705314ea2b32767dbc3  engine/test/gym-mining.test.js
4915ea53510dca9f9174bb66c476cd99bdf6cbac2bed43fa62af26ececf6e4d6  engine/test/gym-mode-quarantine.test.js
7e9bfce6e5c663579fa712d72451510955e530cd6939d8b4dacf21dca4ae0809  engine/test/gym-provenance.test.js
32554d69de49df1ab983611a2cbd29ff93234f0f0335f1e96d041a70ab00e6e4  engine/test/gym-spend-gate.test.js
e6affd28f7130eb34bedca68e785744fee946bdc70bc2492019975ee62f377c9  docs/verification/p7-grading-harvest-acceptance-draft.md
8a1289e65707a5ba3b39ef9b599f899cd468e2af3b72233c5b9f40638ce7fe15  docs/verification/p7-grading-harvest-acceptance.md
f2ff54b05ae07116ac5f763fa7cc4f15457d826e7d6936dd780807feaab4ec34  docs/verification/p4-mutations/gate-plants-output.txt
e66ab1295c82a9c0a3ec6aa5fd9eb6dc87baf83dd6fbc0b4259b4578def35b8c  docs/verification/p4-mutations/gate-plants.mjs
5f9c2255ce54fb3ba743458a198098eb98ddf4eca8b50d73706509ad075f6b55  docs/verification/p4-mutations/gate-scanner-plants-output.txt
285369273763bd75ee7ec8b7732955cc8fe9dd8ab267ab979284d5f418b7d7ed  docs/verification/p4-mutations/gate-scanner-plants.mjs
ef01ba13f7d6a9872b068110c5cbafe538d5bb76d23bbbb235ceffbe8a3f033d  docs/verification/p4-mutations/mutate-output.txt
c20ec7912e678110131553cac229b41c4765c365867c7bcedb9c7058a4fccf4e  docs/verification/p4-mutations/mutate.sh
```

`gates.js` and `sandbox.js` are the extractor's ports, consumed unchanged and hashed here
only so the reviewed tree is complete.
