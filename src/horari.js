'use strict';

const { db, DEFAULT_YEAR } = require('./db');
const { uniqueClassCode, guessLevel } = require('./courses');
const { nextColor } = require('./colors');

// Franges de l'horari extret del PDF. Es poden editar des de la secció Horari.
const SLOTS = [
  { start: '08:20', end: '09:20' },
  { start: '09:20', end: '10:20' },
  { start: '10:20', end: '10:50' },
  { start: '10:50', end: '11:50' },
  { start: '11:50', end: '12:50' },
  { start: '12:50', end: '13:50' },
  { start: '13:50', end: '14:45' },
];

const DAYS = ['', 'Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres'];

const GROUPS = [
  { name: '2n ESO D', level: 'ESO' },
  { name: '2n ESO C', level: 'ESO' },
  { name: '1r BATX Ciències', level: 'Batxillerat' },
  { name: '4t ESO D-E', level: 'ESO' },
  { name: '4t ESO A-B-C', level: 'ESO' },
];

// Plantilla inicial. day: 1=dilluns ... 5=divendres. slot: índex de SLOTS.
const ENTRIES = [
  { day: 1, slot: 0, group: '2n ESO D' },
  { day: 1, slot: 1, group: '1r BATX Ciències' },
  { day: 1, slot: 2, kind: 'guard', label: 'Guàrdia pati' },
  { day: 1, slot: 4, group: '4t ESO D-E' },
  { day: 1, slot: 5, kind: 'guard', label: 'Guàrdia' },
  { day: 1, slot: 6, group: '4t ESO A-B-C' },

  { day: 2, slot: 0, group: '2n ESO C' },
  { day: 2, slot: 3, kind: 'guard', label: 'Guàrdia' },
  { day: 2, slot: 5, group: '2n ESO D' },
  { day: 2, slot: 6, group: '1r BATX Ciències' },

  { day: 3, slot: 0, group: '1r BATX Ciències' },
  { day: 3, slot: 1, group: '4t ESO D-E' },
  { day: 3, slot: 3, group: '4t ESO A-B-C' },
  { day: 3, slot: 4, group: '2n ESO D' },
  { day: 3, slot: 5, group: '2n ESO C' },

  { day: 4, slot: 1, group: '4t ESO A-B-C' },
  { day: 4, slot: 2, kind: 'guard', label: 'Guàrdia pati' },
  { day: 4, slot: 4, group: '4t ESO D-E' },
  { day: 4, slot: 5, kind: 'meeting', label: 'Reunió Departament Mates' },
  { day: 4, slot: 6, group: '1r BATX Ciències' },

  { day: 5, slot: 3, kind: 'guard', label: 'Guàrdia' },
  { day: 5, slot: 4, group: '2n ESO C' },
  { day: 5, slot: 5, group: '4t ESO D-E' },
  { day: 5, slot: 6, group: '4t ESO A-B-C' },
];

