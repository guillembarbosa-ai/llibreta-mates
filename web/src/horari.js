// Franges i plantilla de l'horari, compartides entre el mode Firebase i el mode local.
// 1 = dilluns ... 5 = divendres. slot = índex de DEFAULT_SLOTS.

export const DAYS = ['Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres'];

export const DEFAULT_SLOTS = [
  { start: '08:20', end: '09:20' },
  { start: '09:20', end: '10:20' },
  { start: '10:20', end: '10:50' },
  { start: '10:50', end: '11:50' },
  { start: '11:50', end: '12:50' },
  { start: '12:50', end: '13:50' },
  { start: '13:50', end: '14:45' },
];

// Només classes: les guàrdies i reunions no formen part de l'horari.
export const TEMPLATE = [
  { day: 1, slot: 0, group: '2n ESO D' },
  { day: 1, slot: 1, group: '1r BATX Ciències' },
  { day: 1, slot: 4, group: '4t ESO D-E' },
  { day: 1, slot: 6, group: '4t ESO A-B-C' },

  { day: 2, slot: 0, group: '2n ESO C' },
  { day: 2, slot: 5, group: '2n ESO D' },
  { day: 2, slot: 6, group: '1r BATX Ciències' },

  { day: 3, slot: 0, group: '1r BATX Ciències' },
  { day: 3, slot: 1, group: '4t ESO D-E' },
  { day: 3, slot: 3, group: '4t ESO A-B-C' },
  { day: 3, slot: 4, group: '2n ESO D' },
  { day: 3, slot: 5, group: '2n ESO C' },

  { day: 4, slot: 1, group: '4t ESO A-B-C' },
  { day: 4, slot: 4, group: '4t ESO D-E' },
  { day: 4, slot: 6, group: '1r BATX Ciències' },

  { day: 5, slot: 4, group: '2n ESO C' },
  { day: 5, slot: 5, group: '4t ESO D-E' },
  { day: 5, slot: 6, group: '4t ESO A-B-C' },
];

// L'identificador fem servir la franga per defecte, així canviar l'hora no perd les dades.
export function entryId(teacherId, schoolYear, day, slotIndex) {
  const slot = DEFAULT_SLOTS[slotIndex] || DEFAULT_SLOTS[0];
  return `${teacherId}_${schoolYear}_${day}_${slot.start}`.replace(/:/g, '-');
}

export function slotIndexOf(entry, slots = DEFAULT_SLOTS) {
  if (Number.isInteger(entry.slotIndex)) return entry.slotIndex;
  const found = slots.findIndex((slot) => slot.start === entry.start);
  return found >= 0 ? found : DEFAULT_SLOTS.findIndex((slot) => slot.start === entry.start);
}

/** Construeix les entrades de l'horari inicial d'un curs a partir dels grups existents. */
export function buildTimetable(teacherId, schoolYear, classes) {
  return TEMPLATE.map((item) => {
    const slot = DEFAULT_SLOTS[item.slot];
    const group = classes.find((itemClass) => itemClass.name === item.group);
    return {
      id: entryId(teacherId, schoolYear, item.day, item.slot),
      teacherId,
      schoolYear,
      day: item.day,
      slotIndex: item.slot,
      start: slot.start,
      end: slot.end,
      kind: 'class',
      label: group?.name || item.group,
      classId: group?.id || null,
    };
  });
}

export function nextSchoolYear(year) {
  const first = Number(String(year).slice(0, 4));
  return Number.isFinite(first) ? `${first + 1}-${first + 2}` : '';
}

export function isValidSchoolYear(year) {
  return /^\d{4}-\d{4}$/.test(year) && Number(year.slice(5)) === Number(year.slice(0, 4)) + 1;
}

// ---------- Planificació setmanal i sessions ----------

export function toISODate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function fromISODate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  return new Date(year || 1970, (month || 1) - 1, day || 1);
}

export function addDays(value, days) {
  const date = fromISODate(value);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

/** Converteix rangs { start, end } en la llista de dates que cobreixen. */
export function expandDateRanges(ranges) {
  const dates = [];
  for (const range of ranges || []) {
    if (!range?.start || !range?.end || range.start > range.end) continue;
    let cursor = range.start;
    let guard = 0;
    while (cursor <= range.end && guard < 400) {
      dates.push(cursor);
      cursor = addDays(cursor, 1);
      guard += 1;
    }
  }
  return [...new Set(dates)].sort();
}

/** Agrupa dates consecutives en rangs (per migrar festes desades abans). */
export function datesToRanges(dates) {
  const ranges = [];
  for (const date of [...new Set(dates || [])].sort()) {
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.end, 1) === date) last.end = date;
    else ranges.push({ start: date, end: date });
  }
  return ranges;
}

export function mondayOf(value) {
  const date = fromISODate(value);
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday);
  return toISODate(date);
}

export function schoolYearBounds(year) {
  const first = Number(String(year).slice(0, 4));
  return { start: `${first}-09-01`, end: `${first + 1}-08-31` };
}

export function weekDates(monday) {
  return Array.from({ length: 5 }, (_, index) => {
    const iso = addDays(monday, index);
    return { iso, day: index + 1, date: fromISODate(iso) };
  });
}

export function sessionIdKey(teacherId, classId, date, slotIndex) {
  return `${teacherId}_${classId}_${date}_${slotIndex}`;
}

export function formatDateShort(value) {
  const date = fromISODate(value);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function formatWeekLabel(monday) {
  const first = fromISODate(monday);
  const last = fromISODate(addDays(monday, 4));
  const month = new Intl.DateTimeFormat('ca', { month: 'short' }).format(last);
  return `${first.getDate()} – ${last.getDate()} ${month} ${last.getFullYear()}`;
}

/** Espais (data + franja) d'un grup a partir d'una data, saltant caps de setmana. */
export function groupSlotsFrom(timetable, classId, fromDate, fromSlotIndex = 0, slots = DEFAULT_SLOTS, weeks = 12) {
  const patterns = [...new Map(timetable
    .filter((entry) => entry.kind === 'class' && entry.classId === classId)
    .map((entry) => {
      const slotIndex = slotIndexOf(entry, slots);
      const slot = slots[slotIndex] || DEFAULT_SLOTS[slotIndex] || DEFAULT_SLOTS[0];
      return [`${entry.day}-${slotIndex}`, { day: entry.day, slotIndex, start: slot.start, end: slot.end }];
    })).values()]
    .sort((a, b) => a.day - b.day || a.slotIndex - b.slotIndex);

  const result = [];
  const cursor = fromISODate(fromDate);
  const limit = fromISODate(fromDate);
  limit.setDate(limit.getDate() + weeks * 7);
  for (; cursor <= limit; cursor.setDate(cursor.getDate() + 1)) {
    const weekday = cursor.getDay();
    if (weekday === 0 || weekday === 6) continue;
    const date = toISODate(cursor);
    for (const pattern of patterns.filter((item) => item.day === weekday)) {
      if (date === fromDate && pattern.slotIndex < fromSlotIndex) continue;
      result.push({ ...pattern, date });
    }
  }
  return result;
}
