// Record the TOTAL chunk count the fixture produces, per process, so two commits can be
// compared like for like rather than by remembering a number from an error message.
import { appendFileSync } from 'node:fs';
const engine = process.env.PROBE_ENGINE;
const { SqliteStore } = await import(`${engine}/src/store/sqlite.js`);
const original = SqliteStore.prototype.replaceChunks;
let total = 0;
SqliteStore.prototype.replaceChunks = async function replaceChunks(id, chunks) {
  total += chunks.length;
  appendFileSync(process.env.PROBE_LOG, `${id}\t${chunks.length}\t${total}\n`);
  return original.call(this, id, chunks);
};
