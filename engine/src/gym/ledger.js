// The certification ledger: the gym's OWN store.
//
// D-0011 declared exam persistence, the project registry, and the ingest_run ledger OUT of
// Store v3, with the reason stated in the plan: "Gym writes only to its own store, never the
// user's git". P4 defines its own seam, and this is it. Three boundaries, each enforced in
// code rather than remembered:
//
//  1. NEVER the user's git. Nothing in the gym commits, adds, pushes, or tags. The sandbox
//     module's worktree operations are confined to a throwaway worktree it created itself.
//  2. NEVER the brain store's tables. `openGymStore` refuses a database carrying the brain's
//     schema, and stamps its own marker, so a mis-pointed path fails on open instead of
//     growing gym tables inside a user's brain. This is D-0012's hazard in the other
//     direction: the pgvector store already refuses to migrate a database carrying another
//     tool's ledger.
//  3. ONLY evaluation rows touch the scored record. `recordRun` stores the mode on every
//     row, every scored read filters on it, and `certify` refuses outright.
//
// The denominator rule is structural here too: `recordRun` REFUSES a row for a run that
// produced no applied diff. A cap-death has no row by construction, which is why the cohort
// denominator is counted from result files (result-files.js) and never from this table.
//
// The API is synchronous because better-sqlite3 is, and a gym cycle writes one row per exam.
// The Store contract is async for the retrieval path's sake; this seam has no such caller.

import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';

import { assertRunMode, assertScoredWrite, isGradableRun, isScoreableRun } from './run-mode.js';
import { examListRow, parseExamRecord } from './exams.js';
import { drawnExamCount } from './result-files.js';
import { hasExclusionRecord } from './provenance.js';
import { repoPaths } from '../state/layout.js';

/**
 * Where a repo's gym ledger lives: REPO-SIDE, and it does not follow the index relocation.
 *
 * D-0031 moves the machine-local INDEX out of the repo because it is disposable and
 * regenerable from the brain markdown. This is not that. The ledger holds certifications,
 * which are claims, and rubrics, which exist nowhere else; delete it and the project loses
 * its record rather than a cache it can rebuild. The extractor reached the same conclusion
 * independently in src/state/LAYOUT.md and left it unmoved, flagged rather than moved
 * quietly, which is why this still resolves under the repo.
 *
 * DELEGATED to the layout module rather than recomputed here. Two places computing one path
 * can disagree, which is exactly the defect just removed from certify(), and a storage path
 * that drifts between two modules is found the day a ledger silently starts empty.
 */
export function gymDatabasePath(repoPath) {
  return repoPaths(repoPath).gymDatabasePath;
}

/** Tables whose presence means this file is a BRAIN, not a gym ledger. */
const BRAIN_TABLES = Object.freeze(['document', 'chunks', 'chunk_vectors', 'relationship']);

const LEDGER_MARKER_KEY = 'ledger.kind';
const LEDGER_MARKER_VALUE = 'daijin-gym';

/** Terminal run statuses. `unsubmitted` is the platform's reclassification (TEACHER.md):
 *  a run with no applied diff never answered and so cannot have answered badly. */
export const RUN_STATUSES = Object.freeze([
  'completed', 'gates-regressed', 'metric-regressed', 'apply-error', 'unsubmitted',
]);

export const CYCLE_STATUSES = Object.freeze(['running', 'completed', 'aborted']);

