// Reproduce the CI failure by construction: start the discovery JOB, do not drain it, then
// do exactly what the failing test does. If the job's writer lands between the set and the
// get, gatesGet returns generated content the user never wrote.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENGINE = '/Users/mfuad16/Documents/daijin/engine';
const { createRpcServer } = await import(`${ENGINE}/src/rpc/server.js`);

const stateRoot = await mkdtemp(path.join(tmpdir(), 'gates-race-state-'));
const repoPath = await mkdtemp(path.join(tmpdir(), 'gates-race-repo-'));
await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
await writeFile(path.join(repoPath, 'package.json'),
  JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0', lint: 'exit 0', build: 'exit 0' } }), 'utf8');

const server = createRpcServer({ stateRoot, write: () => {} });
await server.methods.repoAttach({ repoPath });

// The surface sweep calls this and moves on. It returns a jobId immediately; the work
// continues in the background, and the work WRITES gates.yaml.
const { jobId } = await server.methods.gatesDiscover({ repoPath });
console.log('discovery job started:', jobId, '(not drained, exactly as the sweep leaves it)');

const content = 'gates:\n  - name: test\n    command: exit 0\n';
await server.methods.gatesSet({ repoPath, patch: { content } });
const read = await server.methods.gatesGet({ repoPath });
const clobberedImmediately = read.content !== content;
console.log('immediately after set: clobbered =', clobberedImmediately);

// Now let the job finish, which is what "milliseconds later" means in the CI log.
await server.jobs.drain();
const after = await server.methods.gatesGet({ repoPath });
console.log('after the job lands:  clobbered =', after.content !== content);
if (after.content !== content) {
  console.log('  what the user wrote is gone; the file now starts:');
  console.log('  ' + after.content.split('\n').slice(0, 2).join('\n  '));
}
await server.close();
