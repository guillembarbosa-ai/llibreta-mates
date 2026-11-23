// Mode de prova local: dades a localStorage, sense Firebase ni xarxa.
// S'activa només amb VITE_LOCAL_DEMO=true al fitxer .env.local (mai a producció).

import { DEFAULT_SLOTS, buildTimetable, isValidSchoolYear } from './horari';

export const DEMO = { email: 'profe@test.cat', password: 'prova12345', name: 'Professor Prova' };
export const SCHOOL_YEAR = '2026-2027';
const STORAGE_KEY = 'aula-local-demo-v3';
const DEMO_UID = 'demo-teacher';

const GROUPS = [
  { name: '2n ESO D', level: 'ESO' },
  { name: '2n ESO C', level: 'ESO' },
  { name: '1r BATX Ciències', level: 'Batxillerat' },
  { name: '4t ESO D-E', level: 'ESO' },
  { name: '4t ESO A-B-C', level: 'ESO' },
  { name: '3r ESO B', level: 'ESO' },
];

const COLORS = ['indigo', 'blue', 'teal', 'green', 'amber', 'rose'];

function seed() {
  const classes = GROUPS.map((group, index) => ({
    id: `demo-${index + 1}`,
    name: group.name,
    subject: 'Matemàtiques',
    level: group.level,
    color: COLORS[index % COLORS.length],
    schoolYear: SCHOOL_YEAR,
    code: `DEMO0${index + 1}`,
    teacherId: DEMO_UID,
    studentIds: [],
  }));
  const state = {
    currentUid: null,
    users: {
      [DEMO_UID]: {
        name: DEMO.name,
        email: DEMO.email,
        role: 'teacher',
        activeClassId: null,
        schoolYear: SCHOOL_YEAR,
      },
    },
    classes,
    schoolYears: [SCHOOL_YEAR],
    slotsByYear: { [SCHOOL_YEAR]: DEFAULT_SLOTS.map((slot) => ({ ...slot })) },
    timetable: buildTimetable(DEMO_UID, SCHOOL_YEAR, classes),
    students: [],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : seed();
  } catch {
    return seed();
  }
}

