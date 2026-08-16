// The exam mining funnel: deterministic filter, superseding detection, the auditor boundary,
// and the expensive validation that runs only on the chosen.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deterministicFilterReason, mineCommits, parseNumstat, scopeTier, selectBankWithAuditor, validateChosenExam,
} from '../src/gym/mining.js';
import { applySupersedingRule, fileOverlap, isRevertOf, supersedingRelations } from '../src/gym/superseding.js';

function commit(overrides = {}) {
  return {
    subject: 'feat(sync): move one datum across the seam',
    entries: [{ added: 20, deleted: 3, binary: false, renamed: false, file: 'src/sync.js' }],
    files: ['src/sync.js'],
    changedLines: 23,
    parents: 1,
    ...overrides,
  };
}

test('numstat parsing keeps renames, binaries, and both rename spellings', () => {
  const parsed = parseNumstat([
    '20\t3\tsrc/sync.js',
    '0\t0\tsrc/old.js => src/new.js',
    '0\t0\tsrc/{a.js => b.js}',
    '-\t-\tassets/logo.png',
  ].join('\n'));
  assert.deepEqual(parsed.files, ['src/sync.js', 'src/new.js', 'src/b.js', 'assets/logo.png']);
  assert.equal(parsed.entries[1].renamed, true);
  assert.equal(parsed.entries[2].renamed, true);
  assert.equal(parsed.entries[3].binary, true);
  assert.equal(parsed.changedLines, 23, 'a binary file contributes no line count to pretend with');
});

