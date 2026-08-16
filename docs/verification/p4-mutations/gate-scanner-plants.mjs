// Acceptance instrument for the gate-writer scanner (D-0023).
//
// Authored by the verifier during the P4 attack. The scanner's job is the mechanical form
// of "no code path exists that opens the gate". A scanner that cannot fail on a realistic
// offender reports coverage it does not have, which is the condition ground rule 5 forbids.
//
// ACCEPTANCE, per D-0023: the widened scanner must catch ALL plants AND leave the innocent
// control clean. Catching every plant while flagging the control is not a pass: a rule that
// fires on an ordinary result-file write is a rule people learn to silence, which is the
// argument gym-porter made and which the control exists to protect.
//
// TWO STANDING NOTES from the verifier, binding per D-0023:
//   1. EXTEND THIS SET, IN A FREEZE WINDOW. Four plants is ten minutes of thought, not a
//      bound on the shapes the mistake can take, so this set should grow. But it runs in CI
//      on every lane's push, so a fifth plant is a gate change: propose it to the leader and
//      land it in a window. A plant set that stops growing becomes a checklist; one that
//      grows casually turns someone else's push red for a shape nobody agreed to.
//   2. THE CONTROL MATTERS AS MUCH AS THE PLANTS. Every plant caught with the control also
//      flagged is a worse scanner than the narrow one it replaced.
//
// Usage: node docs/verification/p4-mutations/gate-scanner-plants.mjs
// Exit 0 when acceptance is met, 1 otherwise, so CI can run it as a gate.

import { gateWriterOffenders } from '../../../engine/src/gym/spend-gate.js';

// An ordinary engine module that writes a file and has nothing to do with the gate.
// It must never be flagged.
const CONTROL = {
  path: 'src/gym/cycle.js',
  source: 'import x from "y";\nawait writeFile(resultPath, JSON.stringify(row));\n',
};

const PLANTS = [
  {
    name: 'direct gate-file write from a non-owner',
    why: 'the most literal form: a foreign module names the gate path in the write call itself',
    file: {
      path: 'src/gym/demo.js',
      source: 'const GATE_FILE = ".daijin/GATE";\nawait writeFile(".daijin/GATE", JSON.stringify({ status: "open" }));\n',
    },
  },
  {
    name: 'aliased gate path built by concatenation, not gymSpendGatePath()',
    why: 'the FOREIGN ALIAS rule tracks variables bound to gymSpendGatePath(). A refactor that '
      + 'hand-builds the path string escapes it, and hand-building is the accident the rule '
      + 'comment says it exists to catch',
    file: {
      path: 'src/gym/helper.js',
      source: 'const gatePath = repoPath + "/.daijin/GATE";\nawait writeFile(gatePath, body);\n',
    },
  },
  {
    name: 'owner writing an open-status literal to a VARIABLE target',
    why: 'the OWNER PAYLOAD rule needs a gate reference AND an open-status literal in the same '
      + 'write window. Writing to a bare variable puts no gate reference in the window. Note '
      + 'this is the owner module OWN existing style, so a mutant following house style escapes',
    file: {
      path: 'src/gym/spend-gate.js',
      source: 'const file = ".daijin/GATE";\nawait writeFile(file, JSON.stringify({ status: "open", scope }));\n',
    },
  },
  {
    name: 'convenience demo helper with a template-literal path',
    why: 'the exact scenario the scanner comment names as its purpose: the helper that opens '
      + 'the gate "just for a demo", the D-0014 inversion. The path sits one line above the '
      + 'write call, outside the window the FOREIGN DIRECT rule scans',
    file: {
      path: 'src/gym/dev-tools.js',
      source: 'export async function openGateForDemo(repoPath){\n'
        + '  const p = `${repoPath}/.daijin/GATE`;\n'
        + '  await writeFileSync(p, \'{"status":"open"}\');\n}\n',
    },
  },
];

const controlOffenders = gateWriterOffenders([CONTROL]);
const controlClean = controlOffenders.length === 0;
console.log(`CONTROL  ${controlClean ? 'clean  ' : 'FLAGGED'}  innocent writer, must never be flagged`);
if (!controlClean) console.log(`         flagged because: ${controlOffenders[0].reason}`);

let caught = 0;
for (const plant of PLANTS) {
  const offenders = gateWriterOffenders([plant.file]);
  const fired = offenders.length > 0;
  if (fired) caught += 1;
  console.log(`${fired ? 'CAUGHT ' : 'MISSED '}  ${plant.name}`);
  if (fired) console.log(`         -> ${offenders[0].reason}`);
  else console.log(`         -> ${plant.why}`);
}

const pass = controlClean && caught === PLANTS.length;
console.log(`\ncaught ${caught}/${PLANTS.length} plants, control ${controlClean ? 'clean' : 'FLAGGED'}`);
console.log(pass ? 'ACCEPTANCE MET' : 'ACCEPTANCE NOT MET');
process.exit(pass ? 0 : 1);