function write(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function view(state) {
  const uid = state.currentUid;
  if (!uid || !state.users[uid]) return { profile: null, classes: [], timetable: [], years: [], students: [], slots: [] };
  const profile = { uid, ...state.users[uid] };
  const classes = profile.role === 'teacher'
    ? state.classes.filter((item) => item.teacherId === uid && item.schoolYear === profile.schoolYear)
    : [];
  const timetable = state.timetable.filter((item) => item.teacherId === uid && item.schoolYear === profile.schoolYear);
  const students = (state.students || []).filter((item) => item.teacherId === uid && item.schoolYear === profile.schoolYear);
  const slots = state.slotsByYear?.[profile.schoolYear] || DEFAULT_SLOTS;
  return { profile, classes, timetable, years: [...state.schoolYears].sort(), students, slots };
}

export function localCurrent() {
  return view(read());
}

export function localLogin(email, password) {
  const state = read();
  if (email.trim().toLowerCase() !== DEMO.email || password !== DEMO.password) {
    throw { code: 'auth/invalid-credential' };
  }
  state.currentUid = DEMO_UID;
  write(state);
  return view(state);
}

export function localLogout() {
  const state = read();
  state.currentUid = null;
  write(state);
}

export function localSetActive(classId) {
  const state = read();
  if (!state.users[DEMO_UID]) return view(state);
  state.users[DEMO_UID].activeClassId = classId;
  write(state);
  return view(state);
}

export function localSetColor(classId, color) {
  const state = read();
  const group = state.classes.find((item) => item.id === classId);
  if (group) group.color = color;
  write(state);
  return view(state);
}

export function localSaveEntry(entry) {
  const state = read();
  const index = state.timetable.findIndex((item) => item.id === entry.id);
  if (index >= 0) state.timetable[index] = entry;
  else state.timetable.push(entry);
  write(state);
  return view(state);
}

export function localDeleteEntry(id) {
  const state = read();
  state.timetable = state.timetable.filter((item) => item.id !== id);
  write(state);
  return view(state);
}

export function localSelectYear(year) {
  const state = read();
  if (!state.schoolYears.includes(year)) throw new Error('Aquest curs no existeix.');
  state.users[DEMO_UID].schoolYear = year;
  state.users[DEMO_UID].activeClassId = null;
  write(state);
  return view(state);
}

export function localSetSlots(year, slots) {
  const state = read();
  state.slotsByYear = state.slotsByYear || {};
  state.slotsByYear[year] = slots;
  write(state);
  return view(state);
}

export function localCreateYear(year) {
  if (!isValidSchoolYear(year)) throw new Error('Escriu el curs amb el format 2027-2028.');
  const state = read();
  if (state.schoolYears.includes(year)) throw new Error('Aquest curs ja existeix.');
  const from = state.users[DEMO_UID].schoolYear;
  const idMap = new Map();
  state.classes
    .filter((item) => item.teacherId === DEMO_UID && item.schoolYear === from)
    .forEach((item, index) => {
      const copy = { ...item, id: `${DEMO_UID}-${year}-${index + 1}`, schoolYear: year };
      state.classes.push(copy);
      idMap.set(item.id, copy.id);
    });
  state.timetable
    .filter((item) => item.teacherId === DEMO_UID && item.schoolYear === from)
    .forEach((item) => {
      state.timetable.push({
        ...item,
        id: item.id.replace(from, year),
        schoolYear: year,
        classId: item.classId ? (idMap.get(item.classId) || null) : null,
      });
    });
  state.schoolYears.push(year);
  state.slotsByYear = state.slotsByYear || {};
  state.slotsByYear[year] = (state.slotsByYear[from] || DEFAULT_SLOTS).map((slot) => ({ ...slot }));
  state.users[DEMO_UID].schoolYear = year;
  state.users[DEMO_UID].activeClassId = null;
  write(state);
  return view(state);
}

function inviteCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

export function localCreateGroup(name, level) {
  const state = read();
  const id = `${DEMO_UID}-g-${Date.now()}`;
  state.classes.push({
    id,
    name,
    subject: 'Matemàtiques',
    level: level || '',
    color: COLORS[state.classes.length % COLORS.length],
    schoolYear: state.users[DEMO_UID].schoolYear,
    code: `LOC${inviteCode()}`,
    teacherId: DEMO_UID,
    studentIds: [],
  });
  write(state);
  return { result: id, data: view(state) };
}

export function localRenameGroup(classId, name) {
  const state = read();
  const group = state.classes.find((item) => item.id === classId);
  if (group) group.name = name;
  write(state);
  return view(state);
}

export function localDeleteGroup(classId) {
  const state = read();
  state.classes = state.classes.filter((item) => item.id !== classId);
  state.timetable = state.timetable.filter((item) => item.classId !== classId);
  state.students = (state.students || []).map((item) => ({
    ...item,
    classIds: (item.classIds || []).filter((id) => id !== classId),
  }));
  write(state);
  return view(state);
}

export function localInviteStudent(classId, name, email) {
  const state = read();
  const group = state.classes.find((item) => item.id === classId);
  const code = inviteCode();
  const student = {
    id: `${DEMO_UID}-s-${Date.now()}`,
    teacherId: DEMO_UID,
    schoolYear: state.users[DEMO_UID].schoolYear,
    name,
    email,
    classIds: [classId],
    classNames: group ? [group.name] : [],
    status: 'pending',
    inviteCode: code,
    uid: null,
    invitedAt: new Date().toISOString(),
  };
  state.students = [...(state.students || []), student];
  write(state);
  return { result: code, data: view(state) };
}

export function localRemoveStudent(studentId, classId) {
  const state = read();
  state.students = (state.students || []).map((item) => item.id === studentId
    ? {
      ...item,
      classIds: (item.classIds || []).filter((id) => id !== classId),
      classNames: (item.classNames || []).filter((name, index) => (item.classIds || [])[index] !== classId),
    }
    : item);
  write(state);
  return view(state);
}

export function localGetInvite(code) {
  const state = read();
  const student = (state.students || []).find((item) => item.inviteCode === code);
  if (!student) return null;
  const group = state.classes.find((item) => item.id === (student.classIds || [])[0]);
  return {
    code,
    studentId: student.id,
    email: student.email,
    name: student.name,
    classId: group?.id || null,
    className: group?.name || '',
    schoolYear: student.schoolYear,
    teacherId: student.teacherId,
    status: student.status,
  };
}

export function localAcceptInvite(code, name) {
  const state = read();
  const student = (state.students || []).find((item) => item.inviteCode === code);
  if (!student) throw new Error('Aquesta invitació no existeix.');
  if (student.status === 'active') throw new Error('Aquesta invitació ja s’ha fet servir.');
  const uid = `${DEMO_UID}-student-${Date.now()}`;
  state.users[uid] = {
    name: name || student.name,
    email: student.email,
    role: 'student',
    activeClassId: (student.classIds || [])[0] || null,
    schoolYear: student.schoolYear,
  };
  student.name = name || student.name;
  student.uid = uid;
  student.status = 'active';
  write(state);
  return view(state);
}

export function localRegenerateInvite(studentId) {
  const state = read();
  const code = inviteCode();
  state.students = (state.students || []).map((item) => item.id === studentId ? { ...item, inviteCode: code, status: 'pending' } : item);
  write(state);
  return { result: code, data: view(state) };
}