/** Importa la plantilla inicial per a un professor i un curs. */
async function importTimetable(teacherId, schoolYear = DEFAULT_YEAR) {
  let createdClasses = 0;
  let createdEntries = 0;

  // No tornem a afegir la plantilla si el professor ja té un horari (o l'ha buidat).
  const existing = Number((await db.prepare('SELECT COUNT(*) AS n FROM timetable WHERE teacher_id = ? AND school_year = ?')
    .get(teacherId, schoolYear)).n);
  if (existing > 0) return { createdClasses, createdEntries };

  const findClass = db.prepare('SELECT id FROM classes WHERE teacher_id = ? AND school_year = ? AND name = ?');
  const insertClass = db.prepare(`
    INSERT INTO classes (name, subject, level, color, school_year, code, teacher_id)
    VALUES (?, 'Matemàtiques', ?, ?, ?, ?, ?)
  `);
  const classIds = new Map();
  for (const [index, group] of GROUPS.entries()) {
    let row = await findClass.get(teacherId, schoolYear, group.name);
    if (!row) {
      const result = await insertClass.run(group.name, group.level, nextColor(index), schoolYear, await uniqueClassCode(), teacherId);
      row = { id: Number(result.lastInsertRowid) };
      createdClasses += 1;
    }
    classIds.set(group.name, Number(row.id));
  }

  const findEntry = db.prepare(`
    SELECT id FROM timetable
    WHERE teacher_id = ? AND school_year = ? AND day_of_week = ? AND start_time = ?
  `);
  const insertEntry = db.prepare(`
    INSERT INTO timetable (teacher_id, class_id, school_year, day_of_week, start_time, end_time, kind, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of ENTRIES) {
    const slot = SLOTS[entry.slot];
    const kind = entry.kind || 'class';
    const label = kind === 'class' ? entry.group : entry.label;
    if (await findEntry.get(teacherId, schoolYear, entry.day, slot.start)) continue;
    await insertEntry.run(teacherId, kind === 'class' ? classIds.get(entry.group) : null,
      schoolYear, entry.day, slot.start, slot.end, kind, label);
    createdEntries += 1;
  }

  return { createdClasses, createdEntries };
}

/** Crea/grups necessaris per a una etiqueta de classe i retorna l'id. */
async function ensureClass(teacherId, schoolYear, name) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) return null;
  let row = await db.prepare('SELECT id FROM classes WHERE teacher_id = ? AND school_year = ? AND name = ?')
    .get(teacherId, schoolYear, clean);
  if (!row) {
    const count = Number((await db.prepare('SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ? AND school_year = ?')
      .get(teacherId, schoolYear)).n);
    const created = await db.prepare(`
      INSERT INTO classes (name, subject, level, color, school_year, code, teacher_id)
      VALUES (?, 'Matemàtiques', ?, ?, ?, ?, ?)
    `).run(clean, guessLevel(clean), nextColor(count), schoolYear, await uniqueClassCode(), teacherId);
    row = { id: Number(created.lastInsertRowid) };
  }
  return Number(row.id);
}

/** Substitueix tota la plantilla d'horari d'un curs. cells: [{day, slot, kind, label}] */
async function saveTimetable(teacherId, schoolYear, cells) {
  return db.transaction(async () => {
    // Les sessions ja generades es conserven (perden l'enllaç amb la franga).
    await db.prepare('DELETE FROM timetable WHERE teacher_id = ? AND school_year = ?').run(teacherId, schoolYear);

    const insert = db.prepare(`
      INSERT INTO timetable (teacher_id, class_id, school_year, day_of_week, start_time, end_time, kind, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let saved = 0;
    for (const cell of cells) {
      const slot = SLOTS[cell.slot];
      if (!slot) continue;
      const kind = ['class', 'guard', 'meeting'].includes(cell.kind) ? cell.kind : null;
      const label = String(cell.label || '').trim().slice(0, 80);
      if (!kind || !label) continue;
      const classId = kind === 'class' ? await ensureClass(teacherId, schoolYear, label) : null;
      if (!classId && kind === 'class') continue;
      await insert.run(teacherId, classId, schoolYear, cell.day, slot.start, slot.end, kind, label);
      saved += 1;
    }
    return saved;
  });
}

/** Genera sessions a partir de les franges de classe dins d'un rang de dates. */
async function generateSessions(teacherId, startDate, endDate, schoolYear = DEFAULT_YEAR) {
  const entries = await db.prepare(`
    SELECT t.*, c.name AS class_name FROM timetable t
    LEFT JOIN classes c ON c.id = t.class_id
    WHERE t.teacher_id = ? AND t.school_year = ? AND t.kind = 'class' AND t.class_id IS NOT NULL
  `).all(teacherId, schoolYear);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sessions
      (class_id, teacher_id, school_year, title, session_date, start_time, end_time,
       objectives, notes, status, timetable_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 'planificada', ?)
  `);

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
      || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error('El rang de dates no és vàlid.');
  }

  let created = 0;
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    if (day === 0 || day === 6) continue;
    const date = cursor.toISOString().slice(0, 10);
    for (const entry of entries) {
      if (entry.day_of_week !== day) continue;
      const result = await insert.run(Number(entry.class_id), teacherId, schoolYear, entry.class_name, date,
        entry.start_time, entry.end_time, Number(entry.id));
      created += result.changes;
    }
  }

  return { created, entries: entries.length };
}

async function getTimetable(teacherId, schoolYear = DEFAULT_YEAR) {
  return db.prepare(`
    SELECT t.*, c.name AS class_name, c.subject AS subject, c.color AS class_color
    FROM timetable t LEFT JOIN classes c ON c.id = t.class_id
    WHERE t.teacher_id = ? AND t.school_year = ?
    ORDER BY t.day_of_week ASC, t.start_time ASC
  `).all(teacherId, schoolYear);
}

async function classesFor(teacherId, schoolYear = DEFAULT_YEAR) {
  return db.prepare('SELECT id, name, level, color FROM classes WHERE teacher_id = ? AND school_year = ? ORDER BY name')
    .all(teacherId, schoolYear);
}

function mondayOf(date = new Date()) {
  const value = new Date(date);
  const day = value.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  value.setUTCDate(value.getUTCDate() + diff);
  return value.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const value = new Date(`${dateString}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

module.exports = {
  SLOTS, DAYS, GROUPS, ENTRIES,
  importTimetable, saveTimetable, generateSessions, getTimetable, classesFor, mondayOf, addDays,
};
