// The owner spend gate: blocked by default, refused with -32050 and the path, and no code
// path anywhere in the gym that writes it open.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  GATE_SCAN_ALLOWLIST, GYM_SPEND_SCOPES, SPEND_REFUSED_CODE, SpendRefusedError, assertSpendGate, autoBlockSpendGate,
  gateWriterOffenders, gymSpendGatePath, parseSpendGate, readSpendGate,
} from '../src/gym/spend-gate.js';

const gymRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/gym');

async function withRepo(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-gate-'));
  try {
    return await run(root, gymSpendGatePath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeGate(file, value) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('every malformed gate is a blocked gate, and each refusal says which malformation', () => {
  const file = '/repo/.daijin/GATE';
  const cases = [
    [null, /no gate at/],
    ['{ not json', /not valid JSON/],
    ['[]', /must be a JSON object/],
    ['{"status":"unlocked","reason":"x"}', /carries status "unlocked"/],
    ['{"status":"open"}', /has no reason/],
    ['{"status":"open","reason":"   "}', /has no reason/],
    ['{"status":"blocked","reason":"held","scope":"gym-cycle"}', /carries a scope while blocked/],
    ['{"status":"authorized","reason":"x","scope":"mining"}', /authorizes unknown scope/],
    ['{"status":"authorized","reason":"x"}', /authorizes unknown scope/],
    ['{"status":"open","reason":"x","scope":"gym-cycle"}', /open and also names a scope/],
  ];
  for (const [raw, hint] of cases) {
    const gate = parseSpendGate(raw, { file });
    assert.equal(gate.open, false, `expected blocked for ${raw}`);
    assert.match(gate.hint, hint);
  }
});

test('a missing gate blocks, and the refusal carries the code and the path the user must flip', async () => {
  await withRepo(async (repoPath, file) => {
    const gate = await readSpendGate({ repoPath });
    assert.equal(gate.open, false);
    assert.equal(gate.file, file);

    await assert.rejects(assertSpendGate('gym-cycle', { repoPath }), (error) => {
      assert.ok(error instanceof SpendRefusedError);
      assert.equal(error.code, SPEND_REFUSED_CODE);
      assert.equal(error.code, -32050);
      assert.equal(error.data.gate, file, 'the TUI needs the path, not just a refusal');
      assert.match(error.data.hint, /Spend is blocked/);
      return true;
    });
  });
});

test('an open gate authorizes any scope; an authorized gate authorizes exactly one', async () => {
  await withRepo(async (repoPath, file) => {
    await writeGate(file, { status: 'open', reason: 'Owner opened for the first harness-debug cycle.' });
    for (const scope of GYM_SPEND_SCOPES) {
      const gate = await assertSpendGate(scope, { repoPath });
      assert.equal(gate.open, true);
      assert.equal(gate.reason, 'Owner opened for the first harness-debug cycle.');
    }

    await writeGate(file, { status: 'authorized', scope: 'exam-mining', reason: 'Mining only.' });
    assert.equal((await assertSpendGate('exam-mining', { repoPath })).scope, 'exam-mining');
    await assert.rejects(assertSpendGate('gym-cycle', { repoPath }), (error) => {
      assert.equal(error.code, -32050);
      assert.match(error.message, /authorizes exam-mining, not gym-cycle/);
      return true;
    });
  });
});

test('an unknown scope is a programming error, not a refusal the user can fix', async () => {
  await withRepo(async (repoPath) => {
    await assert.rejects(assertSpendGate('gym-freebie', { repoPath }), /Unknown gym spend scope/);
  });
});

test('the automatic closure writes blocked, and blocked is the only status it can write', async () => {
  await withRepo(async (repoPath, file) => {
    await writeGate(file, { status: 'open', reason: 'Owner opened for one cycle.' });
    const closed = await autoBlockSpendGate({ repoPath });
    assert.equal(closed.changed, true);
    assert.equal(closed.open, false);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.status, 'blocked');
    assert.match(onDisk.reason, /Automatic safety closure/);
    assert.ok(!Object.hasOwn(onDisk, 'scope'));

    // Idempotent, and it leaves no temporary file behind for the next run to trip over.
    const again = await autoBlockSpendGate({ repoPath });
    assert.equal(again.changed, false);
    const entries = await readdir(path.dirname(file));
    assert.deepEqual(entries.filter((name) => name.includes('.tmp')), []);
  });
});

test('the closure never normalizes a malformed gate into a valid one', async () => {
  await withRepo(async (repoPath, file) => {
    await writeGate(file, '{ garbage');
    const result = await autoBlockSpendGate({ repoPath });
    assert.equal(result.changed, false);
    assert.equal(await readFile(file, 'utf8'), '{ garbage', 'the owner file is left exactly as found');
  });
});

const rpcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/rpc');

async function engineSources() {
  const scanned = [];
  for (const root of [gymRoot, rpcRoot]) {
    for (const name of (await readdir(root)).filter((entry) => entry.endsWith('.js'))) {
      scanned.push({ path: name, source: await readFile(path.join(root, name), 'utf8') });
    }
  }
  return scanned;
}

/**
 * The plant set.
 *
 * Four of these are reconstructions of the verifier's planted offenders (D-0023 finding 73),
 * which caught the previous scanner at 1 of 4. The rest are mine, because four is what one
 * reviewer thought of in ten minutes and not a bound on what the mistake can take. Each
 * plant is a way to write the gate that a scanner reasoning about the write TARGET, or about
 * a forward-only window, would walk straight past.
 */
const GATE_OPENING_PLANTS = [
  {
    name: 'direct write to the gate helper',
    origin: 'verifier',
    path: 'demo.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + 'export async function open(repo) {\n'
      + '  await writeFile(gymSpendGatePath(repo), JSON.stringify({ status: "open", reason: "demo" }));\n}\n',
  },
  {
    name: 'concatenated path, no helper anywhere',
    origin: 'verifier',
    path: 'helper.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + 'export async function unlock(repoPath) {\n'
      + '  await writeFile(repoPath + "/.daijin/GATE", body);\n}\n',
  },
  {
    name: 'template-literal demo helper',
    origin: 'verifier',
    path: 'demo-helper.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + 'export async function openForDemo(repoPath) {\n'
      + '  await writeFile(`${repoPath}/.daijin/GATE`, `{"status":"open","reason":"demo"}`);\n}\n',
  },
  {
    name: 'owner-style write to a variable target',
    origin: 'verifier',
    path: 'spend-gate.js',
    source: 'export async function reopen({ repoPath, writeFile }) {\n'
      + '  const target = gymSpendGatePath(repoPath);\n'
      + '  const payload = buildGate();\n'
      + '  await writeFile(target, payload, "utf8");\n}\n',
  },
  {
    name: 'owner write whose open payload is built far above it',
    origin: 'gym-porter',
    path: 'spend-gate.js',
    source: 'export async function reopen({ repoPath, writeFile }) {\n'
      + '  const desired = { status: "open", reason: "the operator asked" };\n'
      + `${'  // padding that pushes the payload out of any forward window\n'.repeat(12)}`
      + '  await writeFile(gymSpendGatePath(repoPath), JSON.stringify(desired));\n}\n',
  },
  {
    name: 'synchronous write',
    origin: 'gym-porter',
    path: 'setup.js',
    source: 'import { writeFileSync } from "node:fs";\n'
      + 'export function seed(repo) { writeFileSync(gymSpendGatePath(repo), openGate); }\n',
  },
  {
    name: 'append rather than write',
    origin: 'gym-porter',
    path: 'appender.js',
    source: 'import { appendFile } from "node:fs/promises";\n'
      + 'export async function nudge(repo) { await appendFile(`${repo}/.daijin/GATE`, extra); }\n',
  },
  {
    name: 'namespaced call through the fs module object',
    origin: 'gym-porter',
    path: 'ns.js',
    source: 'import fs from "node:fs/promises";\n'
      + 'export async function open(repo) { await fs.writeFile(gymSpendGatePath(repo), payload); }\n',
  },
  {
    name: 'path assembled from a module constant',
    origin: 'gym-porter',
    path: 'constants-writer.js',
    source: 'import { join } from "node:path";\nimport { writeFile } from "node:fs/promises";\n'
      + 'const GATE_FILE = ".daijin/GATE";\n'
      + 'export async function set(repo, gate) { await writeFile(join(repo, GATE_FILE), gate); }\n',
  },
  {
    name: 'shell redirection, which no file-write regex would ever see',
    origin: 'gym-porter',
    path: 'shell.js',
    source: 'import { execFile } from "node:child_process";\n'
      + 'export function open(repo) {\n'
      + '  execFile("/bin/sh", ["-c", `echo \'{"status":"open"}\' > ${repo}/.daijin/GATE`]);\n}\n',
  },
  {
    name: 'a stream opened on the gate',
    origin: 'gym-porter',
    path: 'stream.js',
    source: 'import { createWriteStream } from "node:fs";\n'
      + 'export function open(repo) { createWriteStream(gymSpendGatePath(repo)).end(openBody); }\n',
  },
];

/** Innocent controls. A widened rule that fires on these would be WORSE than the narrow one,
 *  because nobody could write a file in this engine and everyone would learn to ignore it. */
const INNOCENT_CONTROLS = [
  {
    name: 'a result-file writer, which is most of what the gym does',
    path: 'result-files.js',
    source: 'import { writeFile, rename } from "node:fs/promises";\n'
      + 'export async function writeResult(dir, result) {\n'
      + '  const temporary = `${dir}/tmp.json`;\n'
      + '  await writeFile(temporary, JSON.stringify(result), "utf8");\n'
      + '  await rename(temporary, resultPath);\n}\n',
  },
  {
    name: 'an instruction-file writer',
    path: 'agent-files.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + 'export async function setAgentFile(path, content) { await writeFile(path, content, "utf8"); }\n',
  },
  {
    name: 'a module that discusses the gate in prose and writes something else',
    path: 'docs-writer.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + '// The owner flips the GATE by hand; nothing here touches it, we only log the fact.\n'
      + 'export async function log(file, line) { await writeFile(file, line, "utf8"); }\n',
  },
  {
    name: 'a module that names the gate and writes nothing at all',
    path: 'reader.js',
    source: 'import { readFile } from "node:fs/promises";\n'
      + 'export const read = (repo) => readFile(gymSpendGatePath(repo), "utf8");\n',
  },
];

/**
 * The verifier's four plants and its control, copied VERBATIM from its acceptance
 * instrument (docs/verification/p4-mutations/gate-scanner-plants.mjs).
 *
 * Duplicated here on purpose. That script is the arbiter and is run by hand; this is the
 * same acceptance inside `npm test`, so a later refactor of the scanner cannot quietly
 * regress past the bar that decided the ruling. If the two ever disagree, the script wins
 * and this copy is the stale one.
 */
const VERIFIER_PLANTS = [
  {
    name: 'direct gate-file write from a non-owner',
    path: 'src/gym/demo.js',
    source: 'const GATE_FILE = ".daijin/GATE";\nawait writeFile(".daijin/GATE", JSON.stringify({ status: "open" }));\n',
  },
  {
    name: 'aliased gate path built by concatenation, not gymSpendGatePath()',
    path: 'src/gym/helper.js',
    source: 'const gatePath = repoPath + "/.daijin/GATE";\nawait writeFile(gatePath, body);\n',
  },
  {
    name: 'owner writing an open-status literal to a VARIABLE target',
    path: 'src/gym/spend-gate.js',
    source: 'const file = ".daijin/GATE";\nawait writeFile(file, JSON.stringify({ status: "open", scope }));\n',
  },
  {
    name: 'convenience demo helper with a template-literal path',
    path: 'src/gym/dev-tools.js',
    source: 'export async function openGateForDemo(repoPath){\n'
      + '  const p = `${repoPath}/.daijin/GATE`;\n'
      + '  await writeFileSync(p, \'{"status":"open"}\');\n}\n',
  },
];

const VERIFIER_CONTROL = {
  path: 'src/gym/cycle.js',
  source: 'import x from "y";\nawait writeFile(resultPath, JSON.stringify(row));\n',
};

test('ACCEPTANCE (D-0023): the verifier plants are caught and its control stays clean', () => {
  // The bar that decided the ruling, held inside the suite so it cannot be regressed past.
  const missed = VERIFIER_PLANTS.filter((plant) => gateWriterOffenders([plant]).length === 0);
  assert.deepEqual(missed.map((plant) => plant.name), [], 'every verifier plant must be caught');
  // And the half that is just as binding: catching every plant while flagging an ordinary
  // result-file write is a WORSE scanner than the narrow one it replaced.
  assert.deepEqual(gateWriterOffenders([VERIFIER_CONTROL]), [], 'the innocent writer must never be flagged');
});

test('MUTATION GUARD: the plant set, every shape of writing the gate, caught', () => {
  // D-0023: the acceptance instrument is the plants, not the argument. Each is scanned alone
  // so a single rule cannot mask another's miss, and the failure message names the shape.
  const missed = GATE_OPENING_PLANTS.filter((plant) => gateWriterOffenders([plant]).length === 0);
  assert.deepEqual(
    missed.map((plant) => `${plant.origin}: ${plant.name}`),
    [],
    'every planted gate-opener must be caught',
  );

  // Allowlisting cannot excuse a write where the gate is named: the entry buys distance,
  // not permission. Re-run the foreign plants as though each were the allowlisted module.
  const asAllowlisted = GATE_OPENING_PLANTS
    .filter((plant) => plant.path !== 'spend-gate.js')
    .map((plant) => ({ ...plant, path: 'methods.js' }));
  const escaped = asAllowlisted.filter((plant) => gateWriterOffenders([plant]).length === 0);
  assert.deepEqual(escaped.map((plant) => plant.name), [], 'an allowlist entry is not a licence to open the gate');
});

test('MUTATION GUARD: the widened rule leaves innocent writers alone', () => {
  // Binding guidance from the verifier: a widened rule that fires on writeFile(resultPath)
  // would be worse than the narrow one. This is that clause, held as a test.
  for (const control of INNOCENT_CONTROLS) {
    assert.deepEqual(gateWriterOffenders([control]), [], `false positive on ${control.name}`);
  }
  assert.deepEqual(gateWriterOffenders(INNOCENT_CONTROLS), []);
});

test('the allowlist is a list of decisions, each carrying its reason', () => {
  for (const entry of GATE_SCAN_ALLOWLIST) {
    assert.ok(entry.path, 'an allowlist entry names a file');
    assert.ok(entry.reason.length > 60, `${entry.path} needs a reason someone can argue with, not a shrug`);
  }
  // And an allowlisted module that starts writing the gate is still caught, so the list
  // cannot become the silence the narrow rule was defended against.
  const rogue = {
    path: 'methods.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + 'export async function unlock(repoPath) { await writeFile(gymSpendGatePath(repoPath), body); }\n',
  };
  assert.equal(gateWriterOffenders([rogue]).length, 1);

  // Including at a distance the neighborhood cannot see: bound at the top of the file,
  // written to hundreds of lines later. This is the one shape an allowlist entry would
  // otherwise buy outright.
  const patient = {
    path: 'methods.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + 'const gateFile = gymSpendGatePath(repoPath);\n'
      + `${'// a long file full of unrelated methods\nexport const noop = () => null;\n'.repeat(20)}`
      + 'export async function later(body) { await writeFile(gateFile, body, "utf8"); }\n',
  };
  assert.deepEqual(
    gateWriterOffenders([patient]).map((entry) => entry.reason),
    ['methods.js is allowlisted to name the gate, but it writes to a variable holding the gate path'],
  );
});

test('MUTATION GUARD: no code path in the engine can open the gate, runner or daemon', async () => {
  // Scanned over the gym AND the daemon, because the daemon reaches the gate too: a mutant
  // daemon that can open the gate is exactly as dangerous as a mutant runner.
  const files = await engineSources();
  assert.ok(files.some((file) => file.path === 'cycle.js'), 'the scan must actually see the runner');
  assert.ok(files.some((file) => file.path === 'methods.js'), 'the scan must actually see the daemon');
  assert.ok(files.length >= 12, `the scan must see the engine, saw ${files.length} files`);
  assert.deepEqual(gateWriterOffenders(files), [], 'an engine module writes the gate file');

  // The scan CAN fail, demonstrated on the REAL sources rather than on hand-written
  // fixtures: each mutant below is the real file plus the one function that would open the
  // gate, which is what a careless commit actually looks like.
  const realRunner = files.find((file) => file.path === 'cycle.js');
  const realDaemon = files.find((file) => file.path === 'methods.js');

  const mutantRunner = {
    path: 'cycle.js',
    source: `${realRunner.source}\nexport async function openGateForRun(repoPath) {\n`
      + '  await writeFile(gymSpendGatePath(repoPath), JSON.stringify({ status: "open", reason: "the cycle needs it" }));\n}\n',
  };
  assert.deepEqual(
    gateWriterOffenders([mutantRunner]).map((entry) => entry.path),
    ['cycle.js'],
    'a mutant RUNNER that can open the gate must be caught',
  );

  const mutantDaemon = {
    path: 'methods.js',
    source: `${realDaemon.source}\nasync function unlockSpend(repoPath) {\n`
      + '  const target = gymSpendGatePath(repoPath);\n'
      + '  const payload = JSON.stringify(desiredGate);\n'
      + '  await writeFile(target, payload, "utf8");\n}\n',
  };
  // The daemon holds the one allowlist entry, so this mutant tests the rule that matters
  // most about an allowlist: the entry buys distance from the gate, never permission.
  assert.deepEqual(
    gateWriterOffenders([mutantDaemon]).map((entry) => entry.reason),
    ['methods.js is allowlisted to name the gate, but this write sits where the gate is named'],
    'a mutant DAEMON that opens the gate through an aliased path must be caught too',
  );

  // And the unmutated daemon stays clean, so the scan is not passing by flagging everything:
  // methods.js legitimately writes score history, agent files and gates.yaml while also
  // reading the gate path for serveStatus.
  assert.deepEqual(gateWriterOffenders([realDaemon]), []);
});

test('the scanned set covers every engine source directory', async () => {
  // The residual I reported and you approved closing: the scanner is only as good as what it
  // is pointed at, and nothing enforced that the pointed-at set was the whole engine. A new
  // directory that reaches the gate would have been outside the scan with no test failing,
  // which is the silence the whole rule exists to prevent.
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const entries = await readdir(srcRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  // The scanned set is declared here rather than derived, so ADDING a directory to the
  // engine forces a decision about whether the gate scan should cover it. Deriving it would
  // make this test pass by construction and prove nothing.
  const SCANNED = ['gym', 'rpc'];
  const UNSCANNED = [
    // Each exemption states why it cannot reach the gate. An exemption is a claim someone
    // has to defend, exactly like an allowlist entry.
    ['init', 'repo analysis and the gold-set miner; reads history, writes brain artifacts, never the gate'],
    ['mcp', 'the MCP server surface; read-only over the brain'],
    ['rag', 'retrieval primitives; pure functions over the store'],
    ['runtime', 'logger and embedding identity; no gate concept'],
    ['store', 'the brain store backends; refuse foreign ledgers and never see the gate'],
  ];

  const declared = [...SCANNED, ...UNSCANNED.map(([name]) => name)].sort();
  assert.deepEqual(
    directories,
    declared,
    'an engine source directory is neither scanned nor exempted; decide which, and if it can reach the gate add it to engineSources()',
  );

  // And the exemptions are checked rather than trusted: an exempt directory that starts
  // naming the gate has stopped being exempt.
  for (const [name, why] of UNSCANNED) {
    assert.ok(why.length > 20, `${name} needs a real exemption reason`);
    const root = path.join(srcRoot, name);
    for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.js'))) {
      const source = await readFile(path.join(root, file), 'utf8');
      assert.ok(
        !/gymSpendGatePath|['"`][^'"`]*\/GATE['"`]/.test(source),
        `${name}/${file} names the gate while sitting outside the scanned set`,
      );
    }
  }
});

test('no gym source writes an open gate', async () => {
  const names = (await readdir(gymRoot)).filter((name) => name.endsWith('.js'));
  assert.ok(names.length >= 8, 'the scan must actually see the gym sources');
  const files = await Promise.all(names.map(async (name) => ({
    path: name, source: await readFile(path.join(gymRoot, name), 'utf8'),
  })));
  assert.deepEqual(gateWriterOffenders(files), [], 'a gym module writes the gate file');

  // The scan can fail, in both of the ways it is written to fail.
  // 1) Ownership: another module opening the gate "just for a demo", the inversion D-0014
  //    refused for the TUI mock. The payload here is even assembled by name, which is the
  //    form a payload-only scan cannot see.
  const foreignWriter = {
    path: 'demo-helper.js',
    source: 'import { writeFile } from "node:fs/promises";\n'
      + 'export async function openForDemo(repo) {\n'
      + '  const payload = JSON.stringify(demoGate);\n'
      + '  await writeFile(gymSpendGatePath(repo), payload);\n'
      + '}\n',
  };
  assert.deepEqual(gateWriterOffenders([foreignWriter]).map((entry) => entry.path), ['demo-helper.js']);

  // 2) Payload: the gate module itself growing a second writer that opens instead of blocks.
  const insideJob = {
    path: 'spend-gate.js',
    source: 'export async function reopen(file) {\n'
      + '  await writeFile(gymSpendGatePath(file), JSON.stringify({ status: "open", reason: "reopened" }));\n'
      + '}\n',
  };
  assert.deepEqual(gateWriterOffenders([insideJob]).map((entry) => entry.reason), ['a write in the gate module carries an open-status payload']);
});
