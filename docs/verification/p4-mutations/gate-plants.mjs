#!/usr/bin/env node
// Runs the gate-writer plant set against the LIVE scanner and prints one line per plant.
//
// The acceptance instrument for D-0023 is the verifier's own attack.mjs. This is the
// equivalent I can run without it: the same eleven plants and four innocent controls the
// hermetic test asserts, in a form the verifier can diff against its own results rather
// than take on trust.
//
// Exit code is 0 only when every plant is caught AND every control is clean. A control that
// fires is a failure here, not a warning: a widened rule that flags writeFile(resultPath)
// would be worse than the narrow rule it replaced.
//
//   node docs/verification/p4-mutations/gate-plants.mjs

import { gateWriterOffenders } from '../../../engine/src/gym/spend-gate.js';

const PLANTS = [
  ['verifier', 'direct write to the gate helper', 'demo.js',
    'import { writeFile } from "node:fs/promises";\nexport async function open(repo) {\n  await writeFile(gymSpendGatePath(repo), JSON.stringify({ status: "open", reason: "demo" }));\n}\n'],
  ['verifier', 'concatenated path, no helper anywhere', 'helper.js',
    'import { writeFile } from "node:fs/promises";\nexport async function unlock(repoPath) {\n  await writeFile(repoPath + "/.daijin/GATE", body);\n}\n'],
  ['verifier', 'template-literal demo helper', 'demo-helper.js',
    'import { writeFile } from "node:fs/promises";\nexport async function openForDemo(repoPath) {\n  await writeFile(`${repoPath}/.daijin/GATE`, `{"status":"open","reason":"demo"}`);\n}\n'],
  ['verifier', 'owner-style write to a variable target', 'spend-gate.js',
    'export async function reopen({ repoPath, writeFile }) {\n  const target = gymSpendGatePath(repoPath);\n  const payload = buildGate();\n  await writeFile(target, payload, "utf8");\n}\n'],
  ['gym-porter', 'owner write whose open payload is built far above it', 'spend-gate.js',
    `export async function reopen({ repoPath, writeFile }) {\n  const desired = { status: "open", reason: "the operator asked" };\n${'  // padding\n'.repeat(12)}  await writeFile(gymSpendGatePath(repoPath), JSON.stringify(desired));\n}\n`],
  ['gym-porter', 'synchronous write', 'setup.js',
    'import { writeFileSync } from "node:fs";\nexport function seed(repo) { writeFileSync(gymSpendGatePath(repo), openGate); }\n'],
  ['gym-porter', 'append rather than write', 'appender.js',
    'import { appendFile } from "node:fs/promises";\nexport async function nudge(repo) { await appendFile(`${repo}/.daijin/GATE`, extra); }\n'],
  ['gym-porter', 'namespaced call through the fs module object', 'ns.js',
    'import fs from "node:fs/promises";\nexport async function open(repo) { await fs.writeFile(gymSpendGatePath(repo), payload); }\n'],
  ['gym-porter', 'path assembled from a module constant', 'constants-writer.js',
    'import { join } from "node:path";\nimport { writeFile } from "node:fs/promises";\nconst GATE_FILE = ".daijin/GATE";\nexport async function set(repo, gate) { await writeFile(join(repo, GATE_FILE), gate); }\n'],
  ['gym-porter', 'shell redirection, which no file-write regex would ever see', 'shell.js',
    'import { execFile } from "node:child_process";\nexport function open(repo) {\n  execFile("/bin/sh", ["-c", `echo \'{"status":"open"}\' > ${repo}/.daijin/GATE`]);\n}\n'],
  ['gym-porter', 'a stream opened on the gate', 'stream.js',
    'import { createWriteStream } from "node:fs";\nexport function open(repo) { createWriteStream(gymSpendGatePath(repo)).end(openBody); }\n'],
  ['gym-porter', 'allowlisted module writing an aliased gate path at a distance', 'methods.js',
    `import { writeFile } from "node:fs/promises";\nconst gateFile = gymSpendGatePath(repoPath);\n${'export const noop = () => null;\n'.repeat(20)}export async function later(body) { await writeFile(gateFile, body, "utf8"); }\n`],
];

const CONTROLS = [
  ['a result-file writer, which is most of what the gym does', 'result-files.js',
    'import { writeFile, rename } from "node:fs/promises";\nexport async function writeResult(dir, result) {\n  const temporary = `${dir}/tmp.json`;\n  await writeFile(temporary, JSON.stringify(result), "utf8");\n  await rename(temporary, resultPath);\n}\n'],
  ['an instruction-file writer', 'agent-files.js',
    'import { writeFile } from "node:fs/promises";\nexport async function setAgentFile(path, content) { await writeFile(path, content, "utf8"); }\n'],
  ['a module that discusses the gate in prose and writes something else', 'docs-writer.js',
    'import { writeFile } from "node:fs/promises";\n// The owner flips the GATE by hand; nothing here touches it.\nexport async function log(file, line) { await writeFile(file, line, "utf8"); }\n'],
  ['a module that names the gate and writes nothing at all', 'reader.js',
    'import { readFile } from "node:fs/promises";\nexport const read = (repo) => readFile(gymSpendGatePath(repo), "utf8");\n'],
];

let failures = 0;
console.log('PLANTS (every one must be CAUGHT)');
for (const [origin, name, path, source] of PLANTS) {
  const offenders = gateWriterOffenders([{ path, source }]);
  const caught = offenders.length > 0;
  if (!caught) failures += 1;
  console.log(`  ${caught ? 'CAUGHT ' : 'MISSED '} [${origin}] ${name}`);
  if (caught) console.log(`           ${offenders[0].reason}`);
}

console.log('\nCONTROLS (every one must be CLEAN)');
for (const [name, path, source] of CONTROLS) {
  const offenders = gateWriterOffenders([{ path, source }]);
  const clean = offenders.length === 0;
  if (!clean) failures += 1;
  console.log(`  ${clean ? 'CLEAN     ' : 'FALSE HIT '} ${name}`);
}

console.log(`\n${PLANTS.length} plants, ${CONTROLS.length} controls, ${failures} failure(s).`);
process.exitCode = failures === 0 ? 0 : 1;
