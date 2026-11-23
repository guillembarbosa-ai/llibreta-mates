'use strict';

const crypto = require('node:crypto');
const { db, DEFAULT_YEAR } = require('./db');

const CURRENT_KEY = 'current_school_year';

function classCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('');
}

async function uniqueClassCode() {
  let code;
  do {
    code = classCode();
  } while (await db.prepare('SELECT 1 FROM classes WHERE code = ?').get(code));
  return code;
}

/** Crea la configuració inicial si no existeix. */
async function ensureDefaults() {
  if (!await db.prepare('SELECT 1 FROM settings WHERE key = ?').get(CURRENT_KEY)) {
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(CURRENT_KEY, DEFAULT_YEAR);
  }
  await db.prepare('INSERT OR IGNORE INTO school_years (year) VALUES (?)').run(DEFAULT_YEAR);
}

async function currentYear() {
  await ensureDefaults();
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(CURRENT_KEY);
  return row.value;
}

async function setCurrentYear(year) {
  await ensureDefaults();
  await db.transaction(async () => {
    await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(year, CURRENT_KEY);
    // El grup actiu pertany al curs anterior: el deixem sense seleccionar.
    await db.prepare('UPDATE users SET active_class_id = NULL').run();
  });
}

/** Grup classe actiu d'un professor. null vol dir "tots els grups". */
async function currentClassId(teacherId) {
  const row = await db.prepare(`
    SELECT u.active_class_id, c.id AS valid_id, c.school_year
    FROM users u
    LEFT JOIN classes c ON c.id = u.active_class_id AND c.teacher_id = u.id
    WHERE u.id = ?
  `).get(teacherId);
  if (!row || !row.active_class_id || !row.valid_id || row.school_year !== await currentYear()) return null;
  return Number(row.active_class_id);
}

async function setCurrentClass(teacherId, classId) {
  await db.prepare('UPDATE users SET active_class_id = ? WHERE id = ?').run(classId || null, teacherId);
}

/** Grups del professor per al curs actiu, per al desplegable de la barra lateral. */
async function selectableClasses(teacherId) {
  return db.prepare(`
    SELECT id, name, color FROM classes
    WHERE teacher_id = ? AND school_year = ? ORDER BY name ASC
  `).all(teacherId, await currentYear());
}

async function listYears() {
  await ensureDefaults();
  const rows = await db.prepare(`
    SELECT year FROM school_years
    UNION
    SELECT DISTINCT school_year AS year FROM classes WHERE school_year <> ''
    UNION
    SELECT DISTINCT school_year AS year FROM sessions WHERE school_year <> ''
    ORDER BY year DESC
  `).all();
  const current = await currentYear();
  if (!rows.some((row) => row.year === current)) rows.push({ year: current });
  return rows.map((row) => row.year).sort().reverse();
}

async function yearExists(year) {
  return Boolean(await db.prepare('SELECT 1 FROM school_years WHERE year = ?').get(year));
}

function isValidYear(year) {
  return /^\d{4}-\d{4}$/.test(year) && Number(year.slice(5)) === Number(year.slice(0, 4)) + 1;
}

function guessLevel(name) {
  if (/batx/i.test(name)) return 'Batxillerat';
  if (/eso/i.test(name)) return 'ESO';
  if (/primària/i.test(name)) return 'Primària';
  return '';
}

/**
 * Crea un curs nou. No copia alumnes, sessions ni lliuraments.
 * Opcionalment copia la plantilla d'horari (grups + franges) i la biblioteca d'activitats.
 */
