// The four shipped instruction files, the modified-from-default badge, the prompt scaffold
// they feed, and the two boundary scans that keep the gym out of the user's git and off its
// own spend gate.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AGENT_ROLES, agentFileHash, agentFilePath, ensureAgentFiles, getAgentFile, readDefaultAgentFile, setAgentFile,
} from '../src/gym/agent-files.js';
import { buildStudentPrompt, promptScaffoldAudit, studentMode } from '../src/gym/prompt.js';
import { gitWriteOffenders } from '../src/gym/ledger.js';

const gymRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/gym');

async function withRepo(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-agents-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('all four instruction files ship, and each carries the TEACHER.md conventions', async () => {
  assert.deepEqual([...AGENT_ROLES], ['student', 'teacher', 'auditor', 'watcher']);
  for (const role of AGENT_ROLES) {
    const content = await readDefaultAgentFile(role);
    assert.match(content, new RegExp(`daijin-instruction-file: ${role}`), `${role} declares which file it is`);
    // The conventions from the TEACHER.md saga, stated in every file because the reader of
    // one file does not read the others.
    assert.match(content, /Corrections are made IN PLACE and dated/i, `${role} carries the correction convention`);
    assert.match(content, /WITHDRAWN/, `${role} carries the withdrawn-not-deleted convention`);
    assert.match(content, /Era note/i, `${role} carries an era note`);
    assert.ok(content.length > 1_000, `${role} is a real instruction file, not a stub`);
  }
});

test('the roles keep their separations: detection, judgment, authorship, grading', async () => {
  const watcher = await readDefaultAgentFile('watcher');
  assert.match(watcher, /never judgment, never action/i);
  assert.match(watcher, /No spend/i);

  const auditor = await readDefaultAgentFile('auditor');
  assert.match(auditor, /You recommend spend; you never authorize it/i);
  assert.match(auditor, /You may NOT override a revert/i);
  assert.match(auditor, /You never grade/i, 'the author of the exam does not grade it');

  const teacher = await readDefaultAgentFile('teacher');
  assert.match(teacher, /You never write project code/i);
  assert.match(teacher, /did not author the exam/i);
});

test('the shipped student file satisfies the ADR-0167 prompt audit, and a stripped one does not', async () => {
  const shipped = await readDefaultAgentFile('student');
  const audit = promptScaffoldAudit(shipped);
  assert.deepEqual(audit, {
    sections: { 'completion-gauge': true, 'integration-first': true },
    missing: [],
    complete: true,
  });

  // Partial credit is refused on purpose: a gauge without the budget consequence reads as
  // present in the record while the student never learns that unverified edits are discarded.
  const halfGauge = shipped.replace(/unverified edits are discarded/gi, 'keep going');
  assert.deepEqual(promptScaffoldAudit(halfGauge).missing, ['completion-gauge']);
  assert.deepEqual(promptScaffoldAudit('').missing, ['completion-gauge', 'integration-first']);
});

test('both ADR-0167 sections reach the student, in order, ahead of the task', async () => {
  // The integration-seam-first section is the fourth campaign default, credited with the
  // first route wiring exam-0058 ever saw. Presence is not enough: it is an ORDERING rule,
  // it must arrive before the task it applies to, and the gauge that tells the student what
  // the budget does with unverified work has to come first, since it is what makes
  // "verify the seam" actionable rather than advice.
  const rules = await readDefaultAgentFile('student');
  const gaugeInFile = rules.indexOf('## Completion gauge');
  const seamInFile = rules.indexOf('## Integration seam first');
  assert.ok(gaugeInFile > -1 && seamInFile > -1, 'both sections ship in the default file');
  assert.ok(gaugeInFile < seamInFile, 'the gauge precedes the seam rule, as in the platform prompt');

  const { prompt } = buildStudentPrompt({
    rules, task: 'Add a sync endpoint and wire it to the client list view.', context: '<brain-context>c</brain-context>',
  });
  const gauge = prompt.indexOf('## Completion gauge');
  const seam = prompt.indexOf('## Integration seam first');
  const modeRuleAt = prompt.indexOf('## Mode-specific rule');
  const task = prompt.indexOf('<task note=');
  assert.ok(gauge > -1 && seam > -1, 'and both survive composition');
  assert.ok(gauge < seam, 'in that order');
  assert.ok(seam < modeRuleAt, 'the standing rules precede the per-run rule');
  assert.ok(modeRuleAt < task, 'and every rule precedes the task it governs');

  // Matched over whitespace-normalized text: these are sentences in a wrapped markdown file,
  // and a test that breaks when a paragraph rewraps teaches people to loosen the test.
  const unwrapped = (text) => text.replace(/\s+/g, ' ');
  // The seam rule states the ordering it is named for, rather than merely mentioning seams.
  const seamSection = unwrapped(rules.slice(seamInFile));
  assert.match(seamSection, /thinnest end-to-end path FIRST/);
  assert.match(seamSection, /Only after that skeleton stands should you deepen/);
  assert.match(seamSection, /A deep component nothing calls grades as absent/);
  // And the gauge states the budget consequence, which is the half that changes behavior.
  const gaugeSection = unwrapped(rules.slice(gaugeInFile, seamInFile));
  assert.match(gaugeSection, /MET or UNMET/);
  assert.match(gaugeSection, /Unverified edits are discarded when the budget seals/);
  assert.match(gaugeSection, /earns any budget extension the harness may offer/);
  assert.match(gaugeSection, /Do not stop merely because you have worked for a long time/);
});

test('the prompt wraps the task as data, escapes it, and picks its mode from the task text', async () => {
  const rules = await readDefaultAgentFile('student');
  assert.equal(studentMode('Fix the crash when the list is empty'), 'fix-bug');
  assert.equal(studentMode('Add a sync endpoint'), 'implement-feature');

  const built = buildStudentPrompt({
    rules, task: 'Fix the <script> handling so the crash stops', context: '<brain-context>x</brain-context>',
  });
  assert.equal(built.mode, 'fix-bug');
  assert.match(built.prompt, /## Mode-specific rule \(fix-bug\)/);
  assert.match(built.prompt, /Reproduce or establish the failure/);
  assert.match(built.prompt, /&lt;script&gt;/, 'the task is owner data inside a prompt and is escaped as such');
  assert.match(built.prompt, /<brain-context>x<\/brain-context>/, 'the retrieved context rides through unchanged');

  assert.throws(() => buildStudentPrompt({ rules: '  ', task: 'x'.repeat(40) }), /refusing to run a student with no rules/i);
  assert.throws(() => buildStudentPrompt({ rules, task: '' }), /Exam task is empty/);
});

test('a missing repo file reads as the default, and the badge lights up only on a real edit', async () => {
  await withRepo(async (repoPath) => {
    const before = await getAgentFile(repoPath, 'student');
    assert.equal(before.installed, false, 'a fresh repo has no .daijin/agents yet, and the gym still runs');
    assert.equal(before.modified, false);
    assert.equal(before.currentHash, before.defaultHash);
    assert.equal(before.path, agentFilePath(repoPath, 'student'));

    const installed = await ensureAgentFiles(repoPath);
    assert.deepEqual(installed, ['student', 'teacher', 'auditor', 'watcher']);
    assert.deepEqual((await readdir(path.join(repoPath, '.daijin', 'agents'))).sort(), ['auditor.md', 'student.md', 'teacher.md', 'watcher.md']);

    const untouched = await getAgentFile(repoPath, 'student');
    assert.equal(untouched.installed, true);
    assert.equal(untouched.modified, false, 'installing the default is not an edit');

    // A checkout that rewrote line endings is not a user edit either.
    await writeFile(agentFilePath(repoPath, 'student'), untouched.content.replaceAll('\n', '\r\n'), 'utf8');
    assert.equal((await getAgentFile(repoPath, 'student')).modified, false);

    const edited = await setAgentFile(repoPath, 'student', `${untouched.content}\n## My own rule\n\nAlways run the tests.\n`);
    assert.equal(edited.modified, true);
    assert.notEqual(edited.currentHash, edited.defaultHash);
    assert.equal(edited.defaultHash, agentFileHash(await readDefaultAgentFile('student')));

    // A second ensure never overwrites the user's edit: refreshing edited instructions on
    // upgrade would be an unlogged behavior change to a measured system.
    assert.deepEqual(await ensureAgentFiles(repoPath), []);
    assert.equal((await getAgentFile(repoPath, 'student')).modified, true);

    await assert.rejects(setAgentFile(repoPath, 'student', '   '), /Refusing to write an empty student instruction file/);
    await assert.rejects(getAgentFile(repoPath, 'coach'), /Unknown agent role: coach/);
    const entries = await readdir(path.join(repoPath, '.daijin', 'agents'));
    assert.deepEqual(entries.filter((name) => name.includes('.tmp')), [], 'no temporary files survive a write');
  });
});

test('no gym source writes the user git', async () => {
  const names = (await readdir(gymRoot)).filter((name) => name.endsWith('.js'));
  const files = await Promise.all(names.map(async (name) => ({
    path: name, source: await readFile(path.join(gymRoot, name), 'utf8'),
  })));
  assert.deepEqual(gitWriteOffenders(files), []);

  // The scan can fail. Both of these are the shape it exists to catch: a gym that records
  // its own work in the user's history.
  assert.deepEqual(
    gitWriteOffenders([{ path: 'harvest.js', source: "await execFile('git', ['commit', '-m', 'gym: lesson'], { cwd: sourceRepo });" }])
      .map((entry) => entry.reason),
    ["git commit in gym code; the gym never writes the user's git"],
  );
  assert.equal(gitWriteOffenders([{ path: 'x.js', source: "await execFile('git', ['push', 'origin', 'main']);" }]).length, 1);
  // And the sandbox's own operations stay allowed, or the scan would remove the sandbox.
  assert.deepEqual(gitWriteOffenders([{ path: 'sandbox.js', source: "await git(repo, ['worktree', 'add', '--detach', dir]); await git(dir, ['reset', '--hard', base]);" }]), []);
});

test('no dashes the project bans appear in the gym sources or the shipped instruction files', async () => {
  const roots = [gymRoot, path.join(gymRoot, 'agents-defaults')];
  const offenders = [];
  for (const root of roots) {
    for (const name of (await readdir(root)).filter((entry) => entry.endsWith('.js') || entry.endsWith('.md'))) {
      const source = await readFile(path.join(root, name), 'utf8');
      // Em dash and en dash, by code point rather than by literal, so this file does not
      // contain the characters it forbids.
      if (source.includes(String.fromCharCode(0x2014)) || source.includes(String.fromCharCode(0x2013))) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, []);
});