export const MIGRATIONS = [
  {
    id: '001-gym-base',
    sql: `
      CREATE TABLE IF NOT EXISTS gym_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exam (
        exam_id           TEXT PRIMARY KEY,
        status            TEXT NOT NULL,
        benchmark_status  TEXT NOT NULL,
        quarantine_reason TEXT,
        held_out          INTEGER NOT NULL,
        scope_tier        TEXT NOT NULL,
        record            TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cycle (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        mode                TEXT NOT NULL,
        trigger             TEXT,
        started_at          TEXT NOT NULL,
        finished_at         TEXT,
        status              TEXT NOT NULL,
        config              TEXT NOT NULL DEFAULT '{}',
        brain_version_start TEXT,
        brain_version_end   TEXT
      );

      CREATE TABLE IF NOT EXISTS run (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_id           INTEGER REFERENCES cycle(id),
        exam_id            TEXT NOT NULL,
        mode               TEXT NOT NULL,
        status             TEXT NOT NULL,
        verdict            TEXT,
        result_file        TEXT NOT NULL,
        work_tokens        INTEGER,
        token_cap          INTEGER,
        extensions_granted INTEGER,
        sealed_state       TEXT,
        at                 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_cycle ON run(cycle_id);
      CREATE INDEX IF NOT EXISTS run_mode ON run(mode);

      CREATE TABLE IF NOT EXISTS certification (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id   INTEGER NOT NULL REFERENCES run(id),
        exam_id  TEXT NOT NULL,
        at       TEXT NOT NULL,
        verdict  TEXT NOT NULL,
        axes     TEXT NOT NULL,
        harness  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS certification_run ON certification(run_id);
    `,
  },
  {
    // Rubric persistence. Appended, never edited into 001: an edited applied migration would
    // apply to new ledgers and silently skip existing ones, leaving two schemas with one
    // version number, and migrate() refuses it.
    //
    // A RUBRIC TABLE, not a JSON column on `run`, and the reason is a property rather than a
    // preference. `recordRun` refuses a row for a run with no applied diff, so the `run`
    // table contains ONLY gradeable attempts. A foreign key from rubric to run therefore
    // makes P7 clause 5 structural at the storage layer: a rubric for a run that never
    // answered cannot be written, independently of whether the validator was called. A JSON
    // column would leave every row rubric-shaped and enforce nothing.
    //
    // The second reason is the same one certification is its own table: the run row is
    // written at cycle time by the harness, and the rubric arrives later from a different
    // actor. Two writers, two lifetimes, two tables.
    id: '002-rubrics',
    sql: `
      CREATE TABLE IF NOT EXISTS grade_batch (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        mode         TEXT NOT NULL,
        source       TEXT,
        at           TEXT NOT NULL,
        rubric_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rubric (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            INTEGER NOT NULL REFERENCES run(id),
        exam_id           TEXT NOT NULL,
        batch_id          INTEGER NOT NULL REFERENCES grade_batch(id),
        verdict           TEXT NOT NULL,
        axes              TEXT NOT NULL,
        gaps              TEXT NOT NULL DEFAULT '[]',
        author            TEXT,
        author_role       TEXT,
        reported_author   TEXT,
        task_digest       TEXT NOT NULL,
        submission_digest TEXT NOT NULL,
        at                TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rubric_run ON rubric(run_id);
      CREATE INDEX IF NOT EXISTS rubric_exam ON rubric(exam_id);
      CREATE INDEX IF NOT EXISTS rubric_batch ON rubric(batch_id);
    `,
  },
  {
    // A certification names the rubric it snapshotted, so "these two agree" is checkable
    // rather than assumed. Nullable rather than NOT NULL because a column added by migration
    // cannot be required of rows that predate it; null means a certification written before
    // the axes were derived, and there are none in any shipped ledger.
    id: '003-certification-rubric',
    sql: `
      ALTER TABLE certification ADD COLUMN rubric_id INTEGER REFERENCES rubric(id);
    `,
  },
];

/** A stored rubric, back in the shape grading.js authored: axes keyed by name, gaps a list. */
function hydrateRubric(row) {
  return {
    id: row.id,
    runId: row.run_id,
    examId: row.exam_id,
    batchId: row.batch_id,
    verdict: row.verdict,
    axes: JSON.parse(row.axes),
    gaps: JSON.parse(row.gaps),
    author: row.author,
    authorRole: row.author_role,
    ...(row.reported_author ? { reportedAuthor: row.reported_author } : {}),
    taskDigest: row.task_digest,
    submissionDigest: row.submission_digest,
    at: row.at,
  };
}

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

function tableNames(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
}

