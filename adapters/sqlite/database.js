// Connection factory: opens a SQLite file with sqlite-vec loaded and pragmas set.
//
// WHERE the file lives is deliberately not here. It used to be, as brainDatabasePath, back
// when the index sat inside the repo; D-0031 moved the index to the state root keyed by a
// manifest id, and that derivation belongs to engine/src/state/layout.js so there is one
// implementation of the key rather than two that can disagree about the same repo.
//
// The driver is injected rather than imported. adapters/ sits outside engine/, so a bare
// `import Database from 'better-sqlite3'` here would resolve from daijin/node_modules,
// which does not exist; the dependency lives in engine/package.json. Injection keeps one
// installed copy of the native module (two copies would mean two SQLite libraries in one
// process) and leaves this directory free of node_modules. engine/src/store/sqlite.js
// supplies the driver. If the repo later gains a root workspace, this can go back to a
// direct import without changing any caller.
//
// The engine holds exactly one connection per brain. WAL plus a busy timeout lets the MCP
// server read while an ingest writes; the store's own transaction depth counter is what
// serializes writers inside the process.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function isInMemory(path) {
  return path === ':memory:' || String(path).startsWith('file::memory:');
}

/**
 * @param {string} path
 * @param {object} driver
 * @param {Function} driver.Database   better-sqlite3 constructor.
 * @param {object} driver.sqliteVec    sqlite-vec module, used for its load(db) call.
 */
export function openDatabase(path, { Database, sqliteVec, readonly = false, busyTimeoutMs = 5_000 } = {}) {
  if (typeof Database !== 'function') throw new Error('openDatabase requires the better-sqlite3 Database constructor.');
  if (typeof sqliteVec?.load !== 'function') throw new Error('openDatabase requires the sqlite-vec module.');

  const inMemory = isInMemory(path);
  if (!inMemory && !readonly) mkdirSync(dirname(resolve(path)), { recursive: true });

  const database = new Database(path, { readonly });
  sqliteVec.load(database);
  database.pragma('foreign_keys = ON');
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  if (!inMemory && !readonly) database.pragma('journal_mode = WAL');
  return database;
}

/** Versions of the two extensions the recipe depends on, for the health gate. */
export function engineVersions(database) {
  return {
    sqlite: database.prepare('SELECT sqlite_version() AS value').get().value,
    sqliteVec: database.prepare('SELECT vec_version() AS value').get().value,
  };
}
