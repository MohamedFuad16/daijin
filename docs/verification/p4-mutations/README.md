# P4 verification evidence

Durable evidence for the P4 gym port: the mutation battery, the gate-scanner acceptance
instrument, and the captured output of both. Session scratch dies; the evidence should not.

| file | what it is |
| --- | --- |
| `mutate.sh` | the 57-mutation battery, P4 and P7. Every line must read KILLED. |
| `mutate-output.txt` | its captured output, with the run timestamp in the header. |
| `gate-scanner-plants.mjs` | THE ARBITER for D-0023, authored by the VERIFIER, unmodified. Exit 0 is acceptance. |
| `gate-scanner-plants-output.txt` | its captured output run against the landed scanner. |
| `gate-plants.mjs` | gym-porter's extended plant set (12 plants, 4 controls), per the verifier's standing note that four plants is ten minutes of thought and not a bound. |
| `gate-plants-output.txt` | its captured output. |

## Measured 2026-08-16 12:44 JST (2026-08-16 03:44Z)

- `node docs/verification/p4-mutations/gate-scanner-plants.mjs`: caught 4/4 plants, control
  clean, ACCEPTANCE MET, exit 0. The verifier's four plants are also pinned inside
  `engine/test/gym-spend-gate.test.js` so `npm test` enforces the same bar; if the two ever
  disagree, the script wins and the test copy is the stale one.
- `node docs/verification/p4-mutations/gate-plants.mjs`: 12 plants, 4 controls, 0 failures.
- `bash docs/verification/p4-mutations/mutate.sh`: 57 mutations, 57 KILLED (nine added for the
  gold-provenance exclusion, four for the pre-seal check, eighteen for P7 grading and harvest).
