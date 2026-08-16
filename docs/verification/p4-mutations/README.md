# P4 verification evidence

Durable evidence for the P4 gym port: the mutation battery, the gate-scanner acceptance
instrument, and the captured output of both. Session scratch dies; the evidence should not.

| file | what it is |
| --- | --- |
| `mutate.sh` | the 26-mutation battery. Every line must read KILLED. |
| `mutate-output.txt` | its captured output, with the run timestamp in the header. |
| `gate-scanner-plants.mjs` | THE ARBITER for D-0023, authored by the VERIFIER, unmodified. Exit 0 is acceptance. |
| `gate-scanner-plants-output.txt` | its captured output run against the landed scanner. |
| `gate-plants.mjs` | gym-porter's extended plant set (12 plants, 4 controls), per the verifier's standing note that four plants is ten minutes of thought and not a bound. |
| `gate-plants-output.txt` | its captured output. |

## Measured 2026-08-16 08:46 JST (2026-08-15 23:46Z)

- `node docs/verification/p4-mutations/gate-scanner-plants.mjs`: caught 4/4 plants, control
  clean, ACCEPTANCE MET, exit 0. The verifier's four plants are also pinned inside
  `engine/test/gym-spend-gate.test.js` so `npm test` enforces the same bar; if the two ever
  disagree, the script wins and the test copy is the stale one.
- `node docs/verification/p4-mutations/gate-plants.mjs`: 12 plants, 4 controls, 0 failures.
- `bash docs/verification/p4-mutations/mutate.sh`: 26 mutations, 26 KILLED.
- `node --test "test/gym-*.test.js"` from `engine/`: tests 80, pass 80, fail 0.
- `npm test` from `engine/`: tests 400, pass 400, fail 0. Suite-count caveat per D-0014: the
  engine suite is written by several workers at once, so this is a timestamped snapshot of a
  moving total. 347, 373, 375, 393, 395 and 400 were each correct within an hour; none of the
  movement was in gym tests.
- Mutation battery history: two mutations SURVIVED on their first run and are recorded as
  prominently as the kills, because each was a test that looked like coverage and was not:
  1. The exam parser's quarantine-reason minimum. Only `quarantineExam()` covered it, so a
     record arriving by any other path (an RPC patch, a YAML import, a restored row) could
     have carried "broken" as its entire audit trail.
  2. The step-0 extension disable. The first version of the live test used a script whose
     first-edit check PASSED, so no boundary check would have run whatever the step was.
     Rewritten to satisfy every boundary condition except the step.

## Reading mtimes after a run

The battery restores each file with `mv file.bak file`. Content is byte-identical; mtime is
new. A tree that has had the battery run over it shows a wall of fresh mtimes with zero
content change, so during a verification hold this directory is a trap for anyone bounding
drift by timestamp. Bound drift by hash.

## The repository has no commits