/**
 * Open (or create) the gym ledger database.
 *
 * Refuses a database that carries brain tables, and refuses one that carries a foreign
 * marker. The check is on OPEN rather than on first write because the damage of the mistake
 * (gym tables growing inside a user's brain, or a gym ledger overwritten by a brain ingest)
 * is done by the time anything writes.
 */
export function openGymStore(file, { driver = Database } = {}) {
  const database = new driver(file);
  database.pragma('foreign_keys = ON');
  const existing = tableNames(database);
  const brainTables = existing.filter((name) => BRAIN_TABLES.includes(name));
  if (brainTables.length > 0) {
    database.close();
    throw new Error(`Refusing to use ${file} as a gym ledger: it carries brain tables (${brainTables.join(', ')}). The gym writes only to its own store.`);
  }
  if (existing.includes('gym_meta')) {
    const marker = database.prepare('SELECT value FROM gym_meta WHERE key = ?').get(LEDGER_MARKER_KEY);
    if (marker && marker.value !== LEDGER_MARKER_VALUE) {
      database.close();
      throw new Error(`Refusing to use ${file} as a gym ledger: it is marked ${marker.value}.`);
    }
  }
  return database;
}

export class GymLedger {
  constructor(database) {
    this.database = database;
    this.migrate();
  }

  static open(file, options = {}) {
    return new GymLedger(openGymStore(file, options));
  }