- `node --test "test/gym-*.test.js"` from `engine/`: tests 122, pass 122, fail 0.
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
  3. P7 clause 18's provider scan. Its positive control was ONE example that matched four
     alternatives of the pattern at once (a fetch, to an https URL, with a Bearer header), so
     neutering any single branch left the control green. Rewritten as a table exercising every
     branch separately. A positive control that passes for the wrong reason is a gate that
     cannot fail, one level up.

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
74a8308a03dc8162065041441ab16468654cee8290e3bfa670c3fb61d30d7b50  engine/src/gym/exams.js
a233c422750bd1a88c65fbfe7a14938bc895ca20e75379fece3fed0e9a2065ab  engine/src/gym/gates.js
56dc33f9a4fc107f58446911c33a830eef8bcb94c44b27556d4ebba2350c344f  engine/src/gym/grading.js
e1500a6e6f7f6829a9fd85d227a94cf8276d6cda275b8b82a36d05c2857281f5  engine/src/gym/harvest.js
928487c1328796b8fafcd731ea605bfee8da1974ff63bfa682297a92e8b4e24d  engine/src/gym/ledger.js
0dfa4cd31200abb73dac41e8b93cf8d2ecb09130f098963814966327e28c8297  engine/src/gym/mining.js
6a1ea7e9d6845b7b93b2c6a8fd97ea4ccf96a0ba2e39269b41e66bb08c128768  engine/src/gym/prompt.js
cc967362c8e6e8ba8286caae25a2c6b0cebedfe03b21d504a942914bcc4a2440  engine/src/gym/provenance.js
78b0aa8224ebac6fbacc382a9394924be9115d34220d9a6a55d0ac3a16f60597  engine/src/gym/result-files.js
57ca7b4bb4946c29f85e044f497f3d619e8f276315f0377ffdbadfa5533a0a3b  engine/src/gym/run-mode.js
e1151dc4f7ca74f462043af607d575db63eaee4f287d069f59923380afa17c68  engine/src/gym/sandbox.js
8037cf9d631169b21244298356e0f8b1e3ad4d9974a79119a8f500e7e4fd61b2  engine/src/gym/spend-gate.js
17daa19c7a0cd9d34a90220545ef83d879c3ff05d70dbf7cd1b4722dfe50b005  engine/src/gym/student-loop.js
a25f2336cfc8c9090cdadfd76e498241e6da4451c69dfced4d3cd64676043ffb  engine/src/gym/superseding.js
42658266a39bb8a46287c22f2d689c0a3064ce11ba8d4181a587777d9ea660f0  engine/src/gym/RPC-SHAPES.md
f6f70c93ee4107298c86f1d75beb26b11a3fcce2ed9c28fd4c7027ef35c924e3  engine/src/gym/agents-defaults/auditor.md
1645258a6395d6e5db283bb83126bc8a24b6e486a1ac6948b5ff6397d7db69e0  engine/src/gym/agents-defaults/student.md
1892967ec2dc7a126950b0a1a8a7078b1349dcf90f618878344564eae0b840bd  engine/src/gym/agents-defaults/teacher.md
f7b8e3dae1400d84bc6ca619a6dc2ccc0d72f24fad3a675d12742f4124bfa657  engine/src/gym/agents-defaults/watcher.md
10f00af4ed71a5e9d1e819117dc17222334846d931530020232fea13710d7e0e  engine/test/gym-agent-files.test.js
daf8e57d3ca351ed5457f061ae44c8247c98b0ac534178970c123da1dab38404  engine/test/gym-budget.test.js
d96314398fff24b3237d15d4d40a705c1a138b4ee5f97d32b5041bd5daa3f2a1  engine/test/gym-cycle.test.js
824a19985b7e74d10c81ea353e41627e7838b0dd08c2d035fb014b407f0afbae  engine/test/gym-discipline.test.js
dfe587fb7f9eb8133e7debe4d90c44f1d216b3b236ef339042f6d2436819a3c5  engine/test/gym-grading.test.js
4834bba9aa63bbeb4b2ac3608a99fbb63f09dbf671cf18afde5e0532e09f69ca  engine/test/gym-harness.test.js
e6650cdb2eae627c12bbcbfb1aaf2bea7bcc030703e261d9fb77a9f6a3467494  engine/test/gym-harvest.test.js
f00941aaf3120581bb353066e1776dac2d40c917e344779c38faa78f669974fe  engine/test/gym-ledger.test.js
574fd593a48afd80dd31b8b3e8c79f15f99c840f97027705314ea2b32767dbc3  engine/test/gym-mining.test.js
8a459f73207d735996a234164522be13b88d6d79cddd80ac4a4d348b02727bfd  engine/test/gym-mode-quarantine.test.js
7e9bfce6e5c663579fa712d72451510955e530cd6939d8b4dacf21dca4ae0809  engine/test/gym-provenance.test.js
a95c032655750ff701dc5c13c0de8610f236e60f7c2512c5832c09b548da77d5  engine/test/gym-spend-gate.test.js
e6affd28f7130eb34bedca68e785744fee946bdc70bc2492019975ee62f377c9  docs/verification/p7-grading-harvest-acceptance-draft.md
8a1289e65707a5ba3b39ef9b599f899cd468e2af3b72233c5b9f40638ce7fe15  docs/verification/p7-grading-harvest-acceptance.md
f2ff54b05ae07116ac5f763fa7cc4f15457d826e7d6936dd780807feaab4ec34  docs/verification/p4-mutations/gate-plants-output.txt
e66ab1295c82a9c0a3ec6aa5fd9eb6dc87baf83dd6fbc0b4259b4578def35b8c  docs/verification/p4-mutations/gate-plants.mjs
5f9c2255ce54fb3ba743458a198098eb98ddf4eca8b50d73706509ad075f6b55  docs/verification/p4-mutations/gate-scanner-plants-output.txt
285369273763bd75ee7ec8b7732955cc8fe9dd8ab267ab979284d5f418b7d7ed  docs/verification/p4-mutations/gate-scanner-plants.mjs
37169e2448ae0da06d8c1636c7e22135b0e31f6e758d58fbe223cceff2f27e8e  docs/verification/p4-mutations/mutate-output.txt
545e1cbb6e4185d14fa5cf7e9f16c660e068135a0c72a823b54ec6dd0914bc93  docs/verification/p4-mutations/mutate.sh
```

`gates.js` and `sandbox.js` are the extractor's ports, consumed unchanged and hashed here
only so the reviewed tree is complete.
