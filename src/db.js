'use strict';

const { createClient } = require('@libsql/client');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// En production les dades són a Turso i els fitxers a Supabase Storage.
// En local (sense LIBSQL_URL) fem servir el fitxer data/aula.db per poder provar-ho tot.
const IS_REMOTE = Boolean(process.env.LIBSQL_URL);
if (!IS_REMOTE) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const client = createClient({
  url: process.env.LIBSQL_URL || `file:${path.join(DATA_DIR, 'aula.db')}`,
  authToken: process.env.LIBSQL_AUTH_TOKEN || undefined,
});

// Perquè les sentències dins d'una transacció usin el client de la transacció.
const transactionStore = new AsyncLocalStorage();
function executor() {
  return transactionStore.getStore() || client;
}

function normalizedArgs(values) {
  const args = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
  return args.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

// API compatible amb node:sqlite, però asíncrona. Així la majoria del codi
// existent només necessita afegir `await` davant de cada crida.
const db = {
  prepare(sql) {
    return {
      async get(...values) {
        const result = await executor().execute({ sql, args: normalizedArgs(values) });
        return result.rows[0];
      },
      async all(...values) {
        const result = await executor().execute({ sql, args: normalizedArgs(values) });
        return result.rows;
      },
      async run(...values) {
        const result = await executor().execute({ sql, args: normalizedArgs(values) });
        return {
          changes: Number(result.rowsAffected),
          lastInsertRowid: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
        };
      },
    };
  },

  async exec(sql) {
    await executor().executeMultiple(sql);
  },

  async transaction(fn) {
    const tx = await client.transaction('write');
    try {
      const result = await transactionStore.run(tx, fn);
      await tx.commit();
      return result;
    } catch (error) {
      try { await tx.rollback(); } catch { /* ja desfet */ }
      throw error;
    }
  },
};

const DEFAULT_YEAR = '2026-2027';

async function columnsOf(table) {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((column) => column.name));
}

async function initDb() {
  try { await db.exec('PRAGMA foreign_keys = ON'); } catch { /* no disponible en el motor remot */ }
  try { await db.exec('PRAGMA journal_mode = WAL'); } catch { /* només local */ }
  try { await db.exec('PRAGMA busy_timeout = 5000'); } catch { /* només local */ }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS school_years (
      year       TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
      active_class_id INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      subject     TEXT NOT NULL DEFAULT '',
      level       TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT '',
      school_year TEXT NOT NULL,
      code        TEXT NOT NULL UNIQUE,
      teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (class_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_year  TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      subject      TEXT NOT NULL DEFAULT '',
      level        TEXT NOT NULL DEFAULT '',
      activity_type TEXT NOT NULL DEFAULT '',
      difficulty   TEXT NOT NULL DEFAULT 'mitjana',
      duration_min INTEGER,
      objectives   TEXT NOT NULL DEFAULT '',
      tags         TEXT NOT NULL DEFAULT '[]',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id     INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_year  TEXT NOT NULL,
      title        TEXT NOT NULL,
      session_date TEXT NOT NULL,
      start_time   TEXT,
      end_time     TEXT,
      objectives   TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'planificada',
      timetable_id INTEGER REFERENCES timetable(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS timetable (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_id    INTEGER REFERENCES classes(id) ON DELETE SET NULL,
      school_year TEXT NOT NULL,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
      start_time  TEXT NOT NULL,
      end_time    TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'class' CHECK (kind IN ('class', 'guard', 'meeting')),
      label       TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      activity_id  INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      instructions TEXT NOT NULL DEFAULT '',
      due_at       TEXT,
      position     INTEGER NOT NULL DEFAULT 0,
      UNIQUE (session_id, activity_id)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id  INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text           TEXT NOT NULL DEFAULT '',
      file_name      TEXT,
      file_path      TEXT,
      file_mime      TEXT,
      file_size      INTEGER,
      submitted_at   TEXT,
      grade          REAL,
      feedback       TEXT NOT NULL DEFAULT '',
      graded_at      TEXT,
      graded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (assignment_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id, school_year);
    CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
    CREATE INDEX IF NOT EXISTS idx_activities_teacher ON activities(teacher_id, school_year);
    CREATE INDEX IF NOT EXISTS idx_sessions_class_date ON sessions(class_id, session_date);
    CREATE INDEX IF NOT EXISTS idx_sessions_year ON sessions(school_year);
    CREATE INDEX IF NOT EXISTS idx_assignments_session ON assignments(session_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
    CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON timetable(teacher_id, school_year, day_of_week, start_time);
  `);

  const timetableColumns = await columnsOf('timetable');
  if (!timetableColumns.has('school_year')) {
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.exec(`
      CREATE TABLE timetable_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        class_id    INTEGER REFERENCES classes(id) ON DELETE SET NULL,
        school_year TEXT NOT NULL DEFAULT '${DEFAULT_YEAR}',
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
        start_time  TEXT NOT NULL,
        end_time    TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'class' CHECK (kind IN ('class', 'guard', 'meeting')),
        label       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO timetable_new (id, teacher_id, class_id, school_year, day_of_week, start_time, end_time, kind, label, created_at)
      SELECT id, teacher_id, class_id, '${DEFAULT_YEAR}', day_of_week, start_time, end_time, kind, label, created_at
      FROM timetable;
      DROP TABLE timetable;
      ALTER TABLE timetable_new RENAME TO timetable;
    `);
    await db.exec('PRAGMA foreign_keys = ON');
  }

  for (const [table, column, definition] of [
    ['users', 'active_class_id', 'INTEGER'],
    ['classes', 'color', "TEXT NOT NULL DEFAULT ''"],
    ['activities', 'school_year', `TEXT NOT NULL DEFAULT '${DEFAULT_YEAR}'`],
    ['sessions', 'school_year', `TEXT NOT NULL DEFAULT '${DEFAULT_YEAR}'`],
    ['sessions', 'start_time', 'TEXT'],
    ['sessions', 'end_time', 'TEXT'],
    ['sessions', 'timetable_id', 'INTEGER REFERENCES timetable(id) ON DELETE SET NULL'],
  ]) {
    if (!(await columnsOf(table)).has(column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_timetable_slot
    ON timetable(teacher_id, school_year, day_of_week, start_time);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_generated
    ON sessions(timetable_id, session_date) WHERE timetable_id IS NOT NULL;
  `);
}

module.exports = { db, client, initDb, ROOT, DATA_DIR, UPLOADS_DIR, DEFAULT_YEAR, IS_REMOTE };