  /** Apply pending migrations, refusing an edited-but-applied one. Same rule as the brain
   *  store: an edited migration would apply to new ledgers and silently skip existing ones,
   *  leaving two schemas with one version number. */
  migrate() {
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const applied = new Map(this.database.prepare('SELECT id, checksum FROM schema_migration').all().map((row) => [row.id, row.checksum]));
    for (const migration of MIGRATIONS) {
      const sum = checksum(migration.sql);
      if (applied.has(migration.id)) {
        if (applied.get(migration.id) !== sum) {
          throw new Error(`Gym migration ${migration.id} was edited after it was applied; append a new migration instead.`);
        }
        continue;
      }
      this.database.exec(migration.sql);
      this.database.prepare('INSERT INTO schema_migration (id, checksum, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, sum, new Date().toISOString());
    }
    this.database.prepare('INSERT OR IGNORE INTO gym_meta (key, value) VALUES (?, ?)').run(LEDGER_MARKER_KEY, LEDGER_MARKER_VALUE);
  }

  close() {
    this.database.close();
  }

  // Exam bank.

  putExam(record) {
    const exam = parseExamRecord(record, record?.examId || record?.id || 'exam');
    this.database.prepare(`
      INSERT INTO exam (exam_id, status, benchmark_status, quarantine_reason, held_out, scope_tier, record, updated_at)
      VALUES (@examId, @status, @benchmarkStatus, @quarantineReason, @heldOut, @scopeTier, @record, @updatedAt)
      ON CONFLICT(exam_id) DO UPDATE SET
        status = excluded.status, benchmark_status = excluded.benchmark_status,
        quarantine_reason = excluded.quarantine_reason, held_out = excluded.held_out,
        scope_tier = excluded.scope_tier, record = excluded.record, updated_at = excluded.updated_at
    `).run({
      examId: exam.examId,
      status: exam.status,
      benchmarkStatus: exam.benchmarkStatus,
      quarantineReason: exam.quarantineReason,
      heldOut: exam.heldOut ? 1 : 0,
      scopeTier: exam.scopeTier,
      record: JSON.stringify(exam),
      updatedAt: new Date().toISOString(),
    });
    return exam;
  }

  getExam(examId) {
    const row = this.database.prepare('SELECT record FROM exam WHERE exam_id = ?').get(examId);
    return row ? JSON.parse(row.record) : null;
  }

  /** examList, RPC v4: the two orthogonal axes plus heldOut, filterable on either. */
  listExams(filters = {}) {
    const rows = this.database.prepare('SELECT record FROM exam ORDER BY exam_id').all().map((row) => JSON.parse(row.record));
    return rows.filter((exam) => (
      (filters.status === undefined || exam.status === filters.status)
      && (filters.benchmarkStatus === undefined || exam.benchmarkStatus === filters.benchmarkStatus)
      && (filters.heldOut === undefined || exam.heldOut === filters.heldOut)
    )).map(examListRow);
  }

  // Cycles and runs.

  startCycle({ mode, trigger = 'manual', config = {}, brainVersionStart = null }) {
    assertRunMode(mode);
    const info = this.database.prepare(`
      INSERT INTO cycle (mode, trigger, started_at, status, config, brain_version_start)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(mode, trigger, new Date().toISOString(), JSON.stringify(config), brainVersionStart);
    return Number(info.lastInsertRowid);
  }

  finishCycle(cycleId, { status = 'completed', brainVersionEnd = null } = {}) {
    if (!CYCLE_STATUSES.includes(status)) throw new Error(`Unknown cycle status: ${status}`);
    this.database.prepare('UPDATE cycle SET status = ?, finished_at = ?, brain_version_end = ? WHERE id = ?')
      .run(status, new Date().toISOString(), brainVersionEnd, cycleId);
  }

  /**
   * Record ONE run row.
   *
   * REFUSES a run with no applied diff. That refusal is the denominator rule made
   * structural: if a cap-death could write a row, the cohort denominator would look
   * derivable from this table, and every throughput number computed from it would silently
   * drop exactly the failures it exists to expose.
   */
  recordRun({
    cycleId = null, examId, mode, status, verdict = null, resultFile, applied,
    workTokens = null, tokenCap = null, extensionsGranted = null, sealedState = null, at = null,
  }) {
    assertRunMode(mode);
    if (!RUN_STATUSES.includes(status)) throw new Error(`Unknown run status: ${status}`);
    if (applied !== true) {
      throw new Error(
        `Refusing a ledger row for ${examId}: the run produced no applied diff. `
        + 'A row is evidence of a graded attempt, never of a drawn one; the result file is the drawn record.',
      );
    }
    if (!resultFile) throw new Error(`Refusing a ledger row for ${examId}: every row must point at its result file.`);
    const info = this.database.prepare(`
      INSERT INTO run (cycle_id, exam_id, mode, status, verdict, result_file, work_tokens, token_cap, extensions_granted, sealed_state, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cycleId, examId, mode, status, verdict, resultFile, workTokens, tokenCap, extensionsGranted, sealedState, at || new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  getRun(runId) {
    return this.database.prepare('SELECT * FROM run WHERE id = ?').get(runId) || null;
  }

  /** Rows for a cycle. `scoredOnly` is the default because a caller that wants every mode
   *  should have to say so, which is the inverse of how a filter gets forgotten. */
  cycleRuns(cycleId, { scoredOnly = true } = {}) {
    return scoredOnly
      ? this.database.prepare("SELECT * FROM run WHERE cycle_id = ? AND mode = 'evaluation' ORDER BY id").all(cycleId)
      : this.database.prepare('SELECT * FROM run WHERE cycle_id = ? ORDER BY id').all(cycleId);
  }

  // Rubrics (P7 clauses 5, 9 and 21 at the storage layer).

  /**
   * Write a VALIDATED batch of rubrics, atomically.
   *
   * This is clause 9 becoming a real transaction on disk. `importRubrics` in grading.js
   * validates the whole batch and returns it or throws; this writes the whole batch or
   * writes nothing. A refused batch must leave the store byte-identical, and half a graded
   * cohort looks like a graded cohort.
   *
   * It does NOT validate. Validation is grading.js's job and doing it twice in two places is
   * how the two drift; what this enforces are the three things only storage can:
   *  - a rubric for a run with no row is impossible (the foreign key, and `run` holds only
   *    attempts that produced a diff, so clause 5 holds without asking the validator);
   *  - one rubric per run (the unique index), so a re-import cannot quietly double-grade;
   *  - a rubric only from a GRADABLE mode, so a harness-debug cohort cannot be graded into
   *    the record (clause 21).
   */
  importRubricBatch({ rubrics, mode, source = null, at = null }) {
    assertRunMode(mode);
    if (!isGradableRun(mode)) {
      throw new Error(
        `Refusing to store rubrics from mode ${mode}; only evaluation and experiment runs are graded. `
        + 'A harness-debug cohort is recorded and never graded into the record.',
      );
    }
    if (!Array.isArray(rubrics) || rubrics.length === 0) throw new Error('A rubric batch must carry at least one rubric.');
    const stamp = at || new Date().toISOString();

    const write = this.database.transaction(() => {
      const batchId = Number(this.database.prepare(
        'INSERT INTO grade_batch (mode, source, at, rubric_count) VALUES (?, ?, ?, ?)',
      ).run(mode, source, stamp, rubrics.length).lastInsertRowid);

      const insert = this.database.prepare(`
        INSERT INTO rubric (run_id, exam_id, batch_id, verdict, axes, gaps, author, author_role,
                            reported_author, task_digest, submission_digest, at)
        VALUES (@runId, @examId, @batchId, @verdict, @axes, @gaps, @author, @authorRole,
                @reportedAuthor, @taskDigest, @submissionDigest, @at)
      `);
      for (const rubric of rubrics) {
        const run = this.getRun(rubric.runId);
        if (!run) {
          // Named before the foreign key fires, because "FOREIGN KEY constraint failed" does
          // not tell an operator that the run never produced a diff.
          throw new Error(
            `Refusing to store a rubric for run ${rubric.runId}: no such run row. `
            + 'A run with no applied diff has no row by design, and a rubric may not be written for it.',
          );
        }
        if (run.mode !== mode) {
          throw new Error(`Rubric for run ${rubric.runId} arrived in a ${mode} batch, but that run is ${run.mode}.`);
        }
        insert.run({
          runId: rubric.runId,
          examId: rubric.examId ?? run.exam_id,
          batchId,
          verdict: rubric.verdict,
          axes: JSON.stringify(rubric.axes ?? {}),
          gaps: JSON.stringify(rubric.gaps ?? []),
          author: rubric.author ?? null,
          authorRole: rubric.authorRole ?? null,
          reportedAuthor: rubric.reportedAuthor ?? null,
          taskDigest: rubric.taskDigest,
          submissionDigest: rubric.submissionDigest,
          at: stamp,
        });
      }
      return batchId;
    });
    return write();
  }

  /** One run's rubric, parsed, or null. `axes` comes back KEYED BY NAME, which is how
   *  grading.js authors and validates it; the daemon's axesFor maps it to the ordered wire
   *  list at the boundary (methods.md finding 79). */
  rubricFor(runId) {
    const row = this.database.prepare('SELECT * FROM rubric WHERE run_id = ?').get(runId);
    return row ? hydrateRubric(row) : null;
  }

  /**
   * An exam's attempts, newest first, each carrying its rubric or null.
   *
   * This exists so no caller has to reach past the ledger into the tables with its own SQL.
   * The daemon's examDetail did exactly that, which coupled the RPC surface to a schema it
   * does not own, and this schema just changed under it.
   */
  attemptsForExam(examId) {
    const runs = this.database.prepare('SELECT * FROM run WHERE exam_id = ? ORDER BY id DESC').all(examId);
    const rubrics = new Map(this.database.prepare('SELECT * FROM rubric WHERE exam_id = ?').all(examId)
      .map((row) => [row.run_id, hydrateRubric(row)]));
    return runs.map((run) => ({ ...run, rubric: rubrics.get(run.id) ?? null }));
  }

  gradeBatches() {
    return this.database.prepare('SELECT * FROM grade_batch ORDER BY id DESC').all();
  }

  // Certification.

  /**
   * Certify a run. The strictest write in the ledger, and every refusal below has a reason
   * that outlives the person who remembers it:
   *  - non-evaluation mode: an experiment arm that certifies is a scored record with no
   *    cohort behind it;
   *  - no rubric: a pass claim with nothing behind it;
   *  - non-pass verdict: a certification is a claim that the student passed;
   *  - quarantined exam: measurement integrity, checked AT certification time because an
   *    exam can be quarantined between the run and the grade.
   *
   * THE AXES ARE COPIED FROM THE STORED RUBRIC, never supplied by the caller.
   *
   * `certification.axes` predates the rubric table and was written from a caller-supplied
   * value that DEFAULTED TO `{}`, so a certification could persist finding 79's forbidden
   * value into the strictest record in the ledger: an empty axes set renders on a radar
   * exactly like a set of measured zeros. Found by the extractor while reading this file.
   *
   * The fix is to delete the parameter rather than validate it. Two records holding the same
   * five numbers can disagree; one record DERIVED from the other cannot. So the certification
   * keeps its immutable snapshot, because a claim should carry its evidence beside the
   * harness provenance, and the snapshot is taken from the grading record rather than written
   * independently. `rubric_id` records which rubric it was taken from, so the agreement is
   * checkable later rather than assumed.
   *
   * `verdict` follows the same rule: the STORED verdict comes from the rubric, and a verdict
   * the caller supplies is treated as an ASSERTION to check, not as a value to store. That is
   * the general shape worth keeping: assertions are checked, records are derived.
   */
  certify({ runId, verdict = null, harness = {}, artifact = null }) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Cannot certify unknown run ${runId}.`);
    assertScoredWrite(run.mode, 'a certification');
    const rubric = this.rubricFor(runId);
    if (!rubric) {
      throw new Error(
        `Refusing to certify run ${runId}: no rubric is stored for it. A certification is a claim that the `
        + 'student passed, and a pass with no grading record behind it has nothing to show.',
      );
    }
    if (verdict !== null && verdict !== rubric.verdict) {
      throw new Error(
        `Refusing to certify run ${runId}: the caller asserts ${verdict} and the stored rubric says ${rubric.verdict}. `
        + 'The rubric is the record; a disagreement means the caller is certifying something it has not read.',
      );
    }
    // D-0020: a scored run must be able to SHOW what it withheld from the student. Without a
    // computed gold-provenance exclusion record, "the student never saw gold" is a hope
    // about this run rather than a property of it, and a certification is exactly the claim
    // that cannot rest on a hope. An EMPTY exclusion certifies fine; an absent one does not.
    if (!hasExclusionRecord(artifact)) {
      throw new Error(
        `Refusing to certify run ${runId}: its artifact carries no gold-provenance exclusion record. `
        + 'A certification asserts the student never saw gold, and that assertion needs the computed exclusion behind it.',
      );
    }
    if (rubric.verdict !== 'pass') {
      throw new Error(`Refusing to certify run ${runId} with verdict ${rubric.verdict}; a certification records a pass.`);
    }
    const exam = this.getExam(run.exam_id);
    if (!exam) throw new Error(`Cannot certify run ${runId}: exam ${run.exam_id} is not in the bank.`);
    if (exam.benchmarkStatus !== 'active') {
      throw new Error(`Refusing to certify ${run.exam_id}: it is quarantined (${exam.quarantineReason}).`);
    }
    if (!harness || typeof harness !== 'object' || Object.keys(harness).length === 0) {
      throw new Error('A certification must carry the harness provenance it was earned under; an uncontextualized pass is not reproducible.');
    }
    const info = this.database.prepare(`
      INSERT INTO certification (run_id, exam_id, rubric_id, at, verdict, axes, harness)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId, run.exam_id, rubric.id, new Date().toISOString(), rubric.verdict,
      // Copied from the rubric, never from a parameter: the snapshot cannot disagree with
      // the record it was taken from.
      JSON.stringify(rubric.axes), JSON.stringify(harness),
    );
    return Number(info.lastInsertRowid);
  }

  certifications() {
    return this.database.prepare('SELECT * FROM certification ORDER BY id').all()
      .map((row) => ({ ...row, axes: JSON.parse(row.axes), harness: JSON.parse(row.harness) }));
  }

  // Reporting.

  /**
   * The drawn cohort for a cycle, counted from result files.
   *
   * The lower bound comes from the PRECEDING cycle's last row-backed file, so a leading
   * cap-death is inside the window rather than before it. Null when no preceding cycle
   * exists: the first cycle in a series has no principled lower bound.
   */
  drawnForCycle(cycleId, resultFiles) {
    if (!Array.isArray(resultFiles)) return null;
    const rows = this.cycleRuns(cycleId).map((row) => ({ resultFile: row.result_file }));
    const previous = this.database.prepare(
      "SELECT id FROM cycle WHERE id < ? AND mode = 'evaluation' ORDER BY id DESC LIMIT 1",
    ).get(cycleId);
    if (!previous) return null;
    const previousPaths = new Set(this.cycleRuns(previous.id).map((row) => row.result_file));
    const previousStamps = resultFiles.filter((file) => previousPaths.has(file.path)).map((file) => String(file.at)).sort();
    const previousCycleLastFileAt = previousStamps.at(-1) || null;
    return drawnExamCount(rows, resultFiles, { previousCycleLastFileAt });
  }

  /** The gymStatus ledger payload, RPC v4. `drawnFromResultFiles` is the denominator rule
   *  made visible in the wire format. */
  summary({ mode = null, cycleId = null, resultFiles = null } = {}) {
    const scoredWrites = this.database.prepare("SELECT count(*) AS n FROM run WHERE mode = 'evaluation'").get().n;
    const rowsWritten = this.database.prepare('SELECT count(*) AS n FROM run').get().n;
    const certifications = this.database.prepare('SELECT count(*) AS n FROM certification').get().n;
    const exams = this.database.prepare('SELECT count(*) AS n FROM exam').get().n;
    const target = cycleId ?? this.database.prepare('SELECT id FROM cycle ORDER BY id DESC LIMIT 1').get()?.id ?? null;
    return {
      mode: mode ?? (target ? this.database.prepare('SELECT mode FROM cycle WHERE id = ?').get(target)?.mode ?? null : null),
      scoredWrites,
      drawnFromResultFiles: target !== null && resultFiles ? this.drawnForCycle(target, resultFiles) : null,
      rowsWritten,
      certifications,
      exams,
    };
  }
}

/** Exported for the mode-quarantine tests: the ledger's own view of what may be scored. */
export { isScoreableRun };

/** Git subcommands that write to a repository's history or remotes. None of them may appear
 *  in gym code: the gym reads the user's history and creates its own throwaway worktrees,
 *  and it never records anything in the user's git. */
const FORBIDDEN_GIT_SUBCOMMANDS = Object.freeze([
  'commit', 'push', 'tag', 'stash', 'rebase', 'merge', 'cherry-pick', 'remote', 'am', 'revert',
]);
const GIT_CALL = /['"`]git['"`]/g;
const GIT_WINDOW = 200;

/**
 * The mechanical form of "never the user's git".
 *
 * Scans gym sources for a git invocation whose nearby argument text names a
 * history-writing subcommand. `worktree`, `reset`, `clean`, `apply` and `add` are ALLOWED:
 * every one of them operates inside a throwaway worktree the gym created itself, and
 * removing them would remove the sandbox rather than protect the repository.
 *
 * @param {{path: string, source: string}[]} files
 */
export function gitWriteOffenders(files) {
  const offenders = [];
  for (const { path: file, source } of files) {
    for (const match of String(source).matchAll(GIT_CALL)) {
      const window = String(source).slice(match.index, match.index + GIT_WINDOW);
      const found = FORBIDDEN_GIT_SUBCOMMANDS.find((subcommand) => (
        new RegExp(`['"\`]${subcommand}['"\`]`).test(window)
      ));
      if (found) {
        offenders.push({ path: file, reason: `git ${found} in gym code; the gym never writes the user's git` });
        break;
      }
    }
  }
  return offenders;
}
