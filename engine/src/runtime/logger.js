// Step logger. Copied from the platform (platform/ingest/runtime.js) because the
// same jsonl step stream powers the TUI activity feed and the gym live view
// (docs/daijin-build-plan.md, RPC events section).
import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function createLogger(logRoot) {
  await mkdir(logRoot, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const file = path.join(logRoot, `${stamp}-${process.pid}.jsonl`);
  return {
    file,
    async step(step, input, outcome, started = performance.now(), model = {}) {
      const row = {
        timestamp: new Date().toISOString(),
        step,
        input,
        outcome,
        duration_ms: Math.round(performance.now() - started),
        model: { id: model.id || null, tokens: model.tokens ?? null, cost_usd: model.cost ?? null },
      };
      await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
    },
  };
}

/// A logger that records nothing. The retrieval path takes a logger so the engine can
/// stream steps to the TUI; a measurement run does not need the files.
export function nullLogger() {
  return { file: null, async step() {} };
}

export async function acquireWriterLock(lockFile, logger, pipeline) {
  if (typeof pipeline !== 'string' || !pipeline.trim()) throw new Error('Writer-lock pipeline is required.');
  await mkdir(path.dirname(lockFile), { recursive: true });
  let reclaimed = null;
  try {
    const existing = JSON.parse(await readFile(lockFile, 'utf8'));
    if (Number.isInteger(existing.pid) && alive(existing.pid)) {
      throw new Error(`Another brain writer is active (PID ${existing.pid}).`);
    }
    reclaimed = existing;
    await unlink(lockFile);
  } catch (error) {
    if (error.code !== 'ENOENT' && !/Another brain writer/.test(error.message) && !(error instanceof SyntaxError)) throw error;
    if (/Another brain writer/.test(error.message)) throw error;
    if (error instanceof SyntaxError) await unlink(lockFile);
  }
  const handle = await open(lockFile, 'wx');
  await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString(), pipeline }));
  await handle.close();
  if (reclaimed) await logger.step('writer-lock', { stale_pid: reclaimed.pid }, 'reclaimed stale lock');
  return async () => {
    try {
      const current = JSON.parse(await readFile(lockFile, 'utf8'));
      if (current.pid === process.pid) await unlink(lockFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}