test('the deterministic filter drops what it says it drops, and names the reason', () => {
  assert.equal(deterministicFilterReason(commit()), null);

  const cases = [
    [{ parents: 2 }, /single-parent/],
    [{ entries: [], files: [] }, /empty change/],
    [{
      entries: [{ added: 0, deleted: 0, renamed: true, file: 'src/new.js' }], files: ['src/new.js'],
    }, /rename only/],
    [{ whitespaceInsensitiveChangedLines: 0 }, /format only \(no change under whitespace/],
    [{ subject: 'style: reformat everything with prettier' }, /format only \(by subject\)/],
    [{ files: ['package-lock.json'], entries: [{ added: 900, deleted: 900, file: 'package-lock.json' }] }, /lockfile only/],
    [{ files: ['docs/architecture.md'], entries: [{ added: 9, deleted: 1, file: 'docs/architecture.md' }] }, /documentation only/],
    [{ subject: 'docs: explain the seam' }, /documentation, agent wiring/],
    [{
      files: ['assets/logo.png'], entries: [{ added: 0, deleted: 0, binary: true, file: 'assets/logo.png' }],
    }, /binary only/],
    [{ files: Array.from({ length: 60 }, (unused, index) => `src/f${index}.js`) }, /giant mixed commit/],
    [{ changedLines: 3_000 }, /giant mixed commit/],
  ];
  for (const [overrides, expected] of cases) {
    assert.match(deterministicFilterReason(commit(overrides)) || '', expected);
  }

  // The measured form beats the subject form: a commit whose subject says "formatting" but
  // which changes real code under a whitespace-insensitive diff is KEPT.
  assert.equal(deterministicFilterReason(commit({
    subject: 'style: reformat everything with prettier', whitespaceInsensitiveChangedLines: 12,
  })), null);
});

test('mineCommits walks the log, reports the cap, and never truncates silently', async () => {
  const record = (commitId, date, subject, numstat) => `\x1e${commitId}\x1f${'p'.repeat(40)}\x1f${date}\x1f${subject}\x1f\n${numstat}\n`;
  const log = [
    record('c'.repeat(40), '2026-08-16T10:00:00Z', 'feat(sync): wire the route', '20\t3\tsrc/sync.js'),
    record('d'.repeat(40), '2026-08-15T10:00:00Z', 'chore(deps): bump the lockfile', '900\t900\tpackage-lock.json'),
    record('e'.repeat(40), '2026-08-14T10:00:00Z', 'feat(api): add the endpoint', '30\t2\tsrc/api.js'),
  ].join('');
  const exec = async () => ({ stdout: log });

  const all = await mineCommits('/repo', { exec });
  assert.deepEqual(all.candidates.map((item) => item.subject), ['feat(sync): wire the route', 'feat(api): add the endpoint']);
  assert.deepEqual(all.dropped.map((item) => item.reason), ['generated or lockfile only']);
  assert.deepEqual(all.capped, { applied: false, limit: 2_000, seen: 3, walked: 3 });

  const capped = await mineCommits('/repo', { exec, cap: 2 });
  assert.deepEqual(capped.capped, { applied: true, limit: 2, seen: 3, walked: 2 });
  assert.equal(capped.candidates.length, 1, 'the third commit was never looked at, and the record says so');
});

test('superseding detection is deterministic: overlap and revert, both with the arrow of time', () => {
  assert.equal(fileOverlap(['a', 'b'], ['a', 'b']), 1);
  assert.equal(fileOverlap(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(fileOverlap([], ['a']), 0);

  const original = { commit: 'aaa', subject: 'feat: add sync', entries: [{ file: 'src/sync.js', added: 20, deleted: 3 }] };
  const reverted = { commit: 'bbb', subject: 'Revert "feat: add sync"', entries: [{ file: 'src/sync.js', added: 3, deleted: 20 }] };
  assert.equal(isRevertOf(reverted, original), 'revert-subject');
  // The second signal stands alone: an inverted numstat over the identical file set is a
  // revert whatever the subject line calls itself.
  assert.equal(isRevertOf({ ...reverted, subject: 'fix: back that out' }, original), 'inverted-numstat');
  assert.equal(isRevertOf({ ...reverted, subject: 'fix: back that out', entries: [{ file: 'src/other.js', added: 3, deleted: 20 }] }, original), null);

  const candidates = [
    { commit: 'aaa', date: '2026-08-10', subject: 'feat: add sync', files: ['src/sync.js'], entries: original.entries },
    { commit: 'bbb', date: '2026-08-11', subject: 'refactor: rewrite sync', files: ['src/sync.js'], entries: [{ file: 'src/sync.js', added: 40, deleted: 20 }] },
    { commit: 'ccc', date: '2026-08-12', subject: 'feat: unrelated', files: ['src/other.js'], entries: [{ file: 'src/other.js', added: 5, deleted: 0 }] },
  ];
  const relations = supersedingRelations(candidates);
  assert.deepEqual(relations, [{ earlier: 'aaa', later: 'bbb', kind: 'overlap', signal: 'file-overlap', overlap: 1 }]);
  assert.deepEqual(supersedingRelations(candidates, { overlapThreshold: 1.1 }), [], 'the threshold is a real knob');
});

test('latest wins by default; the superseded commit becomes brain material rather than vanishing', () => {
  const candidates = [
    { commit: 'aaa', date: '2026-08-10', subject: 'feat: add sync', files: ['src/sync.js'], entries: [{ file: 'src/sync.js', added: 20, deleted: 3 }] },
    { commit: 'bbb', date: '2026-08-11', subject: 'refactor: rewrite sync', files: ['src/sync.js'], entries: [{ file: 'src/sync.js', added: 40, deleted: 20 }] },
  ];
  const relations = supersedingRelations(candidates);
  const { bank, layer2Material } = applySupersedingRule(candidates, relations);
  assert.deepEqual(bank.map((item) => item.commit), ['bbb']);
  assert.deepEqual(layer2Material, [{
    commit: 'aaa',
    subject: 'feat: add sync',
    files: ['src/sync.js'],
    reason: 'superseded-by-later-commit',
    supersededBy: 'bbb',
    signal: 'file-overlap',
    overlap: 1,
  }]);
});

test('an auditor override keeps a partial overlap and records its reasoning; a revert cannot be overridden', () => {
  const candidates = [
    { commit: 'aaa', date: '2026-08-10', subject: 'feat: add sync', files: ['src/sync.js', 'src/a.js'], entries: [{ file: 'src/sync.js', added: 20, deleted: 3 }] },
    { commit: 'bbb', date: '2026-08-11', subject: 'refactor: rewrite sync', files: ['src/sync.js', 'src/b.js'], entries: [{ file: 'src/sync.js', added: 40, deleted: 20 }] },
  ];
  const relations = supersedingRelations(candidates, { overlapThreshold: 0.3 });
  assert.equal(relations.length, 1);

  const kept = applySupersedingRule(candidates, relations, {
    overrides: [{ commit: 'aaa', rationale: 'The overlap is one shared file; the two commits solve different clauses.' }],
  });
  assert.deepEqual(kept.bank.map((item) => item.commit), ['aaa', 'bbb']);
  assert.deepEqual(kept.bank[0].provenanceNote, {
    kind: 'auditor-override',
    rationale: 'The overlap is one shared file; the two commits solve different clauses.',
  });
  assert.deepEqual(kept.layer2Material, []);

  assert.throws(
    () => applySupersedingRule(candidates, relations, { overrides: [{ commit: 'aaa', rationale: 'because' }] }),
    /needs a rationale of at least 20 characters/,
  );
  assert.throws(() => applySupersedingRule(candidates, relations, { overrides: [{ rationale: 'x'.repeat(30) }] }), /must name a commit/);

  const revertPair = [
    { commit: 'aaa', date: '2026-08-10', subject: 'feat: add sync', files: ['src/sync.js'], entries: [{ file: 'src/sync.js', added: 20, deleted: 3 }] },
    { commit: 'bbb', date: '2026-08-11', subject: 'Revert "feat: add sync"', files: ['src/sync.js'], entries: [{ file: 'src/sync.js', added: 3, deleted: 20 }] },
  ];
  assert.throws(
    () => applySupersedingRule(revertPair, supersedingRelations(revertPair), {
      overrides: [{ commit: 'aaa', rationale: 'I would like to keep this one despite the revert.' }],
    }),
    /a reverted gold is not a measurement/,
  );
});

test('the auditor step is the only judgment, and it refuses to be approximated', async () => {
  const candidates = [
    { commit: 'aaa', date: '2026-08-10', subject: 'feat: add sync', files: ['src/sync.js'], entries: [{ file: 'src/sync.js', added: 20, deleted: 3 }] },
    { commit: 'bbb', date: '2026-08-11', subject: 'feat: unrelated', files: ['src/other.js'], entries: [{ file: 'src/other.js', added: 5, deleted: 0 }] },
  ];
  await assert.rejects(selectBankWithAuditor({ candidates }), (error) => {
    assert.equal(error.code, 'AUDITOR_NOT_WIRED');
    // The deterministic halves around the stub are complete and travel with the refusal, so
    // the caller can show the funnel's work without the judgment.
    assert.deepEqual(error.eligible.map((item) => item.commit), ['aaa', 'bbb']);
    assert.deepEqual(error.relations, []);
    return true;
  });

  // With an auditor injected, the selection passes the spend gate first: this is the one
  // paid step in the funnel.
  const gateCalls = [];
  const selected = await selectBankWithAuditor({
    candidates,
    auditor: { selectExamBank: async () => ({ chosen: [{ commit: 'bbb', rationale: 'coherent single intent', heldOut: true }] }) },
    repoPath: '/repo',
  }, { assertSpendGate: async (scope) => { gateCalls.push(scope); return { open: true }; } });
  assert.deepEqual(gateCalls, ['exam-mining']);
  assert.deepEqual(selected.chosen.map((item) => item.commit), ['bbb']);
  assert.equal(selected.chosen[0].heldOut, true);
  assert.equal(selected.chosen[0].auditorRationale, 'coherent single intent');

  // The auditor proposes; mechanics accept. A selection naming a commit the deterministic
  // stage dropped is refused rather than reinstated.
  await assert.rejects(selectBankWithAuditor({
    candidates,
    auditor: { selectExamBank: async () => ({ chosen: [{ commit: 'zzz' }] }) },
    repoPath: '/repo',
  }, { assertSpendGate: async () => ({ open: true }) }), /which is not an eligible candidate/);
});

test('expensive validation runs at base, refuses a broken baseline, and re-derives the scope from the real diff', async () => {
  const cleanups = [];
  const dependencies = {
    createSandbox: async ({ baseCommit }) => ({
      directory: `/sandbox/${baseCommit.slice(0, 6)}`,
      cleanup: async () => { cleanups.push(baseCommit); },
    }),
    expandGates: (gates) => gates,
    runGateSet: async () => [{ id: 'lint', status: 'pass' }, { id: 'test', status: 'pass' }],
    diffStat: async () => '30\t4\tsrc/sync.js\n12\t0\tsrc/route.js\n',
  };
  const candidate = { examId: 'exam-0001', baseCommit: 'a'.repeat(40), goldCommit: 'b'.repeat(40) };

  const ok = await validateChosenExam({ candidate, sourceRepo: '/repo', gates: [{ id: 'lint' }], sandboxesRoot: '/s' }, dependencies);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.scope, { files: 2, insertions: 42, tier: 'S' });
  assert.deepEqual(ok.forbiddenStrings, ['b'.repeat(40), 'b'.repeat(12)]);
  assert.deepEqual(cleanups, ['a'.repeat(40)], 'the worktree is removed whatever the verdict');

  // A baseline that does not pass makes a candidate run uninterpretable: a regression and a
  // repository that was already broken would look the same.
  const broken = await validateChosenExam({ candidate, sourceRepo: '/repo', gates: [{ id: 'lint' }], sandboxesRoot: '/s' }, {
    ...dependencies,
    runGateSet: async () => [{ id: 'lint', status: 'pass' }, { id: 'test', status: 'fail' }],
  });
  assert.equal(broken.ok, false);
  assert.match(broken.failures[0], /baseline gates do not pass at a{40}: test=fail/);

  const empty = await validateChosenExam({ candidate, sourceRepo: '/repo', gates: [{ id: 'lint' }], sandboxesRoot: '/s' }, {
    ...dependencies, diffStat: async () => '',
  });
  assert.equal(empty.ok, false);
  assert.match(empty.failures[0], /real diff between base and gold is empty/);
  assert.equal(empty.scope.tier, null);
});

test('scope tier is computed from the diff, not declared', () => {
  assert.equal(scopeTier({ files: 1, insertions: 10 }), 'S');
  assert.equal(scopeTier({ files: 2, insertions: 200 }), 'S');
  assert.equal(scopeTier({ files: 3, insertions: 40 }), 'M');
  assert.equal(scopeTier({ files: 6, insertions: 10 }), 'L');
  assert.equal(scopeTier({ files: 2, insertions: 201 }), 'L');
  assert.throws(() => scopeTier({ files: 0, insertions: 1 }), /positive integer/);
});