`git log` on this repo reports no commits at all, so NOTHING here has history: no worker can
prove a past byte state, and every byte-check is a read of a live, concurrently edited
working tree. The hash manifest below is the only fixed point this evidence has, which is
why it is refreshed with every report rather than written once.

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
6a5c2f009787102ff5b2c4748a09686a3229d582a9348a0e874781581184d6cb  engine/src/gym/budget.js
8974cbeff54b7e72c3a6ca419fe4d12f4720aec70f8d24930c354f1939f7b918  engine/src/gym/cycle.js
93343ecad52a55e47a933a070247f3c15164f72fd34fc1299ae27b01189ab1e3  engine/src/gym/exams.js
a233c422750bd1a88c65fbfe7a14938bc895ca20e75379fece3fed0e9a2065ab  engine/src/gym/gates.js
57db60c3c0c0d7d6dcc6ba824fb6ca2e317c83b79d57225c99f6f63a5d3574e1  engine/src/gym/ledger.js
0dfa4cd31200abb73dac41e8b93cf8d2ecb09130f098963814966327e28c8297  engine/src/gym/mining.js
6a1ea7e9d6845b7b93b2c6a8fd97ea4ccf96a0ba2e39269b41e66bb08c128768  engine/src/gym/prompt.js
78b0aa8224ebac6fbacc382a9394924be9115d34220d9a6a55d0ac3a16f60597  engine/src/gym/result-files.js
57ca7b4bb4946c29f85e044f497f3d619e8f276315f0377ffdbadfa5533a0a3b  engine/src/gym/run-mode.js
e1151dc4f7ca74f462043af607d575db63eaee4f287d069f59923380afa17c68  engine/src/gym/sandbox.js
8037cf9d631169b21244298356e0f8b1e3ad4d9974a79119a8f500e7e4fd61b2  engine/src/gym/spend-gate.js
200b2c3d262981e3875b7bef31272cc68c36f0901f5feced34e9fa00f1a40f58  engine/src/gym/student-loop.js
a25f2336cfc8c9090cdadfd76e498241e6da4451c69dfced4d3cd64676043ffb  engine/src/gym/superseding.js
f6f70c93ee4107298c86f1d75beb26b11a3fcce2ed9c28fd4c7027ef35c924e3  engine/src/gym/agents-defaults/auditor.md
1645258a6395d6e5db283bb83126bc8a24b6e486a1ac6948b5ff6397d7db69e0  engine/src/gym/agents-defaults/student.md
1892967ec2dc7a126950b0a1a8a7078b1349dcf90f618878344564eae0b840bd  engine/src/gym/agents-defaults/teacher.md
f7b8e3dae1400d84bc6ca619a6dc2ccc0d72f24fad3a675d12742f4124bfa657  engine/src/gym/agents-defaults/watcher.md
10f00af4ed71a5e9d1e819117dc17222334846d931530020232fea13710d7e0e  engine/test/gym-agent-files.test.js
06b9d132925cee0ac6c3ea7a1fec8d66c63e619d07b7dbcd1aa6d75602f4ee96  engine/test/gym-budget.test.js
4b4410fa64d52c8978fe358e6be43a0f3cf67d7691980b86477d465d11bab93c  engine/test/gym-cycle.test.js
4834bba9aa63bbeb4b2ac3608a99fbb63f09dbf671cf18afde5e0532e09f69ca  engine/test/gym-harness.test.js
dba2fcbffcb390fb9220ac922dcfc3e2e6695e4701734239fc9e78184b156f19  engine/test/gym-ledger.test.js
574fd593a48afd80dd31b8b3e8c79f15f99c840f97027705314ea2b32767dbc3  engine/test/gym-mining.test.js
6ef2eba37ae8660340fcf86e8665047965c28bf5551c9dbd0a0a5826c09fc5ae  engine/test/gym-mode-quarantine.test.js
815dd5a08269f0432ab98e74fd7dfb401cfc83f01207dddce19e5379ed8f3b50  engine/test/gym-spend-gate.test.js
f2ff54b05ae07116ac5f763fa7cc4f15457d826e7d6936dd780807feaab4ec34  docs/verification/p4-mutations/gate-plants-output.txt
e66ab1295c82a9c0a3ec6aa5fd9eb6dc87baf83dd6fbc0b4259b4578def35b8c  docs/verification/p4-mutations/gate-plants.mjs
5f9c2255ce54fb3ba743458a198098eb98ddf4eca8b50d73706509ad075f6b55  docs/verification/p4-mutations/gate-scanner-plants-output.txt
285369273763bd75ee7ec8b7732955cc8fe9dd8ab267ab979284d5f418b7d7ed  docs/verification/p4-mutations/gate-scanner-plants.mjs
96c476beea1ebc9fa1e8d75a426e8f8dbfddf339d2a4efb12bf9c1130f44d228  docs/verification/p4-mutations/mutate-output.txt
6aa21653847bfce4b3b6c59fe9f1de57491b96d39d617395e00efe599dfdf7e0  docs/verification/p4-mutations/mutate.sh
```

`gates.js` and `sandbox.js` are the extractor's ports, consumed unchanged and hashed here
only so the reviewed tree is complete.
