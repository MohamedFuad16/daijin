// Is the embedder present? Asked at the end of an install, answered without judgement.
//
// Retrieval needs a local Ollama serving the embedding model. That is a RUNTIME
// dependency, not an install dependency: the install is complete and correct without it,
// and the engine can be installed on a machine that gets its embedder later. So this
// probe never fails an install. It exists so the installer can tell the truth in its last
// line rather than print "Daijin is installed" and let a first run discover the gap.
//
// It writes detail to stdout for the log and says everything else through its exit code,
// so the message a user reads lives in one place, the installer, in one voice.
//
//   0  reachable and serving the model
//   3  reachable but the model is not installed
//   4  not reachable
//   2  used wrongly (missing argument)
//
// No dependency and no downloader: this is one fetch to a URL the caller passes, which is
// how the installer keeps its "no network beyond package registries" property honest. The
// only endpoint it ever contacts is the one named on the command line.

import process from 'node:process';

const TIMEOUT_MS = 4_000;

function argument(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = argument('--url');
const model = argument('--model');
if (!url || !model) {
  process.stderr.write('probe-ollama: --url and --model are required.\n');
  process.exit(2);
}

const base = url.replace(/\/$/, '');

let response;
try {
  response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
} catch (error) {
  process.stdout.write(`probe: ${base} is not reachable (${error.message})\n`);
  process.exit(4);
}

if (!response.ok) {
  process.stdout.write(`probe: ${base} answered HTTP ${response.status}\n`);
  process.exit(4);
}

let tags;
try {
  tags = await response.json();
} catch (error) {
  process.stdout.write(`probe: ${base} answered something that is not JSON (${error.message})\n`);
  process.exit(4);
}

// Ollama reports a tag as "name:tag"; a bare model name matches its latest tag. Compared
// on the served list rather than on a catalogue, because what is installed is the only
// thing that matters here.
const installed = (tags.models || []).map((entry) => entry.model || entry.name || '');
const present = installed.some((entry) => entry === model || entry.split(':')[0] === model);

if (!present) {
  process.stdout.write(`probe: ${base} is reachable but is not serving ${model}`
    + `${installed.length ? ` (it has: ${installed.join(', ')})` : ' (it has no models at all)'}\n`);
  process.exit(3);
}

process.stdout.write(`probe: ${base} is serving ${model}\n`);
process.exit(0);