async function createYear({ year, teacherId, copyTimetable = true, copyActivities = false, sourceYear = null }) {
  const from = sourceYear || await currentYear();
  if (!isValidYear(year)) throw new Error('Escriu el curs amb el format 2026-2027.');
  if (await yearExists(year)) throw new Error('Aquest curs ja existeix.');

  const result = { year, classes: 0, entries: 0, activities: 0 };
  await db.transaction(async () => {
    await db.prepare('INSERT INTO school_years (year) VALUES (?)').run(year);

    if (copyTimetable) {
      const oldClasses = await db.prepare('SELECT * FROM classes WHERE teacher_id = ? AND school_year = ? ORDER BY id')
        .all(teacherId, from);
      const idMap = new Map();
      for (const item of oldClasses) {
        const created = await db.prepare(`
          INSERT INTO classes (name, subject, level, color, school_year, code, teacher_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(item.name, item.subject, item.level, item.color || '', year, await uniqueClassCode(), teacherId);
        idMap.set(Number(item.id), Number(created.lastInsertRowid));
        result.classes += 1;
      }

      const oldEntries = await db.prepare('SELECT * FROM timetable WHERE teacher_id = ? AND school_year = ? ORDER BY id')
        .all(teacherId, from);
      for (const item of oldEntries) {
        await db.prepare(`
          INSERT INTO timetable (teacher_id, class_id, school_year, day_of_week, start_time, end_time, kind, label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(teacherId, idMap.get(Number(item.class_id)) || null, year,
          item.day_of_week, item.start_time, item.end_time, item.kind, item.label);
        result.entries += 1;
      }
    }

    if (copyActivities) {
      const oldActivities = await db.prepare('SELECT * FROM activities WHERE teacher_id = ? AND school_year = ? ORDER BY id')
        .all(teacherId, from);
      for (const item of oldActivities) {
        await db.prepare(`
          INSERT INTO activities (teacher_id, school_year, title, description, subject, level,
                                  activity_type, difficulty, duration_min, objectives, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(teacherId, year, item.title, item.description, item.subject, item.level,
          item.activity_type, item.difficulty, item.duration_min, item.objectives, item.tags);
        result.activities += 1;
      }
    }

    // Ho fem aquí dins de la transacció, no amb setCurrentYear (que obre la seva).
    await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(year, CURRENT_KEY);
    await db.prepare('UPDATE users SET active_class_id = NULL').run();
  });
  return result;
}

async function yearStats(year, teacherId) {
  const count = async (sql) => Number((await db.prepare(sql).get(year, teacherId)).n);
  return {
    classes: await count('SELECT COUNT(*) AS n FROM classes WHERE school_year = ? AND teacher_id = ?'),
    entries: await count('SELECT COUNT(*) AS n FROM timetable WHERE school_year = ? AND teacher_id = ?'),
    sessions: await count('SELECT COUNT(*) AS n FROM sessions WHERE school_year = ? AND teacher_id = ?'),
    activities: await count('SELECT COUNT(*) AS n FROM activities WHERE school_year = ? AND teacher_id = ?'),
    students: await count(`
      SELECT COUNT(DISTINCT e.student_id) AS n FROM enrollments e
      JOIN classes c ON c.id = e.class_id
      WHERE c.school_year = ? AND c.teacher_id = ?
    `),
  };
}

async function deleteYear(year, teacherId) {
  if (year === await currentYear()) throw new Error('No pots esborrar el curs actiu.');
  const stats = await yearStats(year, teacherId);
  if (stats.sessions > 0) throw new Error('Aquest curs té sessions; no es pot esborrar.');

  await db.transaction(async () => {
    await db.prepare('DELETE FROM timetable WHERE school_year = ? AND teacher_id = ?').run(year, teacherId);
    await db.prepare('DELETE FROM classes WHERE school_year = ? AND teacher_id = ?').run(year, teacherId);
    await db.prepare('DELETE FROM activities WHERE school_year = ? AND teacher_id = ?').run(year, teacherId);
    await db.prepare('DELETE FROM school_years WHERE year = ?').run(year);
  });
}

module.exports = {
  ensureDefaults, currentYear, setCurrentYear, listYears, yearExists, isValidYear,
  currentClassId, setCurrentClass, selectableClasses,
  createYear, yearStats, deleteYear, guessLevel, uniqueClassCode,
};
