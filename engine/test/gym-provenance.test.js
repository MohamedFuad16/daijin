// Gold-provenance exclusion: the retrieval-side half of "the student never sees gold".
//
// Driven against a REAL temp git repository, because every rule here is a question about a
// commit and a fake git would be testing the fake. Zero spend, no network.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  MAX_EXCLUDED_DOCUMENT_IDS, computeGoldProvenanceExclusions, directGoldReason, exclusionRecord,
  hasExclusionRecord, markdownAnchor, sectionAtAnchor, sourceReferenceParts, splitSections,
} from '../src/gym/provenance.js';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

/**
 * A repository whose GOLD commit does three leaking things at once:
 *  - edits one section of a cited document and leaves another alone,
 *  - adds a brand new document,
 *  - and is referenced by an existing evaluation record.
 */
async function repoWithLeakyGold(root) {
  const repo = path.join(root, 'source');
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'user.name', 'Test']);

  await writeFile(path.join(repo, 'docs/architecture.md'),
    '# Architecture\n\n## The sync seam\n\nNothing crosses it yet.\n\n## Untouched area\n\nStable prose.\n', 'utf8');
  await writeFile(path.join(repo, 'app.js'), 'const value = 1;\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'base']);
  const baseCommit = await git(repo, ['rev-parse', 'HEAD']);

  await writeFile(path.join(repo, 'docs/architecture.md'),
    '# Architecture\n\n## The sync seam\n\nThe route is registered in app.js and the client reads it.\n\n## Untouched area\n\nStable prose.\n', 'utf8');
  await writeFile(path.join(repo, 'docs/decision-0007.md'), '# Wire the sync seam\n\nThis is how it was done.\n', 'utf8');
  await writeFile(path.join(repo, 'app.js'), 'const value = 1;\nexport const wired = true;\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'gold: wire the sync seam']);
  const goldCommit = await git(repo, ['rev-parse', 'HEAD']);
  return { repo, baseCommit, goldCommit };
}

function exam(baseCommit, goldCommit) {
  return { examId: 'exam-0001', baseCommit, goldCommit };
}

async function withRepo(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-provenance-'));
  try {
    return await run(root, await repoWithLeakyGold(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('markdown anchors and sections match what generated the source references', () => {
  assert.equal(markdownAnchor('The sync seam'), 'the-sync-seam');
  assert.equal(markdownAnchor('D-0007: `wire` the seam!'), 'd-0007-wire-the-seam');
  assert.deepEqual(sourceReferenceParts('web:docs/architecture.md#the-sync-seam'),
    { branch: 'web', file: 'docs/architecture.md', anchor: 'the-sync-seam' });
  assert.equal(sourceReferenceParts('docs/architecture.md'), null);
  assert.equal(sourceReferenceParts(null), null);

  const markdown = '# Top\n\nintro\n\n## One\n\nfirst\n\n### Nested\n\ndeep\n\n## Two\n\nsecond\n';
  const sections = splitSections(markdown);
  assert.deepEqual(sections.map((section) => section.title), ['Top', 'One', 'Nested', 'Two']);
  // A subsection travels with its parent, so an edit inside Nested changes One's section too.
  assert.match(sections[1].content, /deep/);
  assert.doesNotMatch(sections[1].content, /second/);
  assert.equal(sectionAtAnchor(markdown, 'root'), markdown, 'root means the whole document');
  assert.equal(sectionAtAnchor(markdown, 'nowhere'), null);
});

test('rule 1, direct: a document that names the gold commit or the exam is excluded', () => {
  const target = exam('a'.repeat(40), 'b'.repeat(40));
  const cases = [
    [{ id: 'd1', meta: { source: `web:docs/x.md@${'b'.repeat(40)}` } }, 'front-matter-gold-commit'],
    [{ id: 'd2', meta: { commit: 'b'.repeat(40) } }, 'front-matter-gold-commit'],
    [{ id: 'd3', meta: { exam: 'exam-0001' } }, 'evaluation-of-exam'],
    [{ id: 'd4', meta: { exam_id: 'exam-0001' } }, 'evaluation-of-exam'],
    [{ id: 'd5', meta: { evaluation_of: 'exam-0001' } }, 'evaluation-of-exam'],
    [{ id: 'd6', meta: { exam_ids: ['exam-0002', 'exam-0001'] } }, 'evaluation-of-exam'],
    [{ id: 'd7', type: 'evaluation', content: 'the run for exam-0001 scored 3', meta: {} }, 'evaluation-content-exam'],
  ];
  for (const [document, reason] of cases) {
    assert.equal(directGoldReason(document, target), reason, `expected ${reason} for ${document.id}`);
  }
  // The gym writes lessons back every cycle, so these accumulate; an unrelated one stays in.
  assert.equal(directGoldReason({ id: 'ok', type: 'lesson', content: 'about exam-0009', meta: {} }, target), null);
  assert.equal(directGoldReason({ id: 'ok2', meta: { commit: 'c'.repeat(40) } }, target), null);
});

test('rule 2, section granularity: the changed section is excluded and its neighbour is not', async () => {
  await withRepo(async (root, { repo, baseCommit, goldCommit }) => {
    const documents = [
      { id: 'seam', path: 'brain/seam.md', meta: { source: 'web:docs/architecture.md#the-sync-seam' }, content: '' },
      { id: 'untouched', path: 'brain/untouched.md', meta: { source: 'web:docs/architecture.md#untouched-area' }, content: '' },
      { id: 'elsewhere', path: 'brain/elsewhere.md', meta: { source: 'web:docs/other.md#anything' }, content: '' },
    ];
    const exclusion = await computeGoldProvenanceExclusions({
      exam: exam(baseCommit, goldCommit), documents, sourceRepo: repo,
    });
    assert.deepEqual(exclusion.ids, ['seam']);
    assert.equal(exclusion.reasons.seam, 'source-section-changed-by-gold');
    // This is the distinction the platform learned rather than assumed: excluding every
    // document sourced from a touched FILE would strip context the student is meant to have.
    assert.ok(!exclusion.ids.includes('untouched'));
  });
});

test('rule 3: a document whose file the gold commit ADDED cannot be legitimate context at base', async () => {
  await withRepo(async (root, { repo, baseCommit, goldCommit }) => {
    const documents = [
      { id: 'new-decision', path: 'docs/decision-0007.md', meta: {}, content: '' },
      { id: 'old-app', path: 'app.js', meta: {}, content: '' },
    ];
    const exclusion = await computeGoldProvenanceExclusions({
      exam: exam(baseCommit, goldCommit), documents, sourceRepo: repo,
    });
    assert.deepEqual(exclusion.ids, ['new-decision']);
    assert.equal(exclusion.reasons['new-decision'], 'brain-commit-introduced-by-gold');
    // app.js was MODIFIED by gold, not introduced by it, and it existed at base.
    assert.ok(!exclusion.ids.includes('old-app'));
  });
});

test('rule 3 answers about the GOLD commit, not about whatever branch is checked out', async () => {
  // THE EXCLUSION WAS SCOPED TO HEAD. `git log` with no revision walks from HEAD, so rule 3
  // asked "was this file added on the branch that happens to be checked out?" instead of
  // "did gold add it?". Whenever the gold commit is not reachable from HEAD - a feature
  // branch, a detached HEAD, a squash-merge that orphaned the SHA - rule 3 found nothing,
  // the record still stamped `computed: true` with count 0, and the student was handed the
  // document the gold commit wrote while certify()'s hasExclusionRecord gate passed. The
  // run then certifies "the student never saw gold" about a run in which it did.
  //
  // The control is the SAME repo, the SAME exam and the SAME documents, differing only in
  // which branch HEAD points at: without it, a passing assertion proves nothing about
  // scoping, because the fixture's HEAD sits on gold.
  await withRepo(async (root, { repo, baseCommit, goldCommit }) => {
    const documents = [{ id: 'new-decision', path: 'docs/decision-0007.md', meta: {}, content: '' }];
    const onGold = await computeGoldProvenanceExclusions({
      exam: exam(baseCommit, goldCommit), documents, sourceRepo: repo,
    });
    assert.deepEqual(onGold.ids, ['new-decision'], 'control: reachable from HEAD, the rule fires');

    // Move HEAD to a branch forked from BASE, so gold is no longer an ancestor of HEAD.
    await git(repo, ['checkout', '-q', '-b', 'feature', baseCommit]);
    const offGold = await computeGoldProvenanceExclusions({
      exam: exam(baseCommit, goldCommit), documents, sourceRepo: repo,
    });
    assert.deepEqual(offGold.ids, ['new-decision'],
      'the gold commit introduced this file whatever branch the working tree is on');
    assert.equal(offGold.reasons['new-decision'], 'brain-commit-introduced-by-gold');
  });
});

test('all three rules together, and each id records the rule that caught it', async () => {
  await withRepo(async (root, { repo, baseCommit, goldCommit }) => {
    const documents = [
      { id: 'evaluation', type: 'evaluation', path: 'brain/eval.md', meta: {}, content: 'run of exam-0001' },
      { id: 'seam', path: 'brain/seam.md', meta: { source: 'web:docs/architecture.md#the-sync-seam' }, content: '' },
      { id: 'new-decision', path: 'docs/decision-0007.md', meta: {}, content: '' },
      { id: 'innocent', path: 'brain/innocent.md', meta: { source: 'web:docs/architecture.md#untouched-area' }, content: '' },
    ];
    const exclusion = await computeGoldProvenanceExclusions({
      exam: exam(baseCommit, goldCommit), documents, sourceRepo: repo,
    });
    assert.deepEqual(exclusion.ids, ['evaluation', 'new-decision', 'seam'], 'sorted, so the record is stable');
    assert.deepEqual(exclusion.reasons, {
      evaluation: 'evaluation-content-exam',
      seam: 'source-section-changed-by-gold',
      'new-decision': 'brain-commit-introduced-by-gold',
    });
    assert.equal(exclusion.truncated, false);

    // An empty brain is a legitimate result, not an error: the exclusion is computed and
    // finds nothing, which is a different state from never having computed it.
    const empty = await computeGoldProvenanceExclusions({
      exam: exam(baseCommit, goldCommit), documents: [], sourceRepo: repo,
    });
    assert.deepEqual(empty.ids, []);
    assert.equal(hasExclusionRecord({ provenance: { goldExclusion: exclusionRecord(empty, exam(baseCommit, goldCommit)) } }), true);
  });
});

test('the exclusion fails LOUD, never open, when it cannot answer the question', async () => {
  await withRepo(async (root, { repo, baseCommit }) => {
    // An unknown gold commit means every rule below it is uncomputable. Running the exam
    // anyway would hand the student whatever the check could not rule out.
    await assert.rejects(computeGoldProvenanceExclusions({
      exam: exam(baseCommit, 'f'.repeat(40)), documents: [{ id: 'x', path: 'app.js', meta: {} }], sourceRepo: repo,
    }));

    await assert.rejects(computeGoldProvenanceExclusions({
      exam: { examId: 'exam-0001', baseCommit, goldCommit: 'not-a-sha' }, documents: [], sourceRepo: repo,
    }), /needs the exam gold commit/);

    await assert.rejects(computeGoldProvenanceExclusions({
      exam: exam(baseCommit, 'b'.repeat(40)), documents: [], sourceRepo: '',
    }), /needs the source repository path/);
  });
});

test('an exclusion larger than the store limit is refused, never truncated', async () => {
  await withRepo(async (root, { repo, baseCommit, goldCommit }) => {
    // The Store caps excludeDocumentIds at 1000. Silently dropping the tail would hand the
    // student exactly the documents that fell off the end, so the run is refused instead.
    const documents = Array.from({ length: MAX_EXCLUDED_DOCUMENT_IDS + 1 }, (unused, index) => ({
      id: `d${String(index).padStart(5, '0')}`,
      type: 'evaluation',
      path: `brain/d${index}.md`,
      meta: {},
      content: 'about exam-0001',
    }));
    await assert.rejects(
      computeGoldProvenanceExclusions({ exam: exam(baseCommit, goldCommit), documents, sourceRepo: repo }),
      /Refusing rather than truncating: the dropped ids are the ones that leak/,
    );
  });
});

test('the exclusion record distinguishes computed-and-empty from never-computed', () => {
  const target = exam('a'.repeat(40), 'b'.repeat(40));
  const record = exclusionRecord({ ids: [], reasons: {} }, target);
  assert.equal(record.computed, true);
  assert.equal(record.count, 0);
  assert.equal(record.goldCommit, target.goldCommit);

  assert.equal(hasExclusionRecord({ provenance: { goldExclusion: record } }), true);
  assert.equal(hasExclusionRecord({ provenance: {} }), false);
  assert.equal(hasExclusionRecord({}), false);
  assert.equal(hasExclusionRecord(null), false);
  assert.equal(hasExclusionRecord({ provenance: { goldExclusion: { computed: false, ids: [] } } }), false);
  assert.equal(hasExclusionRecord({ provenance: { goldExclusion: { computed: true } } }), false);
  assert.throws(() => exclusionRecord(null, target), /needs the computed exclusion/);
});
