'use strict';

const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { requireTeacher } = require('../auth');
const { currentYear } = require('../courses');
const {
  SLOTS, DAYS, saveTimetable, generateSessions,
  getTimetable, classesFor, mondayOf, addDays,
} = require('../horari');

const router = express.Router();
router.use(requireTeacher);

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const name = String(file.originalname || '').toLowerCase();
    if (!name.endsWith('.csv') && !['text/csv', 'application/csv'].includes(file.mimetype)) {
      return callback(new Error('Només s’accepta un fitxer CSV.'));
    }
    callback(null, true);
  },
});

function buildWeek(entries) {
  return DAYS.slice(1).map((name, index) => {
    const day = index + 1;
    return {
      day,
      name,
      cells: SLOTS.map((slot, slotIndex) => ({
        ...slot,
        slotIndex,
        entry: entries.find((item) => item.day_of_week === day && item.start_time === slot.start) || null,
      })),
    };
  });
}

function summaryOf(entries) {
  const map = new Map();
  for (const item of entries) {
    if (item.kind !== 'class') continue;
    const current = map.get(item.label) || { name: item.label, count: 0, color: item.class_color || '' };
    current.count += 1;
    map.set(item.label, current);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ca'));
}

function redirectNotice(req, res, message, isError = false) {
  const key = isError ? 'error' : 'notice';
  const target = req.body && req.body.return_to === 'start' ? '/' : '/timetable';
  res.redirect(`${target}?${key}=${encodeURIComponent(message)}`);
}

router.get('/', async (req, res) => {
  const year = await currentYear();
  const entries = await getTimetable(req.user.id, year);
  const week = buildWeek(entries);
  const defaultStart = await mondayOf();
  const defaultEnd = await addDays(defaultStart, 27);

  const rangeStart = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : defaultStart;
  const rangeEnd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : defaultEnd;

  const generated = Number((await db.prepare(`
    SELECT COUNT(*) AS n FROM sessions
    WHERE teacher_id = ? AND school_year = ? AND timetable_id IS NOT NULL
      AND session_date BETWEEN ? AND ?
  `).get(req.user.id, year, rangeStart, rangeEnd)).n);

  res.render('timetable', {
    title: 'Horari setmanal',
    subtitle: `Curs ${year} · edita les franges i genera les sessions.`,
    SLOTS, week, entries,
    classes: await classesFor(req.user.id, year),
    currentYear: year,
    rangeStart, rangeEnd, generated,
    summary: summaryOf(entries),
  });
});

router.post('/save', async (req, res) => {
  const year = await currentYear();
  const expectedKeys = 5 * SLOTS.length;
  const submittedKeys = Object.keys(req.body).filter((key) => key.startsWith('kind_')).length;
  if (submittedKeys < expectedKeys) {
    return redirectNotice(req, res, 'No s’ha rebut la plantilla completa; torna a carregar la pàgina i desa de nou.', true);
  }

  const cells = [];
  for (let day = 1; day <= 5; day += 1) {
    for (let slotIndex = 0; slotIndex < SLOTS.length; slotIndex += 1) {
      const key = `${day}_${slotIndex}`;
      const kind = String(req.body[`kind_${key}`] || '').trim();
      const label = String(req.body[`label_${key}`] || '').trim();
      if (!kind) continue;
      cells.push({ day, slot: slotIndex, kind, label });
    }
  }
  try {
    const saved = await saveTimetable(req.user.id, year, cells);
    redirectNotice(req, res, `Horari desat: ${saved} franges per al curs ${year}.`);
  } catch (error) {
    redirectNotice(req, res, error.message, true);
  }
});

router.get('/template.csv', async (req, res) => {
  const year = await currentYear();
  const entries = await getTimetable(req.user.id, year);
  const lines = ['dia,hora_inici,hora_fi,tipus,grup_o_etiqueta'];
  for (let day = 1; day <= 5; day += 1) {
    for (const slot of SLOTS) {
      const entry = entries.find((item) => item.day_of_week === day && item.start_time === slot.start);
      const kind = entry ? entry.kind : '';
      const label = entry ? entry.label : '';
      lines.push([day, slot.start, slot.end, kind, `"${String(label).replace(/"/g, '""')}"`].join(','));
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="horari-${year}.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
});

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

const DAY_NAMES = ['dilluns', 'dimarts', 'dimecres', 'dijous', 'divendres'];

function parseDay(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (/^[1-5]$/.test(raw)) return Number(raw);
  const index = DAY_NAMES.findIndex((name) => name.startsWith(raw) && raw.length >= 3);
  return index === -1 ? null : index + 1;
}

function parseKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['class', 'classe', 'grup'].includes(raw)) return 'class';
  if (['guard', 'guàrdia', 'guardia'].includes(raw)) return 'guard';
  if (['meeting', 'reunió', 'reunio'].includes(raw)) return 'meeting';
  return '';
}

router.post('/import', csvUpload.single('file'), async (req, res) => {
  const year = await currentYear();
  if (!req.file) return redirectNotice(req, res, 'Selecciona un fitxer CSV.', true);

  const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines[0] && /^dia/i.test(parseCsvLine(lines[0])[0] || '')) lines.shift();

  const cells = [];
  let skipped = 0;
  for (const line of lines) {
    const [dayValue, start, end, kindValue, labelValue] = parseCsvLine(line);
    const day = parseDay(dayValue);
    const slotIndex = SLOTS.findIndex((slot) => slot.start === String(start || '').trim());
    const kind = parseKind(kindValue);
    const label = String(labelValue || '').trim();
    if (!day || slotIndex === -1 || !kind || !label) { skipped += 1; continue; }
    cells.push({ day, slot: slotIndex, kind, label });
  }

  if (!cells.length) return redirectNotice(req, res, 'No s’han trobat franges vàlides al CSV.', true);
  try {
    const saved = await saveTimetable(req.user.id, year, cells);
    const extra = skipped ? ` (${skipped} línies ignorades)` : '';
    redirectNotice(req, res, `Horari importat del CSV: ${saved} franges${extra}.`);
  } catch (error) {
    redirectNotice(req, res, error.message, true);
  }
});

router.post('/generate', async (req, res) => {
  const year = await currentYear();
  const start = String(req.body.start || '').trim();
  const end = String(req.body.end || '').trim();
  try {
    const result = await generateSessions(req.user.id, start, end, year);
    const message = result.created === 0
      ? 'No hi ha sessions noves en aquest rang (ja estaven generades).'
      : `S'han generat ${result.created} sessions del curs ${year}.`;
    res.redirect(`/timetable?start=${start}&end=${end}&notice=${encodeURIComponent(message)}`);
  } catch (error) {
    res.redirect(`/timetable?start=${start}&end=${end}&error=${encodeURIComponent(error.message)}`);
  }
});

module.exports = router;
