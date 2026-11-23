import { useEffect, useId, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { auth, db, isFirebaseConfigured, isLocalDemo, setupAuth, setupDb } from './firebase';
import { GROUP_COLORS, colorOf, nextColor } from './colors';
import {
  DAYS, DEFAULT_SLOTS, addDays, buildTimetable, datesToRanges, entryId, expandDateRanges,
  formatDateShort, formatWeekLabel, fromISODate, isValidSchoolYear, mondayOf, nextSchoolYear, schoolYearBounds,
  sessionIdKey, slotIndexOf, toISODate, weekDates,
} from './horari';
import {
  DEMO,
  SCHOOL_YEAR,
  localAcceptInvite,
  localCreateGroup,
  localCreateYear,
  localCurrent,
  localDeleteEntry,
  localDeleteGroup,
  localGetInvite,
  localInviteStudent,
  localLogin,
  localLogout,
  localRegenerateInvite,
  localRemoveStudent,
  localRenameGroup,
  localSaveEntry,
  localSelectYear,
  localSetActive,
  localSetColor,
  localSetSlots,
} from './localStore';

function inviteCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// Codi d'accés per registrar nous professors. Canvia'l aquí quan vulguis.
const TEACHER_REGISTRATION_CODE = 'AULA-2026';

const DEMO_GROUPS = [
  { name: '2n ESO D', level: 'ESO' },
  { name: '2n ESO C', level: 'ESO' },
  { name: '1r BATX Ciències', level: 'Batxillerat' },
  { name: '4t ESO D-E', level: 'ESO' },
  { name: '4t ESO A-B-C', level: 'ESO' },
];

function authMessage(code) {
  const messages = {
    'auth/invalid-email': 'El correu electrònic no és vàlid.',
    'auth/user-not-found': 'El correu o la contrasenya no són correctes.',
    'auth/invalid-credential': 'El correu o la contrasenya no són correctes.',
    'auth/wrong-password': 'El correu o la contrasenya no són correctes.',
    'auth/too-many-requests': 'Massa intents. Espera una mica i torna-ho a provar.',
    'auth/email-already-in-use': 'Ja existeix un compte amb aquest correu.',
    'auth/weak-password': 'La contrasenya ha de tenir almenys 6 caràcters.',
    'auth/network-request-failed': 'No s’ha pogut connectar. Comprova la connexió i torna-ho a provar.',
  };
  return messages[code] || 'No s’ha pogut iniciar la sessió. Torna-ho a provar.';
}

/** Crea el compte de proves i els grups inicials la primera vegada. */
async function ensureDemoAccount() {
  let uid;
  try {
    const credential = await signInWithEmailAndPassword(auth, DEMO.email, DEMO.password);
    uid = credential.user.uid;
  } catch (error) {
    const missing = ['auth/user-not-found', 'auth/invalid-credential'].includes(error.code);
    if (!missing) throw error;
    const credential = await createUserWithEmailAndPassword(auth, DEMO.email, DEMO.password);
    uid = credential.user.uid;
  }

  await setDoc(doc(db, 'users', uid), {
    name: DEMO.name,
    email: DEMO.email,
    role: 'teacher',
    activeClassId: null,
    schoolYear: SCHOOL_YEAR,
  }, { merge: true });

  for (const [index, group] of DEMO_GROUPS.entries()) {
    await setDoc(doc(db, 'classes', `demo-${index + 1}`), {
      name: group.name,
      subject: 'Matemàtiques',
      level: group.level,
      color: nextColor(index),
      schoolYear: SCHOOL_YEAR,
      code: `DEMO0${index + 1}`,
      teacherId: uid,
      studentIds: [],
    }, { merge: true });
  }

  const demoClasses = DEMO_GROUPS.map((group, index) => ({ id: `demo-${index + 1}`, name: group.name }));
  await ensureYearSeed(uid, SCHOOL_YEAR, demoClasses);

  await signOut(auth);
  localStorage.setItem('aula-demo-seeded', 'true');
}

/** Crea el curs, les franges per defecte i, si cal, la plantilla d'horari. */
async function ensureYearSeed(uid, year, classList, database = db) {
  // No fem getDoc d'un doc inexistent: les regles necessiten resource.data i ho denegarien.
  const yearLookup = query(
    collection(database, 'schoolYears'),
    where('teacherId', '==', uid),
    where('year', '==', year),
  );
  const yearSnapshot = await getDocs(yearLookup);
  const yearRef = doc(database, 'schoolYears', `${uid}_${year}`);
  let yearData = yearSnapshot.empty ? null : yearSnapshot.docs[0].data();
  const defaultSlots = DEFAULT_SLOTS.map((slot) => ({ ...slot }));

  if (!yearData) {
    yearData = { teacherId: uid, year, createdAt: new Date().toISOString(), timetableSeeded: false, slots: defaultSlots };
    await setDoc(yearRef, yearData);
  } else if (!yearData.slots) {
    yearData = { ...yearData, slots: defaultSlots };
    await setDoc(yearRef, { slots: defaultSlots }, { merge: true });
  }

  const timetableQuery = query(
    collection(database, 'timetable'),
    where('teacherId', '==', uid),
    where('schoolYear', '==', year),
  );
  const current = await getDocs(timetableQuery);
  const hasClasses = current.docs.some((item) => item.data().kind === 'class');
  if (!hasClasses && !yearData.timetableSeeded) {
    for (const entry of buildTimetable(uid, year, classList)) {
      const { id, ...data } = entry;
      await setDoc(doc(database, 'timetable', id), data);
    }
    await updateDoc(yearRef, { timetableSeeded: true });
    yearData = { ...yearData, timetableSeeded: true };
  }
  return { id: yearRef.id, ...yearData };
}

/** Crea el compte de l'alumne amb una contrasenya temporal, sense tocar la sessió del professor. */
async function provisionStudentAccount(email) {
  try {
    const credential = await createUserWithEmailAndPassword(setupAuth, email, `${inviteCode()}aA1!`);
    await signOut(setupAuth);
    return credential.user.uid;
  } catch (error) {
    if (error.code === 'auth/email-already-in-use') return null;
    throw error;
  }
}

/** Firebase envia el correu perquè l'alumne triï la seva contrasenya. */
async function sendInviteEmail(email) {
  await sendPasswordResetEmail(auth, email, {
    url: `${window.location.origin}${window.location.pathname}`,
  });
}

/** Un professor nou arrenca amb els grups bàsics i el seu horari. */
async function seedGroupsForTeacher(uid, database = db) {
  const existing = await getDocs(query(collection(database, 'classes'), where('teacherId', '==', uid)));
  if (!existing.empty) return;
  const created = [];
  for (const [index, group] of DEMO_GROUPS.entries()) {
    const reference = doc(collection(database, 'classes'));
    const data = {
      name: group.name,
      subject: 'Matemàtiques',
      level: group.level,
      color: nextColor(index),
      schoolYear: SCHOOL_YEAR,
      code: `M${inviteCode()}`,
      teacherId: uid,
      studentIds: [],
    };
    await setDoc(reference, data);
    created.push({ id: reference.id, name: group.name });
  }
  await ensureYearSeed(uid, SCHOOL_YEAR, created, database);
}

/** Si el correu coincideix amb una invitació pendent, s'hi associa automàticament. */
async function linkPendingInvite(uid, email, database = db) {
  const snapshot = await getDocs(query(collection(database, 'invites'), where('email', '==', email)));
  const pending = snapshot.docs.find((item) => item.data().status === 'pending');
  if (!pending) return null;
  const invite = pending.data();
  await updateDoc(doc(database, 'invites', pending.id), { uid, status: 'active' });
  await updateDoc(doc(database, 'students', invite.studentId), { uid, status: 'active' });
  return invite;
}

function Brand({ light = false }) {
  return (
    <div className={`brand${light ? ' light' : ''}`}>
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="3" width="20" height="26" rx="3" />
          <path d="M7 9h20" />
          <path d="M12 3v4M17 3v4M22 3v4" />
          <path d="M12 14h10M12 19h10M12 24h6" strokeWidth="1.6" opacity=".85" />
        </svg>
      </span>
      <span className="brand-text">Llibreta<span>dia a dia</span></span>
    </div>
  );
}

const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><line x1="16" y1="3" x2="16" y2="7" /><line x1="8" y1="3" x2="8" y2="7" /><line x1="3" y1="11" x2="21" y2="11" /></>,
  layers: <><polygon points="12 2 22 8 12 14 2 8 12 2" /><polyline points="2 13 12 19 22 13" /></>,
  check: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 5h12l-2 3.5L17 12H5" /></>,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  book: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 3v18M11 8h6M11 12h6M11 16h4" /></>,
  camera: <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h4l2 3h4a2 2 0 0 1 2 2Z" /><circle cx="12" cy="13" r="4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.6" y2="16.6" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  download: <><path d="M12 3v12" /><polyline points="7 10 12 15 17 10" /><path d="M4 17v3h16v-3" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 1.8-4.2 2 2 0 0 1 1.4-3.4H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z" /><circle cx="7.5" cy="11.5" r="1" /><circle cx="10" cy="7.5" r="1" /><circle cx="15" cy="8" r="1" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><polyline points="3 7 12 13 21 7" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><polyline points="20 4 20 11 13 11" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 21 2" /><path d="m17 6 3 3" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>,
  back: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
  menu: <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>,
  close: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
};

function Icon({ name }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/** Una sessió es considera preparada si està feta, té explicació o alguna activitat amb descripció. */
function sessionPrepared(session, activities = []) {
  if (!session) return false;
  if (session.status === 'done') return true;
  if (String(session.theory || '').trim()) return true;
  return (session.items || []).some((item) => {
    if (String(item.content || '').trim()) return true;
    const bank = activities.find((activity) => activity.id === item.activityId);
    return !!(bank && String(bank.content || '').trim());
  });
}

/** Només els dispositius mòbils fan servir el calaix; l'ordinador sempre té el menú lateral. */
function isMobileDevice() {
  if (typeof window === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const mobileAgent = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(userAgent);
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches || false;
  return mobileAgent || coarsePointer;
}

function useCompactLayout() {
  const query = '(max-width: 900px)';
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && isMobileDevice() && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setCompact(isMobileDevice() && media.matches);
    sync();
    if (media.addEventListener) media.addEventListener('change', sync);
    else media.addListener(sync);
    return () => {
      if (media.removeEventListener) media.removeEventListener('change', sync);
      else media.removeListener(sync);
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('is-mobile-device', compact);
    return () => document.documentElement.classList.remove('is-mobile-device');
  }, [compact]);
  return compact;
}

// Dins d'un grup només la feina del dia a dia. L'horari i la gestió viuen a Principal.
const NAV_ITEMS = [
  { key: 'taulell', label: 'Inici', icon: 'dashboard' },
  { key: 'sessions', label: 'Sessions', icon: 'calendar' },
  { key: 'activities', label: 'Activitats', icon: 'layers' },
  { key: 'submissions', label: 'Lliuraments', icon: 'check' },
];

function LogoutButton({ onClick }) {
  return (
    <button className="icon-button" type="button" onClick={onClick} title="Tancar sessió" aria-label="Tancar sessió">
      <Icon name="logout" />
    </button>
  );
}

function Login({ notice, onLogin, onRegister }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [regCode, setRegCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await onLogin(email, password);
      else await onRegister({ name, email, password, code: regCode });
    } catch (failure) {
      setError(failure.code ? authMessage(failure.code) : (failure.message || 'No s’ha pogut completar l’operació.'));
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError('');
  }

  return (
    <div className="auth-body">
      <div className="auth-shell">
        <div className="auth-intro">
          <Brand light />
          <h2>La teva classe, organitzada.</h2>
          <p>Planifica sessions, ordena les activitats, rep els lliuraments i corregeix amb comentaris. Tot en un mateix lloc.</p>
          <ul className="feature-list">
            <li>Sessions i activitats en un sol lloc</li>
            <li>Lliurament de tasques amb fitxers</li>
            <li>Avaluació amb nota i feedback</li>
          </ul>
        </div>
        <div className="auth-panel">
          <h2>{mode === 'login' ? 'Benvingut de nou' : 'Crea el teu compte'}</h2>
          <p>{mode === 'login' ? 'Entra amb el teu compte per continuar.' : 'Registre de professorat. Cal el codi d’accés que et faciliti el centre.'}</p>
          {notice && <div className="alert success">{notice}</div>}
          {error && <div className="alert danger">{error}</div>}
          <form onSubmit={submit}>
            {mode === 'register' && (
              <>
                <div className="field">
                  <label htmlFor="register-name">Nom i cognoms</label>
                  <input id="register-name" value={name} onChange={(event) => setName(event.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="register-code">Codi de registre</label>
                  <input id="register-code" value={regCode} onChange={(event) => setRegCode(event.target.value)}
                    placeholder="Codi d’accés per a professorat" required />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="email">Correu electrònic</label>
              <input id="email" type="email" autoComplete="username" required
                value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">Contrasenya</label>
              <input id="password" type="password" minLength="6"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required
                value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            <button className="button block" type="submit" disabled={busy}>
              {busy ? (mode === 'login' ? 'Entrant…' : 'Creant compte…') : (mode === 'login' ? 'Entrar' : 'Crear compte')}
            </button>
          </form>
          {mode === 'login' && (
            <div className="demo-note">
              Compte de proves: <code>{DEMO.email}</code> / <code>{DEMO.password}</code>
            </div>
          )}
          <button className="auth-switch" type="button" onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Ets professor? Registra’t amb el teu codi' : 'Ja tens compte? Entra aquí'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Principal({ profile, classes, students, notice, onActivate, onLogout, onOpenGlobal }) {

  return (
    <div className="layout layout-full">
      <div className="workspace">
        <header className="topbar">
          <Brand />
          <div className="topbar-right"><LogoutButton onClick={onLogout} /></div>
        </header>
        <main className="content">
          {notice && <div className="alert success">{notice}</div>}
          <section className="principal">
            <div className="principal-hero">
              <div className="principal-hero-art" aria-hidden="true">
                <span className="orb orb-a" /><span className="orb orb-b" /><span className="orb orb-c" />
                <span className="hero-grid" />
              </div>
              <div className="principal-hero-inner">
                <span className="principal-eyebrow"><span className="eyebrow-dot" /> Llibreta dia a dia · Curs {profile.schoolYear}</span>
                <h2>Comencem, {profile.name.split(' ')[0]}.<br /><em>Tria el teu grup.</em></h2>
                <p className="principal-lead">
                  Aquí prepares l'horari i el curs. Els colors i els alumnes es gestionen a Classes.
                  Quan entres en un grup, el taulell es mostra només amb les seves dades.
                </p>
                <nav className="principal-menu" aria-label="Menú de la principal">
                  <button type="button" className="principal-menu-link" onClick={() => onOpenGlobal('horari')}>
                    <span className="principal-menu-icon indigo"><Icon name="clock" /></span>
                    <span className="principal-menu-text"><strong>Horari</strong><small>Organitza la setmana</small></span>
                    <span className="principal-menu-arrow">↗</span>
                  </button>
                  <button type="button" className="principal-menu-link" onClick={() => onOpenGlobal('classes')}>
                    <span className="principal-menu-icon teal"><Icon name="users" /></span>
                    <span className="principal-menu-text"><strong>Classes</strong><small>Grups i alumnes</small></span>
                    <span className="principal-menu-arrow">↗</span>
                  </button>
                  <button type="button" className="principal-menu-link" onClick={() => onOpenGlobal('activitats')}>
                    <span className="principal-menu-icon amber"><Icon name="book" /></span>
                    <span className="principal-menu-text"><strong>Banc d'activitats</strong><small>El teu repositori, sense cursos ni dates</small></span>
                    <span className="principal-menu-arrow">↗</span>
                  </button>
                </nav>
              </div>
            </div>

            <div className="principal-section-head">
              <div>
                <span className="section-kicker">Els teus grups</span>
                <h3>{classes.length} {classes.length === 1 ? 'classe disponible' : 'classes disponibles'}</h3>
              </div>
              <span className="principal-hint">Clica un grup per entrar-hi →</span>
            </div>

            {classes.length === 0 ? (
              <div className="empty"><span className="empty-icon">♧</span><strong>Encara no hi ha classes</strong></div>
            ) : (
              <div className="principal-classes">
                {classes.map((group, index) => {
                  const color = colorOf(group.color);
                  return (
                    <button
                      className="principal-class"
                      key={group.id}
                      type="button"
                      onClick={() => onActivate(group.id)}
                      style={{ '--card-bg': color.bg, '--card-border': color.border, '--card-text': color.text }}
                    >
                      <span className="principal-class-index">{String(index + 1).padStart(2, '0')}</span>
                      <span className="principal-class-stripe" />
                      <span className="principal-class-body">
                        <span className="principal-class-name">{group.name}</span>
                        <span className="principal-class-meta">
                          <span className="principal-class-dot" style={{ background: color.border }} />
                          {(students || []).filter((item) => (item.classIds || []).includes(group.id)).length}
                          {' '}
                          {(students || []).filter((item) => (item.classIds || []).includes(group.id)).length === 1 ? 'alumne' : 'alumnes'}
                        </span>
                      </span>
                      <span className="principal-class-arrow">→</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function SectionPlaceholder({ icon, title, description }) {
  return (
    <div className="stack">
      <div>
        <span className="section-kicker">Espai de treball</span>
        <h2 className="section-title">{title}</h2>
      </div>
      <div className="card placeholder-card">
        <div className="card-body">
          <span className="placeholder-icon"><Icon name={icon} /></span>
          <h3>{title}</h3>
          <p className="muted">{description}</p>
        </div>
      </div>
    </div>
  );
}

function YearManager({ years, schoolYear, onSelectYear, onCreateYear }) {
  const [newYear, setNewYear] = useState(() => nextSchoolYear(schoolYear));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(event, mode) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onCreateYear(newYear.trim(), mode);
      setNewYear(nextSchoolYear(newYear.trim()));
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut crear el curs.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card year-manager">
      <div className="card-body">
        <span className="section-kicker">Curs escolar</span>
        <h3 className="section-title">Cursos i horaris</h3>
        <div className="manage-bar">
          <div className="manage-current">
            <span className="section-kicker">Curs actiu</span>
            <strong>{schoolYear}</strong>
          </div>
          <label className="manage-field">
            <span>Canvia de curs</span>
            <select value={schoolYear} onChange={(event) => onSelectYear(event.target.value)}>
              {years.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
          <form className="manage-new" onSubmit={(event) => create(event, 'duplicate')}>
            <label htmlFor="new-year">Curs nou</label>
            <input
              id="new-year"
              value={newYear}
              onChange={(event) => setNewYear(event.target.value)}
              placeholder="2027-2028"
              pattern="\d{4}-\d{4}"
              required
            />
            <button className="button" type="submit" disabled={busy}>Duplica</button>
            <button className="button button-soft" type="button" disabled={busy} onClick={(event) => create(event, 'blank')}>Crea buit</button>
          </form>
        </div>
        <p className="muted text-sm">
          <strong>Duplica</strong> copia els grups, els colors i l'horari del curs actual (no els alumnes ni les sessions).
          <strong> Crea buit</strong> només crea el curs amb les hores per defecte.
        </p>
        {error && <p className="manage-error">{error}</p>}
      </div>
    </div>
  );
}

function WeekPicker({ monday, schoolYear, onChange }) {
  const bounds = schoolYearBounds(schoolYear);
  const canPrev = monday > addDays(bounds.start, -7);
  const canNext = addDays(monday, 7) <= bounds.end;
  return (
    <div className="week-picker">
      <button className="icon-button week-picker-arrow" type="button" disabled={!canPrev} onClick={() => onChange(addDays(monday, -7))} aria-label="Setmana anterior">‹</button>
      <div className="week-picker-label">
        <span className="section-kicker">Setmana</span>
        <strong>{formatWeekLabel(monday)}</strong>
      </div>
      <button className="icon-button week-picker-arrow" type="button" disabled={!canNext} onClick={() => onChange(addDays(monday, 7))} aria-label="Setmana següent">›</button>
      <button className="button ghost button-small" type="button" onClick={() => onChange(mondayOf(toISODate(new Date())))}>Avui</button>
    </div>
  );
}

/** Botó «+» amb les dues maneres de generar sessions. */
function CreateSessionsMenu({ onWeek, onRange, label = 'Crea sessions' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (ref.current && !ref.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="create-menu" ref={ref}>
      <button className="button button-soft" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="plus" /> {label}
      </button>
      {open && (
        <div className="create-menu-popover" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onWeek(); }}>
            <Icon name="calendar" />
            <span><strong>Per setmana</strong><small>Prepara la setmana que estàs veient</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onRange(); }}>
            <Icon name="clock" />
            <span><strong>Per rang de dates</strong><small>Tria la data d’inici i la de fi</small></span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Finestra per generar sessions entre dues dates, sense caps de setmana ni festes. */
function SessionRangeModal({ schoolYear, previewCount, onGenerate, onClose }) {
  const bounds = schoolYearBounds(schoolYear);
  const today = toISODate(new Date());
  const firstMonday = mondayOf(today) < bounds.start ? bounds.start : mondayOf(today);
  const [start, setStart] = useState(firstMonday > bounds.end ? bounds.end : firstMonday);
  const [end, setEnd] = useState(addDays(firstMonday > bounds.end ? bounds.end : firstMonday, 6) > bounds.end
    ? bounds.end : addDays(firstMonday > bounds.end ? bounds.end : firstMonday, 6));
  const [error, setError] = useState('');
  const first = Number(String(schoolYear).slice(0, 4));
  const nextYear = first + 1;
  const presets = [
    { label: '1r trimestre', start: `${first}-09-01`, end: `${first}-12-31` },
    { label: '2n trimestre', start: `${nextYear}-01-01`, end: `${nextYear}-03-31` },
    { label: '3r trimestre', start: `${nextYear}-04-01`, end: `${nextYear}-06-30` },
    { label: 'Tot el curs', start: bounds.start, end: bounds.end },
  ];
  const count = start && end && start <= end ? previewCount(start, end) : 0;

  function applyPreset(preset) {
    setStart(preset.start < bounds.start ? bounds.start : preset.start);
    setEnd(preset.end > bounds.end ? bounds.end : preset.end);
    setError('');
  }

  function generate() {
    if (!start || !end || start > end) {
      setError('La data d’inici ha de ser anterior o igual a la data de fi.');
      return;
    }
    onGenerate({ start, end });
    onClose();
  }

  return (
    <div className="session-overlay" role="presentation" onClick={onClose}>
      <div className="range-modal" role="dialog" aria-modal="true" aria-label="Genera sessions per rang de dates" onClick={(event) => event.stopPropagation()}>
        <header className="session-modal-head">
          <div>
            <span className="section-kicker">Generació de sessions</span>
            <strong>Rang de dates</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Tanca">✕</button>
        </header>
        <div className="range-modal-body">
          {error && <div className="alert danger">{error}</div>}
          <div className="range-presets">
            {presets.map((preset) => (
              <button className="button button-soft button-small" type="button" key={preset.label} onClick={() => applyPreset(preset)}>{preset.label}</button>
            ))}
          </div>
          <div className="range-dates">
            <label>Data d’inici
              <input type="date" min={bounds.start} max={bounds.end} value={start} onChange={(event) => setStart(event.target.value)} />
            </label>
            <label>Data de fi
              <input type="date" min={bounds.start} max={bounds.end} value={end} onChange={(event) => setEnd(event.target.value)} />
            </label>
          </div>
          <p className="fine-print">Es crearan sessions només a les hores reals de l’horari. Caps de setmana i dies de festa s’ignoren automàticament, i les sessions que ja existeixen no es modifiquen. Les festes es gestionen a l’Horari.</p>
          <div className="range-summary"><Icon name="calendar" /> {count} {count === 1 ? 'franja' : 'franges'} de l’horari dins del rang</div>
        </div>
        <footer className="session-modal-foot">
          <div className="section-actions">
            <button className="button ghost" type="button" onClick={onClose}>Cancel·la</button>
            <button className="button" type="button" onClick={generate}>Genera {count ? `(${count})` : ''}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Botó compacte per afegir festes; cada dia o periode surt en vermell petit a sota. */
function HolidaysMenu({ schoolYear, ranges, onAddRange, onRemoveRange }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('day');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState('');
  const ref = useRef(null);
  const bounds = schoolYearBounds(schoolYear);
  const preview = expandDateRanges([{ start, end }]).length;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (ref.current && !ref.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function addRange() {
    if (!start || !end || start > end || start < bounds.start || end > bounds.end) {
      setError('Tria una data d’inici i una de fi dins del curs.');
      return;
    }
    onAddRange({ start, end });
    setStart('');
    setEnd('');
    setError('');
    setOpen(false);
  }

  return (
    <div className="holidays-menu" ref={ref}>
      <button className="button button-soft" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="calendar" /> Dies festa{ranges.length ? ` (${ranges.length})` : ''}
      </button>
      {open && (
        <div className="holidays-popover">
          <div className="holidays-tabs">
            <button className={mode === 'day' ? 'active' : ''} type="button" onClick={() => { setMode('day'); setError(''); }}>Un dia</button>
            <button className={mode === 'range' ? 'active' : ''} type="button" onClick={() => { setMode('range'); setError(''); }}>Un periode</button>
          </div>
          {mode === 'day' ? (
            <input
              type="date"
              min={bounds.start}
              max={bounds.end}
              value=""
              onChange={(event) => { if (event.target.value) onAddRange({ start: event.target.value, end: event.target.value }); }}
              aria-label="Afegeix una data de festa"
            />
          ) : (
            <>
              <label>Des de<input type="date" min={bounds.start} max={bounds.end} value={start} onChange={(event) => { setStart(event.target.value); setError(''); }} /></label>
              <label>Fins al<input type="date" min={bounds.start} max={bounds.end} value={end} onChange={(event) => { setEnd(event.target.value); setError(''); }} /></label>
              {preview > 0 && <small className="holiday-preview">{preview} dies</small>}
              {error && <small className="holiday-error">{error}</small>}
              <button className="button button-small" type="button" onClick={addRange}>Afegeix el periode</button>
            </>
          )}
          <small>Clica un rang de sota per treure'l.</small>
        </div>
      )}
      {ranges.length > 0 && (
        <div className="holiday-chips">
          {ranges.map((range, index) => (
            <button
              className="holiday-chip"
              type="button"
              key={`${range.start}_${range.end}_${index}`}
              onClick={() => onRemoveRange(index)}
              title="Treu aquesta festa"
            >
              {range.start === range.end
                ? formatDateShort(range.start)
                : `${formatDateShort(range.start)} – ${formatDateShort(range.end)}`} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HorariView({
  classes, entries, slots, schoolYear, editing, onToggleEdit, onChangeCell, onChangeSlot,
  years, onSelectYear, onCreateYear, activities, sessionFor, weekMonday, onWeekChange, onOpenSession,
  onCreateWeek, onOpenRange, holidays, holidayRanges, onAddHolidayRange, onRemoveHolidayRange,
}) {
  const classEntries = entries.filter((entry) => entry.kind === 'class');
  const byCell = new Map();
  for (const entry of classEntries) {
    const key = `${entry.day}-${slotIndexOf(entry, slots)}`;
    const current = byCell.get(key);
    if (!current || (Number.isInteger(entry.slotIndex) && !Number.isInteger(current.slotIndex))) byCell.set(key, entry);
  }
  const dates = weekDates(weekMonday);

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <span className="section-kicker">Horari setmanal</span>
          <h2 className="section-title">Horari de totes les classes</h2>
        </div>
        <div className="section-actions">
          <span className="badge blue">Curs {schoolYear}</span>
          <CreateSessionsMenu label="Crea sessions" onWeek={onCreateWeek} onRange={onOpenRange} />
          <button className={`button${editing ? '' : ' button-soft'}`} type="button" onClick={onToggleEdit}>
            <Icon name={editing ? 'check' : 'edit'} />
            {editing ? 'Fet' : 'Edita'}
          </button>
        </div>
      </div>
      <WeekPicker monday={weekMonday} schoolYear={schoolYear} onChange={onWeekChange} />
      <div className="card table-wrap timetable-grid-wrap">
        <table className={`timetable-grid${editing ? ' editable' : ''}`}>
          <thead>
            <tr><th>Hora</th>{DAYS.map((day, index) => (
              <th key={day}>
                {day}
                <small>{formatDateShort(dates[index].iso)}{holidays.includes(dates[index].iso) ? ' · Festa' : ''}</small>
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {slots.map((slot, slotIndex) => (
              <tr key={slotIndex}>
                <th>
                  {editing ? (
                    <span className="slot-edit">
                      <input type="time" value={slot.start} aria-label={`Inici de la franja ${slotIndex + 1}`}
                        onChange={(event) => onChangeSlot(slotIndex, 'start', event.target.value)} />
                      <input type="time" value={slot.end} aria-label={`Fi de la franja ${slotIndex + 1}`}
                        onChange={(event) => onChangeSlot(slotIndex, 'end', event.target.value)} />
                    </span>
                  ) : (
                    <>{slot.start}<small>{slot.end}</small></>
                  )}
                </th>
                {DAYS.map((day, dayIndex) => {
                  const isHoliday = holidays.includes(dates[dayIndex].iso);
                  const entry = byCell.get(`${dayIndex + 1}-${slotIndex}`);
                  const group = entry?.classId ? classes.find((item) => item.id === entry.classId) : null;
                  const tone = group ? colorOf(group.color) : { bg: '#fff', border: '#e2e8f0', text: '#cbd5e1' };
                  const style = { background: tone.bg, borderColor: tone.border, color: group ? tone.text : '#cbd5e1' };
                  return (
                    <td key={day}>
                      {editing ? (
                        <select
                          className="tt-select"
                          style={style}
                          value={entry?.classId || ''}
                          onChange={(event) => onChangeCell(dayIndex + 1, slotIndex, event.target.value)}
                          aria-label={`${day}, ${slot.start}`}
                        >
                          <option value="">—</option>
                          {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      ) : isHoliday ? (
                        <div className="tt-cell holiday-cell" title="Dia de festa">Festa</div>
                      ) : group ? (
                        <button
                          className="tt-cell session-cell"
                          style={style}
                          type="button"
                          onClick={() => onOpenSession(group.id, dates[dayIndex].iso, slotIndex, 'horari')}
                          title={`Obre la sessió del ${dates[dayIndex].iso}`}
                        >
                          <span>{group.name}</span>
                          {(() => {
                            const session = sessionFor(group.id, dates[dayIndex].iso, slotIndex);
                            if (!session) return null;
                            const count = (session.items || []).length;
                            const countLabel = count ? `${count} ${count === 1 ? 'activitat' : 'activitats'}` : '';
                            if (sessionPrepared(session, activities)) {
                              if (session.status === 'done') {
                                return <small className="prepared-mark done"><Icon name="check" /> Feta</small>;
                              }
                              return <small className="prepared-mark"><Icon name="flag" /> {countLabel || 'Preparada'}</small>;
                            }
                            return countLabel ? <small>{countLabel}</small> : null;
                          })()}
                        </button>
                      ) : <div className="tt-cell" style={style} />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="placeholder-note">
        <Icon name="clock" />
        <span>{editing
          ? 'Pots canviar el grup de cada franja i les hores. Els canvis es desan automàticament.'
          : 'Prem Edita per canviar els grups o les hores de cada franja.'}</span>
      </div>
      <div className="holidays-section">
        <HolidaysMenu
          schoolYear={schoolYear}
          ranges={holidayRanges}
          onAddRange={onAddHolidayRange}
          onRemoveRange={onRemoveHolidayRange}
        />
      </div>
      <YearManager years={years} schoolYear={schoolYear} onSelectYear={onSelectYear} onCreateYear={onCreateYear} />
    </div>
  );
}

function inviteLink(code) {
  return `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(code)}`;
}

/** Llegeix files enganxades des de l'Excel (tabuladors) o un CSV (comes / punt i coma). */
function parseStudentRows(text) {
  const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.split(/\t|,|;/)
      .map((part) => part.replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
    const emailIndex = parts.findIndex((part) => emailPattern.test(part));
    if (emailIndex < 1) continue;
    const email = parts[emailIndex].toLowerCase();
    const name = parts.slice(0, emailIndex).join(' ').trim();
    if (!name || /^(nom|name|alumne|student)$/i.test(name)) continue;
    rows.push({ name, email });
    if (rows.length >= 50) break;
  }
  return rows;
}

const ACTIVITY_TAGS = [
  'Àlgebra', 'Geometria', 'Fraccions', 'Estadística', 'Probabilitat', 'Funcions',
  'Mesures', 'Nombres', 'Problemes', 'Jocs', 'Projecte', 'Avaluació',
];

const TAG_KEYWORDS = {
  Àlgebra: ['algebra', 'equacio', 'equacions', 'incognita', 'despejar'],
  Geometria: ['geometria', 'triangle', 'angle', 'area', 'perimetre', 'poligon', 'circumferencia'],
  Fraccions: ['fraccio', 'fraccions', 'numerador', 'denominador', 'fraccionari'],
  Estadística: ['estadistica', 'mitjana', 'mediana', 'moda', 'grafic', 'diagrama', 'dades'],
  Probabilitat: ['probabilitat', 'atzar', 'dau', 'moneda'],
  Funcions: ['funcio', 'funcions', 'grafica', 'domini', 'corba'],
  Mesures: ['mesura', 'mesures', 'longitud', 'volum', 'capacitat', 'pes', 'metre'],
  Nombres: ['nombre', 'nombres', 'enter', 'decimal', 'arrodoniment', 'divisibilitat'],
  Problemes: ['problema', 'problemes', 'enunciat', 'resol', 'planteja'],
  Jocs: ['joc', 'jocs', 'carta', 'competencia', 'ronda'],
  Projecte: ['projecte', 'recerca', 'investigacio', 'treball de camp'],
  Avaluació: ['avaluacio', 'prova', 'examen', 'rubrica', 'qualificacio'],
};

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Suggeriments per paraules clau: no és IA, només busca termes al títol i al text. */
function suggestActivityTags(title, content) {
  const text = normalizeText(`${title} ${content}`);
  return Object.entries(TAG_KEYWORDS)
    .filter(([, words]) => words.some((word) => new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(text)))
    .map(([tag]) => tag);
}

const MAX_ATTACHMENT_BYTES = 500 * 1024;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Converteix el document desat en una URL local per veure'l al navegador sense baixar-lo. */
function base64ToBlobUrl(data, mime) {
  const binary = atob(String(data || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'application/pdf' }));
}

/** Títol i etiquetes a partir del nom del fitxer. No es llegeix el contingut del document. */
function infoFromDocumentName(file) {
  const title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Activitat';
  return { title, tags: suggestActivityTags(title, ''), sourceName: file.name };
}

async function prepareDocument(file) {
  const info = infoFromDocumentName(file);
  let attachment = null;
  let note = `Títol i etiquetes proposats a partir del nom del fitxer (${info.tags.length} ${info.tags.length === 1 ? 'etiqueta' : 'etiquetes'}). Tu acaba la descripció.`;
  if (file.size <= MAX_ATTACHMENT_BYTES) {
    attachment = { name: file.name, mime: file.type || 'application/pdf', data: await fileToBase64(file) };
  } else {
    note += ' El fitxer supera els 500 KB i no es pot desar al pla gratuït: el document no quedarà adjunt.';
  }
  return { ...info, attachment, note };
}

/** Redueix la foto fins que la codificació en base64 cab dins del límit del pla gratuït. */
async function preparePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('No s’ha pogut llegir la imatge.'));
      image.src = url;
    });
    let maxSide = 1400;
    let quality = 0.82;
    let data = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height, 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      data = canvas.toDataURL('image/jpeg', quality).split(',')[1] || '';
      if ((data.length * 3) / 4 <= MAX_ATTACHMENT_BYTES) break;
      quality = Math.max(0.35, quality - 0.15);
      maxSide = Math.round(maxSide * 0.75);
    }
    if ((data.length * 3) / 4 > MAX_ATTACHMENT_BYTES) throw new Error('La foto és massa gran per desar-la al pla gratuït.');
    return {
      attachment: { name: file.name || 'foto-pissarra.jpg', mime: 'image/jpeg', data },
      note: 'Foto de la pissarra reduïda per cabre al pla gratuït (màxim 500 KB).',
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function SessionsView({
  group, sessions, timetable, slots, schoolYear, weekMonday, holidays, activities,
  onWeekChange, onOpenSession, onCreateWeek, onOpenRange,
}) {
  const dates = weekDates(weekMonday);
  const entries = timetable.filter((entry) => entry.kind === 'class' && entry.classId === group.id);
  const byCell = new Map(entries.map((entry) => [`${entry.day}-${slotIndexOf(entry, slots)}`, entry]));
  const availableSlots = dates.flatMap(({ iso, day }) => slots.map((slot, slotIndex) => {
    if (!byCell.has(`${day}-${slotIndex}`)) return null;
    const session = sessions.find((item) => item.classId === group.id && item.date === iso && item.slotIndex === slotIndex);
    return { key: `${iso}-${slotIndex}`, date: iso, day, slotIndex, slot, session };
  }).filter(Boolean));
  // Les setmanes comencen buides: només es mostren les sessions realment creades.
  const cells = availableSlots.filter((cell) => cell.session);

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <span className="section-kicker">Planificació del grup</span>
          <h2 className="section-title">Sessions de {group.name}</h2>
        </div>
        <div className="section-actions">
          <span className="badge blue">{cells.length} {cells.length === 1 ? 'sessió' : 'sessions'}</span>
          <CreateSessionsMenu label="Crea sessions" onWeek={onCreateWeek} onRange={onOpenRange} />
        </div>
      </div>
      <WeekPicker monday={weekMonday} schoolYear={schoolYear} onChange={onWeekChange} />
      {cells.length ? (
        <div className="session-grid">
          {cells.map((cell) => {
            const done = cell.session?.status === 'done';
            const isHoliday = holidays.includes(cell.date);
            const items = cell.session?.items || [];
            const titles = items.map((item) => item.title).filter(Boolean);
            const prepared = sessionPrepared(cell.session, activities);
            return (
              <button
                className={`session-slot-card${done ? ' done' : ''}${isHoliday ? ' holiday' : ''}`}
                key={cell.key}
                type="button"
                onClick={() => onOpenSession(group.id, cell.date, cell.slotIndex, 'group')}
              >
                <span className="session-slot-stub">
                  <span className="session-slot-day">{DAYS[cell.day - 1]} {formatDateShort(cell.date)}</span>
                  <strong className="session-slot-time">{cell.slot.start}–{cell.slot.end}</strong>
                  {isHoliday ? (
                    <span className="badge amber">Festa</span>
                  ) : done ? (
                    <span className="badge green"><Icon name="check" /> Feta</span>
                  ) : prepared ? (
                    <span className="badge navy"><Icon name="flag" /> Preparada</span>
                  ) : titles.length ? (
                    <span className="badge blue">{titles.length} {titles.length === 1 ? 'activitat' : 'activitats'}</span>
                  ) : null}
                </span>
                <span className="session-slot-main">
                  <span className="session-slot-title">{cell.session.theory?.trim() ? cell.session.theory.trim() : 'Sense explicació encara'}</span>
                  {titles.length > 0 && <span className="session-slot-activities">{titles.slice(0, 4).join(' · ')}{titles.length > 4 ? ` · i ${titles.length - 4} més` : ''}</span>}
                  <span className="session-slot-open">Obre la sessió →</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : availableSlots.length ? (
        <div className="empty">
          <span className="empty-icon">♧</span>
          <strong>Encara no hi ha sessions a aquesta setmana</strong>
          <p className="muted">Pulsa «Crea sessions» → «Per setmana» per preparar les {availableSlots.length} {availableSlots.length === 1 ? 'franja' : 'franges'} de l'horari.</p>
        </div>
      ) : (
        <div className="empty"><span className="empty-icon">♧</span><strong>Sense hores aquesta setmana</strong><p className="muted">Posa hores a l'horari principal per crear-hi sessions.</p></div>
      )}
    </div>
  );
}

/** Previsualització d'un document desat a l'activitat, amb baixada independent. */
function DocumentPreview({ preview, onClose }) {
  return (
    <div className="doc-preview-overlay" role="presentation" onClick={onClose}>
      <div className="doc-preview-modal" role="dialog" aria-modal="true" aria-label={`Previsualització de ${preview.name}`} onClick={(event) => event.stopPropagation()}>
        <div className="doc-preview-head">
          <div>
            <span className="section-kicker">Previsualització</span>
            <strong>{preview.name}</strong>
          </div>
          <div className="section-actions">
            <a className="button button-soft button-small" href={preview.url} download={preview.name}><Icon name="download" /> Baixa’l</a>
            <button className="button ghost button-small" type="button" onClick={onClose}>Tanca</button>
          </div>
        </div>
        {String(preview.mime || '').startsWith('image/')
          ? <img className="doc-preview-image" src={preview.url} alt={preview.name} />
          : <iframe className="doc-preview-frame" src={preview.url} title={preview.name} />}
        <p className="fine-print">{String(preview.mime || '').startsWith('image/') ? 'La foto es mostra des del teu dispositiu.' : 'El document es mostra al navegador des del teu dispositiu.'} Baixa’l només si el vols guardar.</p>
      </div>
    </div>
  );
}

/** Formulari del banc d'activitats, reutilitzat des del banc i des d'una sessió. */
function ActivityEditor({
  activity = null, onSave, onClose, heading, submitLabel = 'Desa l’activitat',
  simple = false, fixedType = null, defaultTitle = '',
}) {
  const fieldId = useId();
  const initialType = fixedType || activity?.type || 'document';
  const [form, setForm] = useState(() => activity
    ? { ...activity, type: activity.type || initialType }
    : { title: defaultTitle, content: '', tags: [], sourceName: '', attachment: null, type: initialType });
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [docBusy, setDocBusy] = useState(false);
  const [docNote, setDocNote] = useState('');
  const [preview, setPreview] = useState(null);
  const fileInputRef = useRef(null);
  const previewUrlRef = useRef(null);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  function closePreview() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  }

  function openPreview(attachment) {
    if (!attachment?.data) return;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = base64ToBlobUrl(attachment.data, attachment.mime);
    previewUrlRef.current = url;
    setPreview({ url, name: attachment.name, mime: attachment.mime || 'application/pdf' });
  }

  async function attachFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setDocBusy(true);
    setError('');
    try {
      if (form.type === 'pissarra') {
        const parsed = await preparePhoto(file);
        setForm((current) => ({
          ...current,
          title: current.title || defaultTitle || 'Activitat de pissarra',
          attachment: parsed.attachment,
        }));
        setDocNote(parsed.note);
      } else {
        const parsed = await prepareDocument(file);
        setForm((current) => ({
          ...current,
          title: parsed.title,
          tags: [...new Set([...current.tags, ...parsed.tags])],
          sourceName: parsed.sourceName,
          attachment: parsed.attachment,
        }));
        setDocNote(parsed.note);
      }
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut preparar el fitxer.');
    } finally {
      setDocBusy(false);
    }
  }

  function changeType(type) {
    setForm((current) => ({ ...current, type, attachment: null, sourceName: '' }));
    setDocNote('');
    setError('');
  }

  function repropose() {
    const name = form?.sourceName || form?.attachment?.name;
    if (!name) return;
    const info = infoFromDocumentName({ name });
    setForm((current) => ({
      ...current,
      title: info.title,
      tags: [...new Set([...current.tags, ...info.tags])],
    }));
  }

  function toggleFormTag(tag) {
    setForm((current) => ({
      ...current,
      tags: current.tags.includes(tag) ? current.tags.filter((item) => item !== tag) : [...current.tags, tag],
    }));
  }

  function addCustomTag() {
    const tag = tagInput.trim();
    if (!tag) return;
    if (!form.tags.includes(tag)) toggleFormTag(tag);
    setTagInput('');
  }

  function applySuggestions() {
    const found = suggestActivityTags(form.title, form.content).filter((tag) => !form.tags.includes(tag));
    setForm((current) => ({ ...current, tags: [...current.tags, ...found] }));
  }

  async function save(event) {
    event.preventDefault();
    setError('');
    const title = (form.title || defaultTitle || 'Activitat').trim();
    if (!title) return;
    if (simple && !form.attachment) {
      setError('Adjunta un PDF o una foto per afegir l’activitat a la sessió.');
      return;
    }
    setBusy(true);
    try {
      await onSave({
        ...form,
        title,
        content: simple ? '' : form.content.trim(),
        tags: simple ? [] : form.tags,
      });
      onClose();
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut desar l’activitat.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="alert danger">{error}</div>}
      <form className="card activity-editor" onSubmit={save}>
        <div className="card-body">
          <span className="section-kicker">{heading || (form.id ? 'Edita l’activitat' : 'Activitat nova')}</span>
          <div className="field">
            <label htmlFor={`${fieldId}-title`}>Títol</label>
            <input id={`${fieldId}-title`} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="P. ex. Problemes de fraccions" required={!simple} />
          </div>
          {!simple && (
            <div className="field">
              <span className="field-label">Tipus d'activitat</span>
              <div className="activity-type-tabs">
                <button className={form.type === 'document' ? 'active' : ''} type="button" onClick={() => changeType('document')}>
                  <Icon name="book" /> Document (PDF)
                </button>
                <button className={form.type === 'pissarra' ? 'active' : ''} type="button" onClick={() => changeType('pissarra')}>
                  <Icon name="camera" /> Activitat de pissarra
                </button>
              </div>
            </div>
          )}
          {form.type === 'pissarra' ? (
            <div className="field">
              <span className="field-label">{simple ? 'Foto de la pissarra' : 'Foto de la pissarra (opcional)'}</span>
              <div className="inline-form activity-doc">
                <button className="button button-soft button-small" type="button" disabled={docBusy} onClick={() => fileInputRef.current?.click()}>
                  <Icon name="camera" /> {docBusy ? 'Preparant la foto…' : form.attachment ? 'Canvia la foto' : 'Afegeix una foto'}
                </button>
                {form.attachment && (
                  <button className="badge blue activity-preview-file" type="button" onClick={() => openPreview(form.attachment)} title="Previsualitza la foto">
                    <Icon name="eye" /> {form.attachment.name}
                  </button>
                )}
              </div>
              {docNote && <p className="fine-print">{docNote}</p>}
              <p className="fine-print">{simple
                ? 'Fes la foto o tria-la del dispositiu i ja està. La descripció i les etiquetes les pots posar després al banc.'
                : 'Pots fer la foto amb la càmera o triar-ne una del dispositiu. Es desa reduïda per cabre al pla gratuït.'}</p>
            </div>
          ) : (
            <div className="field">
              <span className="field-label">{simple ? 'Document PDF' : 'Document de l’activitat (opcional)'}</span>
              <div className="inline-form activity-doc">
                <button className="button button-soft button-small" type="button" disabled={docBusy} onClick={() => fileInputRef.current?.click()}>
                  <Icon name="book" /> {docBusy ? 'Preparant el document…' : form.attachment ? 'Canvia el document' : simple ? 'Puja un PDF' : 'Puja un document (títol i etiquetes del nom)'}
                </button>
                {form.attachment && (
                  <button className="badge blue activity-preview-file" type="button" onClick={() => openPreview(form.attachment)} title="Previsualitza el document">
                    <Icon name="eye" /> {form.attachment.name}
                  </button>
                )}
              </div>
              {docNote && <p className="fine-print">{docNote}</p>}
              {!simple && (form.sourceName || form.attachment?.name) && <button className="button ghost button-small" type="button" onClick={repropose}>Torna a proposar títol i etiquetes del nom</button>}
              <p className="fine-print">{simple
                ? 'Puja el PDF i ja està. La descripció i les etiquetes les pots posar després al banc.'
                : 'No es llegeix el contingut del document: el títol i les etiquetes surten del nom del fitxer. La descripció l’escrius tu.'}</p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={form.type === 'pissarra' ? 'image/*' : 'application/pdf,.pdf,.txt,.md,text/plain'}
            hidden
            onChange={attachFile}
            aria-label={form.type === 'pissarra' ? 'Foto de la pissarra' : 'Document de l’activitat'}
          />
          {!simple && (
            <>
              <div className="field">
                <label htmlFor={`${fieldId}-content`}>Contingut</label>
                <textarea id={`${fieldId}-content`} rows="7" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="Enunciat, passos, materials, solucionari…" />
              </div>
              <div className="field">
                <span className="field-label">Etiquetes</span>
                <div className="tag-chips">
                  {[...new Set([...ACTIVITY_TAGS, ...form.tags])].map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`tag-chip${form.tags.includes(tag) ? ' selected' : ''}`}
                      aria-pressed={form.tags.includes(tag)}
                      onClick={() => toggleFormTag(tag)}
                    >{tag}</button>
                  ))}
                </div>
                <div className="inline-form activity-custom-tag">
                  <input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="Afegeix una etiqueta nova" aria-label="Etiqueta nova" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomTag(); } }} />
                  <button className="button button-soft button-small" type="button" onClick={addCustomTag}>Afegeix</button>
                </div>
                <button className="button ghost button-small" type="button" onClick={applySuggestions}>Suggereix etiquetes a partir del títol i la descripció</button>
                <p className="fine-print">No és IA: només reconeix paraules clau del títol i de la descripció. Pots afegir o treure etiquetes a mà.</p>
              </div>
            </>
          )}
          <div className="section-actions">
            <button className="button" type="submit" disabled={busy}>{busy ? 'Desant…' : submitLabel}</button>
            <button className="button ghost" type="button" onClick={onClose}>Cancel·la</button>
          </div>
        </div>
      </form>
      {preview && <DocumentPreview preview={preview} onClose={closePreview} />}
    </>
  );
}

function ActivityPicker({ activities, onPick, onCancel }) {
  const [search, setSearch] = useState('');
  const [tags, setTags] = useState([]);
  // Les activitats pendents de validar no es poden agafar del banc fins que el professor les validi.
  const bank = activities.filter((item) => item.status !== 'pending');
  const allTags = [...new Set(bank.flatMap((item) => item.tags || []))].sort((a, b) => a.localeCompare(b, 'ca'));
  const visible = bank
    .filter((item) => normalizeText(item.title).includes(normalizeText(search)))
    .filter((item) => tags.every((tag) => (item.tags || []).includes(tag)));

  return (
    <div className="activity-picker">
      <div className="inline-form">
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca al banc d'activitats…" aria-label="Cerca al banc d'activitats" />
        <button className="button ghost button-small" type="button" onClick={onCancel}>Tanca</button>
      </div>
      {allTags.length > 0 && (
        <div className="tag-chips">
          {allTags.map((tag) => (
            <button key={tag} type="button" className={`tag-chip${tags.includes(tag) ? ' selected' : ''}`} aria-pressed={tags.includes(tag)} onClick={() => setTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag])}>{tag}</button>
          ))}
        </div>
      )}
      <div className="activity-picker-list">
        {visible.map((activity) => (
          <button className="activity-picker-item" key={activity.id} type="button" onClick={() => onPick(activity)}>
            <strong>{activity.title}</strong>
            <span className="fine-print">{(activity.tags || []).join(' · ') || 'Sense etiquetes'}</span>
          </button>
        ))}
        {!visible.length && <p className="muted text-sm">No hi ha activitats que coincideixin.</p>}
      </div>
    </div>
  );
}

function SessionModal({
  session, group, activities, previousSessions, slots, onClose, onSave,
  onAddActivity, onCreateActivity, onNavigate, canPrev, canNext,
}) {
  const [draft, setDraft] = useState(session);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newType, setNewType] = useState('document');
  const [picked, setPicked] = useState(null);
  const [followsKey, setFollowsKey] = useState(session.followsKey || '');
  const [followsOpen, setFollowsOpen] = useState(!!session.followsKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const slot = slots[session.slotIndex] || DEFAULT_SLOTS[session.slotIndex] || DEFAULT_SLOTS[0];

  useEffect(() => {
    setDraft(session);
    setFollowsKey(session.followsKey || '');
    setFollowsOpen(!!session.followsKey);
    setPickerOpen(false);
    setNewOpen(false);
    setNewType('document');
    setPicked(null);
    setError('');
  }, [session.id, session.date, session.slotIndex]);

  function change(changes) {
    setDraft((current) => ({ ...current, ...changes }));
  }

  async function save(changes = {}, closeAfter = false) {
    const next = { ...draft, ...changes };
    setDraft(next);
    setBusy(true);
    setError('');
    try {
      await onSave(next);
      if (closeAfter) onClose();
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut desar la sessió.');
    } finally {
      setBusy(false);
    }
  }

  function updateItem(index, changes) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item, position) => position === index ? { ...item, ...changes } : item),
    }));
  }

  function removeItem(index) {
    save({ items: draft.items.filter((_, position) => position !== index) });
  }

  async function addPicked() {
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const updated = await onAddActivity(session, picked);
      if (updated) setDraft(updated);
      setPicked(null);
      setPickerOpen(false);
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut afegir l’activitat.');
    } finally {
      setBusy(false);
    }
  }

  async function createNewActivity(data) {
    // No cal validar-la abans: s'afegeix a la sessió i queda pendent al banc per gestionar després.
    const updated = await onCreateActivity(draft, data);
    if (updated) setDraft(updated);
  }

  async function updateFollows(value) {
    const selected = previousSessions.find((item) => item.key === value);
    setFollowsKey(value);
    await save({ followsKey: value, followsLabel: selected?.label || '' });
  }

  async function toggleFollows() {
    if (followsKey) {
      setFollowsKey('');
      setFollowsOpen(false);
      await save({ followsKey: '', followsLabel: '' });
      return;
    }
    const first = previousSessions[0];
    setFollowsOpen(true);
    if (first) {
      setFollowsKey(first.key);
      await save({ followsKey: first.key, followsLabel: first.label });
    }
  }

  const followedLabel = previousSessions.find((item) => item.key === followsKey)?.label
    || draft.followsLabel || '';
  const done = draft.status === 'done';
  return (
    <div className="session-overlay" role="presentation" onClick={onClose}>
      <div className="session-modal" role="dialog" aria-modal="true" aria-label={`Sessió de ${group.name}`} onClick={(event) => event.stopPropagation()}>
        <header className="session-modal-head">
          <div className="session-modal-title">
            <span className="group-mini-dot" style={{ background: colorOf(group.color).border }} />
            <div>
              <span className="section-kicker">Sessió · {group.name}</span>
              <strong>{DAYS[draft.day - 1]} {formatDateShort(draft.date)} · {slot.start}–{slot.end}</strong>
            </div>
          </div>
          <div className="section-actions">
            <button className="icon-button" type="button" disabled={!canPrev} onClick={() => onNavigate(-1)} aria-label="Sessió anterior">‹</button>
            <button className="icon-button" type="button" disabled={!canNext} onClick={() => onNavigate(1)} aria-label="Sessió següent">›</button>
            <button className={`button button-small${done ? ' button-soft' : ''}`} type="button" disabled={busy} onClick={() => save({ status: done ? 'planned' : 'done' })}>
              <Icon name={done ? 'refresh' : 'check'} /> {done ? 'Torna a pendent' : 'Marca Feta'}
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Tanca la sessió">✕</button>
          </div>
        </header>

        <div className="session-modal-body">
          {error && <div className="alert danger">{error}</div>}

          <section className="session-block session-follows">
            <div className="spread">
              <button
                className={`button button-small${followsKey ? '' : ' button-soft'}`}
                type="button"
                disabled={busy || (!followsKey && !previousSessions.length)}
                aria-pressed={!!followsKey}
                onClick={toggleFollows}
              >
                <Icon name={followsKey ? 'check' : 'plus'} />
                {followsKey ? `Segueix · ${followedLabel}` : 'Segueix una sessió anterior'}
              </button>
              {followsOpen && followsKey && (
                <label className="follows-picker">
                  <span className="fine-print">Quina sessió?</span>
                  <select value={followsKey} disabled={busy} onChange={(event) => updateFollows(event.target.value)} aria-label="Quina sessió anterior">
                    {previousSessions.map((item) => (
                      <option value={item.key} key={item.key}>{item.label}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="fine-print">Només és una referència al diari: no canvia les activitats d'aquesta sessió ni les de les altres.</p>
          </section>

          <section className="session-block">
            <span className="section-kicker">Explicació / teoria</span>
            <p className="fine-print">Què faràs aquell dia a classe. Pots posar-hi també enllaços o recursos en text.</p>
            <textarea rows="5" value={draft.theory || ''} onChange={(event) => change({ theory: event.target.value })} placeholder="Objectius, explicació, passos, enllaços…" aria-label="Explicació de la sessió" />
          </section>

          <section className="session-block">
            <div className="spread">
              <div>
                <span className="section-kicker">Activitats d'aquesta sessió</span>
                <p className="fine-print">Tria una activitat del banc o afegeix-ne una de nova: només cal pujar el PDF o la foto. La descripció i les etiquetes les pots posar després al banc.</p>
              </div>
              <div className="section-actions">
                <button className="button button-soft button-small" type="button" onClick={() => { setPickerOpen((open) => !open); setPicked(null); setNewOpen(false); }}>
                  <Icon name="book" /> Del banc
                </button>
                <button className="button button-small" type="button" onClick={() => { setNewType('document'); setNewOpen(true); setPickerOpen(false); setPicked(null); }}>
                  <Icon name="plus" /> Activitat nova (PDF)
                </button>
                <button className="button button-small" type="button" onClick={() => { setNewType('pissarra'); setNewOpen(true); setPickerOpen(false); setPicked(null); }}>
                  <Icon name="camera" /> Activitat de pissarra
                </button>
              </div>
            </div>

            {pickerOpen && (
              <ActivityPicker
                activities={activities}
                onPick={(activity) => { setPicked(activity); setPickerOpen(false); }}
                onCancel={() => { setPickerOpen(false); setPicked(null); }}
              />
            )}

            {newOpen && (
              <ActivityEditor
                key={newType}
                heading={newType === 'pissarra' ? 'Activitat de pissarra' : 'Activitat nova (PDF)'}
                submitLabel="Afegeix a la sessió"
                simple
                fixedType={newType}
                defaultTitle={newType === 'pissarra' ? `Activitat de pissarra · ${formatDateShort(session.date)}` : ''}
                onSave={createNewActivity}
                onClose={() => setNewOpen(false)}
              />
            )}

            {picked && (
              <div className="session-resume">
                <strong>{picked.title}</strong>
                <p className="fine-print">S'afegirà només a aquesta sessió.</p>
                <div className="section-actions">
                  <button className="button button-small" type="button" disabled={busy} onClick={addPicked}>Afegeix a la sessió</button>
                  <button className="button ghost button-small" type="button" onClick={() => setPicked(null)}>Cancel·la</button>
                </div>
              </div>
            )}

            <div className="session-item-list">
              {(draft.items || []).map((item, index) => (
                <div className="session-activity" key={item.id || index}>
                  <div className="spread">
                    <div className="inline-form">
                      <strong>{item.title}</strong>
                      {item.type === 'pissarra' && <span className="badge blue"><Icon name="camera" /> Pissarra</span>}
                    </div>
                    <button className="icon-button danger-text" type="button" title="Treu de la sessió" aria-label="Treu de la sessió" onClick={() => removeItem(index)}><Icon name="trash" /></button>
                  </div>
                  {item.activityTitle && item.activityTitle !== item.title && <p className="fine-print">Del banc: {item.activityTitle}</p>}
                  <details className="session-item-details">
                    <summary>Detalls opcionals (enunciat, instruccions i data límit)</summary>
                    <div className="session-item-fields">
                      <label>Enunciat d'aquesta classe
                        <textarea rows="3" value={item.content || ''} onChange={(event) => updateItem(index, { content: event.target.value })} placeholder="Enunciat de l'activitat per a aquesta sessió…" />
                      </label>
                      <label>Instruccions extra
                        <textarea rows="2" value={item.instructions || ''} onChange={(event) => updateItem(index, { instructions: event.target.value })} placeholder="Indicacions només per a aquesta classe…" />
                      </label>
                      <label>Data límit d'entrega
                        <input type="date" value={item.dueDate || ''} onChange={(event) => updateItem(index, { dueDate: event.target.value })} />
                      </label>
                    </div>
                  </details>
                </div>
              ))}
              {!(draft.items || []).length && <p className="muted text-sm">Encara no hi ha activitats vinculades.</p>}
            </div>
          </section>

          <section className="session-block">
            <span className="section-kicker">Diari final · resum</span>
            <p className="fine-print">Un resum breu de què hem fet avui i on hem quedat.</p>
            <textarea rows="5" value={draft.diary || ''} onChange={(event) => change({ diary: event.target.value })} placeholder="Resum de la sessió: què hem fet, què hem après i per on continuem…" aria-label="Diari final · resum" />
          </section>
        </div>

        <footer className="session-modal-foot">
          <div className="section-actions">
            <button className="button ghost" type="button" onClick={onClose}>Tanca</button>
            <button className="button" type="button" disabled={busy} onClick={() => save({}, true)}>{busy ? 'Desant…' : 'Desa la sessió'}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ActivitiesView({ activities, onSave, onDelete, onDuplicate, onValidate }) {
  const [search, setSearch] = useState('');
  const [filterTags, setFilterTags] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cardPreview, setCardPreview] = useState(null);
  const cardPreviewUrlRef = useRef(null);

  useEffect(() => () => {
    if (cardPreviewUrlRef.current) URL.revokeObjectURL(cardPreviewUrlRef.current);
  }, []);

  function closeCardPreview() {
    if (cardPreviewUrlRef.current) {
      URL.revokeObjectURL(cardPreviewUrlRef.current);
      cardPreviewUrlRef.current = null;
    }
    setCardPreview(null);
  }

  function openCardPreview(attachment) {
    if (!attachment?.data) return;
    if (cardPreviewUrlRef.current) URL.revokeObjectURL(cardPreviewUrlRef.current);
    const url = base64ToBlobUrl(attachment.data, attachment.mime);
    cardPreviewUrlRef.current = url;
    setCardPreview({ url, name: attachment.name, mime: attachment.mime || 'application/pdf' });
  }

  /** Si una activitat antiga no té etiquetes desades, les deduïm del seu títol per mostrar-les. */
  function tagsOf(activity) {
    return (activity.tags || []).length ? activity.tags : suggestActivityTags(activity.title, '');
  }

  const allTags = [...new Set(activities.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, 'ca'));
  const pendingCount = activities.filter((item) => item.status === 'pending').length;
  // Les activitats pendents de validar es mostren primer, perquè el professor les gestioni.
  const visible = activities
    .filter((item) => normalizeText(item.title).includes(normalizeText(search)))
    .filter((item) => filterTags.every((tag) => tagsOf(item).includes(tag)))
    .sort((a, b) => {
      const pendingDifference = Number(b.status === 'pending') - Number(a.status === 'pending');
      if (pendingDifference) return pendingDifference;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

  function toggleFilter(tag) {
    setFilterTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
  }

  async function validate(activity) {
    setError('');
    setBusy(true);
    try {
      await onValidate(activity.id);
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut validar l’activitat.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(activity) {
    if (!window.confirm(`Vols esborrar «${activity.title}»? Això no es pot desfer.`)) return;
    setError('');
    setBusy(true);
    try {
      await onDelete(activity.id);
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut esborrar l’activitat.');
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(activity) {
    setError('');
    setBusy(true);
    try {
      await onDuplicate(activity.id);
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut duplicar l’activitat.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <span className="section-kicker">El teu repositori</span>
          <h2 className="section-title">Banc d’activitats</h2>
        </div>
        <div className="section-actions">
          {pendingCount > 0 && <span className="badge amber">{pendingCount} {pendingCount === 1 ? 'pendent' : 'pendents'} de validar</span>}
          <span className="badge blue">{activities.length} {activities.length === 1 ? 'activitat' : 'activitats'}</span>
          <button className="button" type="button" onClick={() => { setEditing('new'); setError(''); }}><Icon name="plus" /> Nova activitat</button>
        </div>
      </div>

      {error && <div className="alert danger">{error}</div>}

      <div className="card activity-toolbar">
        <div className="card-body">
          <label className="activity-search">
            <Icon name="search" />
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca per paraules del títol…" aria-label="Cerca per títol" />
          </label>
          <div className="filter-block">
            <span className="section-kicker">Filtra per etiquetes (pots triar-ne vàries)</span>
            {allTags.length ? (
              <div className="tag-chips">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`tag-chip${filterTags.includes(tag) ? ' selected' : ''}`}
                    aria-pressed={filterTags.includes(tag)}
                    onClick={() => toggleFilter(tag)}
                  >{tag}</button>
                ))}
              </div>
            ) : <p className="muted text-sm">Quan afegeixis etiquetes a les activitats, apareixeran aquí.</p>}
            {(search || filterTags.length > 0) && (
              <button className="button ghost button-small" type="button" onClick={() => { setSearch(''); setFilterTags([]); }}>Neteja els filtres</button>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <ActivityEditor
          key={editing === 'new' ? 'new' : editing.id}
          activity={editing === 'new' ? null : {
            id: editing.id,
            title: editing.title,
            content: editing.content || '',
            type: editing.type || 'document',
            tags: tagsOf(editing),
            sourceName: editing.sourceName || editing.attachment?.name || '',
            attachment: editing.attachment || null,
            status: editing.status || 'active',
          }}
          heading={editing === 'new' ? 'Activitat nova' : 'Edita l’activitat'}
          onSave={onSave}
          onClose={() => setEditing(null)}
        />
      )}

      {visible.length ? (
        <div className="activity-grid">
          {visible.map((activity) => (
            <article className={`card activity-card${activity.status === 'pending' ? ' pending' : ''}`} key={activity.id}>
              <div className="card-body">
                <div className="spread">
                  <h3>{activity.title}</h3>
                  {activity.status === 'pending' && <span className="badge amber">Pendent de validar</span>}
                </div>
                <p className="activity-preview">{activity.content || <span className="muted">Sense contingut</span>}</p>
                {activity.attachment?.data && (
                  <button className="activity-file" type="button" onClick={() => openCardPreview(activity.attachment)} title="Previsualitza abans de baixar-lo">
                    <Icon name="eye" /> <span>{activity.attachment.name}</span>
                  </button>
                )}
                {tagsOf(activity).length > 0 && (
                  <div className="tag-chips activity-card-tags">
                    {tagsOf(activity).map((tag) => <span className="tag-chip static" key={tag}>{tag}</span>)}
                  </div>
                )}
                <div className="activity-actions">
                  {activity.status === 'pending' ? (
                    <button className="button button-small" type="button" disabled={busy} onClick={() => validate(activity)}><Icon name="check" /> Afegeix al banc</button>
                  ) : (
                    <button className="button button-soft button-small" type="button" disabled={busy} onClick={() => duplicate(activity)}><Icon name="copy" /> Duplica</button>
                  )}
                  <button className="button button-soft button-small" type="button" onClick={() => setEditing(activity)}><Icon name="edit" /> Edita</button>
                  <button className="button button-soft button-small danger-text" type="button" disabled={busy} onClick={() => remove(activity)}><Icon name="trash" /> Esborra</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty"><span className="empty-icon">♧</span><strong>{activities.length ? 'No hi ha resultats' : 'Encara no hi ha activitats'}</strong><p className="muted">{activities.length ? 'Prova un altre cercador o treu alguna etiqueta.' : 'Prem «Nova activitat» per desar la primera.'}</p></div>
      )}

      {cardPreview && <DocumentPreview preview={cardPreview} onClose={closeCardPreview} />}
    </div>
  );
}

function ClassesView({
  classes, students, schoolYear,
  onCreateGroup, onRenameGroup, onDeleteGroup, onChangeColor,
  onInviteStudent, onRemoveStudent, onRegenerateInvite, onResetPassword,
}) {
  const [selectedId, setSelectedId] = useState(classes[0]?.id || '');
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState('ESO');
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkSummary, setBulkSummary] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const selected = classes.find((item) => item.id === selectedId) || classes[0] || null;
  const groupStudents = selected ? students.filter((item) => (item.classIds || []).includes(selected.id)) : [];

  useEffect(() => {
    if (!classes.some((item) => item.id === selectedId)) setSelectedId(classes[0]?.id || '');
  }, [classes, selectedId]);

  useEffect(() => {
    setRenameValue(selected?.name || '');
    setRenaming(false);
    setResult(null);
    setError('');
  }, [selected?.id]);

  async function run(action, onSuccess) {
    setError('');
    setBusy(true);
    try {
      const value = await action();
      if (onSuccess) onSuccess(value);
    } catch (failure) {
      setError(failure.message || 'No s’ha pogut fer l’operació.');
    } finally {
      setBusy(false);
    }
  }

  function submitGroup(event) {
    event.preventDefault();
    run(
      () => onCreateGroup(newName.trim(), newLevel),
      (id) => { setNewName(''); setSelectedId(id); setResult(null); },
    );
  }

  function saveRename() {
    if (!selected || !renaming) return;
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === selected.name) return;
    run(() => onRenameGroup(selected.id, name), () => setResult(null));
  }

  function cancelRename() {
    setRenaming(false);
    setRenameValue(selected?.name || '');
  }

  function submitInvite(event) {
    event.preventDefault();
    if (!selected) return;
    run(
      () => onInviteStudent(selected.id, studentName.trim(), studentEmail.trim()),
      (value) => {
        const code = typeof value === 'string' ? value : value.code;
        const emailed = typeof value === 'string' ? false : value.emailed;
        setStudentName(''); setStudentEmail(''); setResult({ code, email: studentEmail.trim(), emailed });
      },
    );
  }

  async function importStudents() {
    if (!selected) return;
    const rows = parseStudentRows(bulkText);
    if (!rows.length) {
      setBulkSummary('No s’han trobat files vàlides. Posa una fila per alumne amb el nom i el correu.');
      return;
    }
    setBulkBusy(true);
    setBulkSummary('');
    let ok = 0;
    let emailed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const value = await onInviteStudent(selected.id, row.name, row.email);
        if (typeof value === 'object' && value.emailed) emailed += 1;
        ok += 1;
      } catch (failure) {
        console.error('No s’ha pogut convidar:', row.email, failure);
        failed += 1;
      }
    }
    setBulkSummary(`S’han convidat ${ok} ${ok === 1 ? 'alumne' : 'alumnes'} (${emailed} ${emailed === 1 ? 'correu enviat' : 'correus enviats'} automàticament)${failed ? ` · ${failed} no s’han pogut convidar` : ''}.`);
    if (ok) setBulkText('');
    setBulkBusy(false);
  }

  const mailto = result
    ? `mailto:${encodeURIComponent(result.email)}?subject=${encodeURIComponent(`Invitació a ${selected?.name || 'Matemàtiques'}`)}&body=${encodeURIComponent(`Hola,\n\nT'invito a la classe ${selected?.name || ''} d'Aula dia a dia. Obre aquest enllaç i crea el teu compte triant la contrasenya:\n\n${inviteLink(result.code)}\n\nSi tens qualsevol problema, escriu-me.`)}`
    : '';

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <span className="section-kicker">Gestió de classes</span>
          <h2 className="section-title">Classes del curs {schoolYear}</h2>
        </div>
        <span className="badge blue">{classes.length} {classes.length === 1 ? 'grup' : 'grups'}</span>
      </div>

      {error && <div className="alert danger">{error}</div>}

      <div className="classes-layout">
        <aside className="card classes-list">
          <div className="card-body">
            <form className="inline-form" onSubmit={submitGroup}>
              <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Nom del grup nou" aria-label="Nom del grup nou" required />
              <select value={newLevel} onChange={(event) => setNewLevel(event.target.value)} aria-label="Nivell del grup nou">
                <option value="ESO">ESO</option>
                <option value="Batxillerat">Batxillerat</option>
                <option value="Primària">Primària</option>
              </select>
              <button className="button button-small" type="submit" disabled={busy}><Icon name="plus" /> Crea</button>
            </form>
            <div className="class-picker">
              {classes.map((group) => {
                const color = colorOf(group.color);
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={`class-picker-item${selected?.id === group.id ? ' active' : ''}`}
                    style={{ '--card-bg': color.bg, '--card-border': color.border, '--card-text': color.text }}
                    onClick={() => setSelectedId(group.id)}
                  >
                    <span className="group-mini-dot" style={{ background: color.border }} />
                    <span className="class-picker-name">{group.name}</span>
                    <small>{students.filter((item) => (item.classIds || []).includes(group.id)).length}</small>
                  </button>
                );
              })}
              {classes.length === 0 && <p className="muted text-sm">Crea el primer grup per començar.</p>}
            </div>
          </div>
        </aside>

        <section className="card classes-detail">
          {!selected ? (
            <div className="card-body"><p className="muted">No hi ha cap grup seleccionat.</p></div>
          ) : (
            <div className="card-body">
              <div className="spread class-detail-head">
                <div>
                  <span className="section-kicker">Grup seleccionat</span>
                  <h3 className="class-detail-title">
                    {renaming ? (
                      <input
                        className="class-title-input"
                        value={renameValue}
                        autoFocus
                        aria-label="Nom del grup"
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={saveRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') { event.preventDefault(); saveRename(); }
                          if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
                        }}
                      />
                    ) : (
                      <>
                        <span>{selected.name}</span>
                        <button
                          className="class-rename-button"
                          type="button"
                          title="Reanomena el grup"
                          aria-label="Reanomena el grup"
                          onClick={() => { setRenameValue(selected.name); setRenaming(true); }}
                        ><Icon name="edit" /></button>
                      </>
                    )}
                  </h3>
                  <p className="muted text-sm">{selected.subject || 'Matemàtiques'} · {selected.level || 'ESO'}</p>
                </div>
                <button
                  className="button button-soft button-small danger-text"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Vols esborrar ${selected.name}? També s'eliminarà del seu horari.`)) {
                      run(() => onDeleteGroup(selected.id), () => setSelectedId(''));
                    }
                  }}
                >
                  <Icon name="trash" /> Esborra
                </button>
              </div>

              <div className="color-row">
                <span className="section-kicker">Color del grup</span>
                <div className="color-swatches" role="group" aria-label={`Colors de ${selected.name}`}>
                  {GROUP_COLORS.map((palette) => (
                    <button
                      key={palette.key}
                      type="button"
                      className={`class-swatch${selected.color === palette.key ? ' selected' : ''}`}
                      style={{ '--swatch': palette.border }}
                      title={palette.label}
                      aria-label={palette.label}
                      aria-pressed={selected.color === palette.key}
                      disabled={busy}
                      onClick={() => run(() => onChangeColor(selected.id, palette.key))}
                    />
                  ))}
                </div>
              </div>

              <div className="students-block">
                <div className="spread">
                  <div>
                    <span className="section-kicker">Alumnes</span>
                    <h4>{groupStudents.length} {groupStudents.length === 1 ? 'alumne' : 'alumnes'}</h4>
                  </div>
                  <span className="muted text-sm">El codi d'invitació és únic per alumne.</span>
                </div>

                <form className="invite-form" onSubmit={submitInvite}>
                  <input value={studentName} onChange={(event) => setStudentName(event.target.value)} placeholder="Nom de l'alumne" aria-label="Nom de l'alumne" required />
                  <input type="email" value={studentEmail} onChange={(event) => setStudentEmail(event.target.value)} placeholder="Correu de l'alumne" aria-label="Correu de l'alumne" required />
                  <button className="button button-small" type="submit" disabled={busy}><Icon name="mail" /> Invita</button>
                </form>

                <details className="bulk-import">
                  <summary>Importa una llista des de l'Excel / CSV</summary>
                  <p className="muted text-sm">Pega les files de l'Excel (nom i correu) o puja un fitxer <code>.csv</code>. S'inviten tots els alumnes del grup seleccionat. Màxim 50 per vegada.</p>
                  <div className="bulk-file">
                    <label className="button button-soft button-small" htmlFor="bulk-file">Tria un fitxer CSV</label>
                    <input
                      id="bulk-file"
                      type="file"
                      accept=".csv,.tsv,.txt,text/csv,text/plain"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (file) setBulkText(await file.text());
                      }}
                    />
                  </div>
                  <textarea
                    value={bulkText}
                    onChange={(event) => setBulkText(event.target.value)}
                    rows="5"
                    placeholder={'Pau Solé\tpau@escola.cat\nAnna Puig\tanna@escola.cat'}
                    aria-label="Llista d'alumnes (nom i correu)"
                  />
                  <button className="button button-small" type="button" disabled={bulkBusy || !selected} onClick={importStudents}>
                    {bulkBusy ? 'Important…' : `Convida ${parseStudentRows(bulkText).length || ''} alumnes`}
                  </button>
                  {bulkSummary && <div className="alert info">{bulkSummary}</div>}
                </details>

                {result && (
                  <div className="invite-result">
                    <strong>Invitació creada per a {result.email}</strong>
                    {!result.emailed && <div className="alert danger">No s’ha pogut enviar el correu automàtic. Pots fer servir el botó «Obre el correu» o enviar l’enllaç tu mateix.</div>}
                    <p className="muted text-sm">{result.emailed
                      ? 'Hem enviat un correu a l’alumne perquè triï la seva contrasenya. També pots copiar l’enllaç o reenviar-lo des del teu correu.'
                      : 'L’alumne obre l’enllaç i tria la seva contrasenya. Tu pots reenviar l’enllaç o restablir la contrasenya quan ho necessiti.'}</p>
                    <div className="invite-link"><Icon name="link" /><code>{inviteLink(result.code)}</code></div>
                    <div className="section-actions">
                      <button className="button button-soft button-small" type="button" onClick={() => navigator.clipboard?.writeText(inviteLink(result.code))}><Icon name="link" /> Copia l'enllaç</button>
                      <a className="button button-soft button-small" href={mailto}><Icon name="mail" /> Obre el correu</a>
                    </div>
                  </div>
                )}

                <div className="student-list">
                  {groupStudents.map((student) => (
                    <div className="student-row" key={student.id}>
                      <div className="student-identity">
                        <span className={`status-dot ${student.status === 'active' ? 'active' : 'pending'}`} />
                        <div>
                          <strong>{student.name}</strong>
                          <small>{student.email}</small>
                        </div>
                      </div>
                      <span className={`badge ${student.status === 'active' ? 'green' : 'amber'}`}>{student.status === 'active' ? 'Actiu' : 'Pendents'}</span>
                      <div className="student-actions">
                        <button
                          className="icon-button"
                          type="button"
                          title="Copia l'enllaç d'invitació"
                          aria-label={`Copia l'enllaç d'invitació de ${student.name}`}
                          onClick={() => navigator.clipboard?.writeText(inviteLink(student.inviteCode))}
                        ><Icon name="link" /></button>
                        <button
                          className="icon-button"
                          type="button"
                          title="Genera un altre codi"
                          aria-label={`Genera un altre codi per a ${student.name}`}
                          onClick={() => run(() => onRegenerateInvite(student.id), (code) => setResult({ code, email: student.email }))}
                        ><Icon name="refresh" /></button>
                        <button
                          className="icon-button"
                          type="button"
                          title="Envia restabliment de contrasenya"
                          aria-label={`Envia restabliment de contrasenya a ${student.name}`}
                          onClick={() => run(() => onResetPassword(student.email), () => setResult(null))}
                        ><Icon name="key" /></button>
                        <button
                          className="icon-button danger-text"
                          type="button"
                          title="Treu del grup"
                          aria-label={`Treu ${student.name} del grup`}
                          onClick={() => {
                            if (window.confirm(`Vols treure ${student.name} de ${selected.name}?`)) run(() => onRemoveStudent(student.id, selected.id));
                          }}
                        ><Icon name="trash" /></button>
                      </div>
                    </div>
                  ))}
                  {groupStudents.length === 0 && <p className="muted text-sm">Encara no hi ha alumnes en aquest grup.</p>}
                </div>
                <p className="fine-print">Per seguretat la contrasenya no es desa en clar. L'alumne la tria en acceptar la invitació; si l'oblida, fes servir la clau per enviar-li un restabliment.</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StudentHome({ profile, group, sessions, activities, onLogout }) {
  const [preview, setPreview] = useState(null);
  const previewUrlRef = useRef(null);
  const color = colorOf(group?.color);
  const today = toISODate(new Date());
  const activityById = new Map(activities.map((item) => [item.id, item]));

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const assigned = new Map();
  for (const session of sessions) {
    for (const item of session.items || []) {
      const key = item.activityId || item.id;
      const current = assigned.get(key);
      if (!current || (item.dueDate || session.date) < (current.dueDate || current.session.date)) {
        assigned.set(key, { ...item, session });
      }
    }
  }
  const pending = [...assigned.values()]
    .filter((item) => (item.dueDate || item.session.date) >= today)
    .sort((a, b) => (a.dueDate || a.session.date).localeCompare(b.dueDate || b.session.date));

  function closePreview() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null);
  }

  function openDocument(activity) {
    if (!activity?.attachment?.data) return;
    closePreview();
    const url = base64ToBlobUrl(activity.attachment.data, activity.attachment.mime);
    previewUrlRef.current = url;
    setPreview({ name: activity.attachment.name, url });
  }

  return (
    <div className="layout layout-full">
      <div className="workspace">
        <header className="topbar">
          <Brand />
          <div className="topbar-title">
            <h1>La teva classe</h1>
            <p className="subtitle">Curs {profile.schoolYear}</p>
          </div>
          <div className="topbar-right"><LogoutButton onClick={onLogout} /></div>
        </header>
        <main className="content">
          <div className="stack">
            <section className="card student-class-card" style={{ borderLeftColor: color.border }}>
              <div className="card-body">
                <span className="section-kicker">Hola, {profile.name.split(' ')[0]}</span>
                <h2 className="section-title">{group?.name || 'Encara sense classe'}</h2>
                <p className="muted mb-0">
                  {group
                    ? `${group.subject || 'Matemàtiques'}${group.level ? ` · ${group.level}` : ''} · Curs ${profile.schoolYear}`
                    : 'Encara no t’han assignat a cap grup. Si el professor t’ha enviat una invitació, obre l’enllaç del correu o demana-li un de nou.'}
                </p>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <span className="section-kicker">Feina per fer</span>
                  <h2 className="section-title">Activitats pendents</h2>
                </div>
                <span className="badge blue">{pending.length} {pending.length === 1 ? 'activitat' : 'activitats'}</span>
              </div>
              <div className="card-body">
                {pending.length === 0 ? (
                  <div className="empty">
                    <span className="empty-icon">✓</span>
                    <strong>No hi ha activitats pendents</strong>
                    <span>Quan el professor afegeixi activitats a les sessions del teu grup, apareixeran aquí.</span>
                  </div>
                ) : (
                  <div className="student-pending-list">
                    {pending.map((item) => {
                      const due = item.dueDate || item.session.date;
                      const date = fromISODate(due);
                      const activity = activityById.get(item.activityId);
                      return (
                        <article className="student-pending-item" key={item.id}>
                          <div className="student-pending-date">
                            <strong>{date.getDate()}</strong>
                            <span>{new Intl.DateTimeFormat('ca', { month: 'short' }).format(date).replace('.', '')}</span>
                          </div>
                          <div className="student-pending-main">
                            <div className="spread">
                              <h3>{item.title || item.activityTitle || 'Activitat'}</h3>
                              {item.dueDate && <span className="badge amber">Data límit: {formatDateShort(item.dueDate)}</span>}
                            </div>
                            {item.content && <p className="muted">{item.content}</p>}
                            {item.instructions && <p className="fine-print"><strong>Instruccions:</strong> {item.instructions}</p>}
                            <p className="student-pending-meta">
                              Sessió del {formatDateShort(item.session.date)} · {item.session.start}–{item.session.end}
                              {item.dueDate ? '' : ' · sense data límit'}
                            </p>
                            {activity?.attachment && (
                              <button className="activity-file" type="button" onClick={() => openDocument(activity)}>
                                <Icon name="eye" /> {activity.attachment.name}
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        </main>
      </div>
      {preview && (
        <div className="doc-preview-overlay" role="presentation" onClick={closePreview}>
          <div className="doc-preview-modal" role="dialog" aria-modal="true" aria-label={preview.name} onClick={(event) => event.stopPropagation()}>
            <div className="doc-preview-head">
              <div><span className="section-kicker">Document de l’activitat</span><strong>{preview.name}</strong></div>
              <div className="row">
                <a className="button button-soft button-small" href={preview.url} download={preview.name}><Icon name="download" /> Baixa’l</a>
                <button className="icon-button" type="button" onClick={closePreview} aria-label="Tanca"><Icon name="close" /></button>
              </div>
            </div>
            <iframe className="doc-preview-frame" src={preview.url} title={preview.name} />
            <p className="fine-print">El document es mostra al navegador des del teu dispositiu. Baixa’l només si el vols guardar.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tauler del grup: resum del dia, alumnes, feina pendent i estat del banc. */
function GroupHome({ group, students, sessions, activities, timetable, slots, holidays, onOpenSession, onNavigate }) {
  const [preview, setPreview] = useState(null);
  const previewUrlRef = useRef(null);
  const today = toISODate(new Date());

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  function closePreview() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
  }

  function openPreview(attachment) {
    if (!attachment?.data) return;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = base64ToBlobUrl(attachment.data, attachment.mime);
    previewUrlRef.current = url;
    setPreview({ url, name: attachment.name, mime: attachment.mime || 'application/pdf' });
  }

  const groupSessions = sessions.filter((item) => item.classId === group.id);
  const groupStudents = students.filter((item) => (item.classIds || []).includes(group.id));
  const activityById = new Map(activities.map((item) => [item.id, item]));
  const todays = groupSessions.filter((item) => item.date === today).sort((a, b) => a.slotIndex - b.slotIndex);
  const next = groupSessions
    .filter((item) => item.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.slotIndex - b.slotIndex)[0];
  const focus = todays[0] || null;
  const schoolDay = (new Date().getDay() + 6) % 7 + 1;
  const holidayToday = holidays.includes(today);
  const classToday = !holidayToday && timetable.some((entry) => entry.kind === 'class' && entry.classId === group.id && entry.day === schoolDay);
  const focusTitle = focus
    ? `${DAYS[focus.day - 1]} ${formatDateShort(focus.date)}`
    : holidayToday ? 'Avui és festa' : classToday ? 'Avui tens classe' : 'Avui no hi ha classe';
  const weekStart = mondayOf(today);
  const weekEnd = addDays(weekStart, 6);
  const weekCount = groupSessions.filter((item) => item.date >= weekStart && item.date <= weekEnd).length;
  const bankPending = activities.filter((item) => item.status === 'pending');
  const pendingItems = groupSessions
    .flatMap((session) => (session.items || []).map((item) => ({ ...item, session })))
    .filter((item) => item.session.status !== 'done')
    .sort((a, b) => (a.dueDate || a.session.date).localeCompare(b.dueDate || b.session.date));
  const todayLabel = new Intl.DateTimeFormat('ca', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  function slotOf(session) {
    return slots[session.slotIndex] || DEFAULT_SLOTS[session.slotIndex] || DEFAULT_SLOTS[0];
  }

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <span className="section-kicker">Inici del grup</span>
          <h2 className="section-title">Resum de {group.name}</h2>
          <p className="muted mb-0">{todayLabel.charAt(0).toUpperCase() + todayLabel.slice(1)}</p>
        </div>
        <span className="badge blue">{groupStudents.length} {groupStudents.length === 1 ? 'alumne' : 'alumnes'}</span>
      </div>

      <div className="home-grid">
        <section className="card home-focus">
          <div className="card-header">
            <div>
              <span className="section-kicker">Sessió d’avui</span>
              <h3 className="card-title">{focusTitle}</h3>
            </div>
            {focus && sessionPrepared(focus, activities) && (
              focus.status === 'done'
                ? <span className="badge green"><Icon name="check" /> Feta</span>
                : <span className="badge navy"><Icon name="flag" /> Preparada</span>
            )}
          </div>
          <div className="card-body">
            {focus ? (
              <>
                <strong className="home-focus-time">{slotOf(focus).start}–{slotOf(focus).end}</strong>
                <p className="muted">{focus.theory?.trim() || 'Encara sense explicació. Obre la sessió per preparar-la.'}</p>
                <p className="fine-print">
                  {(focus.items || []).length
                    ? `${focus.items.length} ${focus.items.length === 1 ? 'activitat' : 'activitats'}: ${focus.items.map((item) => item.title).filter(Boolean).join(' · ')}`
                    : 'Sense activitats encara.'}
                </p>
                {todays.length > 1 && <p className="fine-print">Avui tens {todays.length} sessions d’aquest grup.</p>}
                <div className="section-actions">
                  <button className="button button-small" type="button" onClick={() => onOpenSession(group.id, focus.date, focus.slotIndex, 'home')}>
                    <Icon name="calendar" /> Obre la sessió
                  </button>
                  <button className="button button-soft button-small" type="button" onClick={() => onNavigate('sessions')}>Ves a Sessions</button>
                </div>
              </>
            ) : (
              <div className="empty">
                <span className="empty-icon">☕</span>
                <strong>{holidayToday ? 'Avui és festa' : classToday ? 'Avui tens classe, però encara no hi ha sessió' : 'Avui no hi ha classe'}</strong>
                <p className="muted">
                  {holidayToday
                    ? 'No hi ha cap sessió per a aquest grup perquè avui és dia de festa.'
                    : classToday
                      ? `Encara no s’ha generat la sessió de ${group.name} per avui. Pots fer-ho des de Sessions.`
                      : `No hi ha cap franja de ${group.name} a l’horari per avui.`}
                </p>
                {next && (
                  <p className="fine-print">Propera sessió: {DAYS[next.day - 1]} {formatDateShort(next.date)} · {slotOf(next).start}–{slotOf(next).end}</p>
                )}
                <div className="section-actions">
                  {next && (
                    <button className="button button-small" type="button" onClick={() => onOpenSession(group.id, next.date, next.slotIndex, 'home')}>
                      <Icon name="calendar" /> Obre la propera sessió
                    </button>
                  )}
                  <button className="button button-soft button-small" type="button" onClick={() => onNavigate('sessions')}>Ves a Sessions</button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <span className="section-kicker">Grup</span>
              <h3 className="card-title">Alumnes</h3>
            </div>
            <span className="badge">{groupStudents.length}</span>
          </div>
          <div className="card-body">
            {groupStudents.length ? (
              <>
                <div className="home-student-list">
                  {groupStudents.slice(0, 6).map((student) => (
                    <div className="home-student" key={student.id}>
                      <span className="home-avatar">{(student.name || '?').charAt(0).toUpperCase()}</span>
                      <div>
                        <strong>{student.name || student.email}</strong>
                        <small>{student.email}{student.status === 'pending' ? ' · invitació pendent' : ''}</small>
                      </div>
                    </div>
                  ))}
                </div>
                {groupStudents.length > 6 && <p className="fine-print">I {groupStudents.length - 6} alumnes més.</p>}
              </>
            ) : (
              <p className="muted text-sm">Encara no hi ha alumnes assignats a aquest grup.</p>
            )}
            <p className="fine-print">Els alumnes es gestionen a Principal → Classes.</p>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <span className="section-kicker">Feina de la classe</span>
              <h3 className="card-title">Activitats pendents</h3>
            </div>
            <span className="badge amber">{pendingItems.length}</span>
          </div>
          <div className="card-body">
            {pendingItems.length ? (
              <div className="home-pending-list">
                {pendingItems.slice(0, 5).map((item) => {
                  const bank = activityById.get(item.activityId);
                  const slot = slotOf(item.session);
                  return (
                    <article className="home-pending-item" key={item.id || item.activityId}>
                      <div className="spread">
                        <strong>{item.title || item.activityTitle || 'Activitat'}</strong>
                        {item.dueDate && <span className="badge amber">{formatDateShort(item.dueDate)}</span>}
                      </div>
                      <p className="fine-print">Sessió del {formatDateShort(item.session.date)} · {slot.start}–{slot.end}</p>
                      {item.content && <p className="muted text-sm">{item.content}</p>}
                      {bank?.attachment && (
                        <button className="activity-preview-file" type="button" onClick={() => openPreview(bank.attachment)}>
                          <Icon name="eye" /> {bank.attachment.name}
                        </button>
                      )}
                    </article>
                  );
                })}
                {pendingItems.length > 5 && <p className="fine-print">I {pendingItems.length - 5} activitats més.</p>}
              </div>
            ) : (
              <p className="muted text-sm">No hi ha activitats pendents a les sessions d’aquest grup.</p>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <span className="section-kicker">Estat del curs</span>
              <h3 className="card-title">Planificació i banc</h3>
            </div>
          </div>
          <div className="card-body">
            <div className="home-stat-row">
              <div className="home-stat"><strong>{weekCount}</strong><span>sessions d’aquest grup aquesta setmana</span></div>
              <div className="home-stat"><strong>{bankPending.length}</strong><span>pendents de validar al banc</span></div>
            </div>
            <p className="fine-print">Les activitats noves de les sessions queden pendents al banc fins que les validis o les descartis.</p>
            <div className="section-actions">
              <button className="button button-soft button-small" type="button" onClick={() => onNavigate('sessions')}>Obre Sessions</button>
            </div>
          </div>
        </section>
      </div>
      {preview && <DocumentPreview preview={preview} onClose={closePreview} />}
    </div>
  );
}

function GroupLayout({
  activeClass, notice, section, onNavigate, onExit, onLogout,
  sessions, activities, students, timetable, slots, schoolYear, weekMonday, holidays, onWeekChange,
  sessionFor, onOpenSession, onCreateWeek, onOpenRange, rangeModal, onSaveSession, onAddActivity, onCreateActivity,
  selectedSession, onCloseSession, onNavigateSession, sessionNav,
}) {
  const current = NAV_ITEMS.find((item) => item.key === section) || NAV_ITEMS[0];
  const color = colorOf(activeClass?.color);
  const groupNameStyle = { color: color.text };
  const compact = useCompactLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const session = selectedSession
    ? sessions.find((item) => item.id === selectedSession.id) || selectedSession
    : null;
  const previousSessions = session
    ? sessions
        .filter((item) => item.classId === activeClass.id
          && (item.date < session.date || (item.date === session.date && item.slotIndex < session.slotIndex)))
        .sort((a, b) => b.date.localeCompare(a.date) || b.slotIndex - a.slotIndex)
        .slice(0, 12)
        .map((item) => {
          const slotInfo = slots[item.slotIndex] || DEFAULT_SLOTS[item.slotIndex] || DEFAULT_SLOTS[0];
          return {
            key: item.id,
            label: `${DAYS[item.day - 1] || ''} ${formatDateShort(item.date)} · ${slotInfo.start}–${slotInfo.end}`,
          };
        })
    : [];

  useEffect(() => {
    if (!compact || !drawerOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => { if (event.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [compact, drawerOpen]);

  function toggleMenu() {
    setDrawerOpen((open) => !open);
  }

  function closeDrawer() {
    if (compact) setDrawerOpen(false);
  }

  return (
    <div className={`layout group-layout${compact && drawerOpen ? ' menu-open' : ''}`}>
      {compact && drawerOpen && (
        <button className="nav-scrim" type="button" aria-label="Tanca el menú" onClick={closeDrawer} />
      )}
      <aside className="sidebar" id="group-sidebar">
        <div className="sidebar-head">
          <Brand light />
        </div>
        <nav className="side-nav" aria-label="Menú del grup">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-link${section === item.key && !session ? ' active' : ''}`}
              onClick={() => { closeDrawer(); onCloseSession(); onNavigate(item.key); }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <p className="sidebar-version">Llibreta dia a dia · v0.1 · {isLocalDemo ? 'prova local' : 'Firebase'}</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          {compact && (
            <button
              className={`icon-button menu-button${drawerOpen ? ' is-open' : ''}`}
              type="button"
              onClick={toggleMenu}
              title={drawerOpen ? 'Tanca el menú' : 'Obre el menú'}
              aria-label={drawerOpen ? 'Tanca el menú' : 'Obre el menú'}
              aria-controls="group-sidebar"
              aria-expanded={drawerOpen}
            >
              <Icon name="menu" />
            </button>
          )}
          <button className="icon-button back-button" type="button" onClick={session ? onCloseSession : onExit} title="Torna" aria-label="Torna">
            <Icon name="back" />
          </button>
          <div className="topbar-title">
            <div className="group-heading">
              <h1 className="topbar-class" style={groupNameStyle}>
                <span className="topbar-class-dot" style={{ background: color.border }} />
                {activeClass?.name || 'Classe'}
              </h1>
              <span className="group-page">{current.label}</span>
            </div>
          </div>
          <div className="topbar-right"><LogoutButton onClick={onLogout} /></div>
        </header>
        <main className="content">
          {notice && <div className="alert success">{notice}</div>}
          {section === 'taulell' && activeClass && (
            <GroupHome
              group={activeClass}
              students={students}
              sessions={sessions}
              activities={activities}
              timetable={timetable}
              slots={slots}
              holidays={holidays}
              onOpenSession={onOpenSession}
              onNavigate={onNavigate}
            />
          )}
          {section === 'sessions' && activeClass && (
            <SessionsView
              group={activeClass}
              sessions={sessions.filter((item) => item.classId === activeClass.id)}
              activities={activities}
              timetable={timetable}
              slots={slots}
              schoolYear={schoolYear}
              weekMonday={weekMonday}
              holidays={holidays}
              onWeekChange={onWeekChange}
              onOpenSession={onOpenSession}
              onCreateWeek={onCreateWeek}
              onOpenRange={onOpenRange}
            />
          )}
          {section === 'activities' && <SectionPlaceholder icon="layers" title="Activitats" description="La biblioteca d'activitats es desarà a Firestore a la propera fase." />}
          {section === 'submissions' && <SectionPlaceholder icon="check" title="Lliuraments" description="Els lliuraments i fitxers arribaran amb la fase de Storage." />}
        </main>
      </div>
      {session && (
        <SessionModal
          session={session}
          group={activeClass}
          activities={activities}
          previousSessions={previousSessions}
          slots={slots}
          onClose={onCloseSession}
          onSave={onSaveSession}
          onAddActivity={onAddActivity}
          onCreateActivity={onCreateActivity}
          onNavigate={onNavigateSession}
          canPrev={sessionNav?.canPrev}
          canNext={sessionNav?.canNext}
        />
      )}
      {rangeModal}
    </div>
  );
}

function GlobalPage({
  section, classes, students, timetable, slots, schoolYear, notice, holidays, holidayRanges,
  onAddHolidayRange, onRemoveHolidayRange,
  years, onSelectYear, onCreateYear,
  onBack, onLogout, onChangeCell, editingHorari, onToggleEditHorari, onChangeSlot,
  onCreateGroup, onRenameGroup, onDeleteGroup, onChangeColor,
  onInviteStudent, onRemoveStudent, onRegenerateInvite, onResetPassword,
  activities, onSaveActivity, onDeleteActivity, onDuplicateActivity, onValidateActivity,
  sessionFor, weekMonday, onWeekChange, onOpenSession, onCreateWeek, onOpenRange, rangeModal,
  selectedSession, sessions, onSaveSession, onAddActivity, onCreateActivity,
  onCloseSession, onNavigateSession, sessionNav,
}) {
  const openSession = selectedSession
    ? sessions.find((item) => item.id === selectedSession.id) || selectedSession
    : null;
  const openGroup = openSession ? classes.find((item) => item.id === openSession.classId) : null;
  const previousSessions = openSession
    ? sessions
        .filter((item) => item.classId === openSession.classId
          && (item.date < openSession.date || (item.date === openSession.date && item.slotIndex < openSession.slotIndex)))
        .sort((a, b) => b.date.localeCompare(a.date) || b.slotIndex - a.slotIndex)
        .slice(0, 12)
        .map((item) => {
          const slot = slots[item.slotIndex] || DEFAULT_SLOTS[item.slotIndex] || DEFAULT_SLOTS[0];
          return {
            key: item.id,
            label: `${DAYS[item.day - 1] || ''} ${formatDateShort(item.date)} · ${slot.start}–${slot.end}`,
          };
        })
    : [];

  return (
    <div className="layout layout-full">
      <div className="workspace">
        <header className="topbar">
          <button className="icon-button back-button" type="button" onClick={onBack} title="Tornar a la principal" aria-label="Tornar a la principal">
            <Icon name="back" />
          </button>
          <div className="topbar-title">
            <h1>{section === 'horari' ? 'Horari' : section === 'activitats' ? 'Banc d’activitats' : 'Classes'}</h1>
            <p className="subtitle">{section === 'activitats' ? 'Repositori personal · sense cursos ni dates' : `Curs ${schoolYear}`}</p>
          </div>
          <div className="topbar-right"><LogoutButton onClick={onLogout} /></div>
        </header>
        <main className="content">
          {notice && <div className="alert success">{notice}</div>}
          {section === 'horari'
            ? <HorariView
                classes={classes}
                entries={timetable}
                slots={slots}
                schoolYear={schoolYear}
                holidays={holidays}
                holidayRanges={holidayRanges}
                onAddHolidayRange={onAddHolidayRange}
                onRemoveHolidayRange={onRemoveHolidayRange}
                editing={editingHorari}
                onToggleEdit={onToggleEditHorari}
                onChangeCell={onChangeCell}
                onChangeSlot={onChangeSlot}
                years={years}
                onSelectYear={onSelectYear}
                onCreateYear={onCreateYear}
                activities={activities}
                sessionFor={sessionFor}
                weekMonday={weekMonday}
                onWeekChange={onWeekChange}
                onOpenSession={onOpenSession}
                onCreateWeek={onCreateWeek}
                onOpenRange={onOpenRange}
              />
            : section === 'activitats'
              ? <ActivitiesView
                  activities={activities}
                  onSave={onSaveActivity}
                  onDelete={onDeleteActivity}
                  onDuplicate={onDuplicateActivity}
                  onValidate={onValidateActivity}
                />
              : <ClassesView
                classes={classes}
                students={students}
                schoolYear={schoolYear}
                onCreateGroup={onCreateGroup}
                onRenameGroup={onRenameGroup}
                onDeleteGroup={onDeleteGroup}
                onChangeColor={onChangeColor}
                onInviteStudent={onInviteStudent}
                onRemoveStudent={onRemoveStudent}
                onRegenerateInvite={onRegenerateInvite}
                onResetPassword={onResetPassword}
              />}
        </main>
      </div>
      {openSession && openGroup && (
        <SessionModal
          session={openSession}
          group={openGroup}
          activities={activities}
          previousSessions={previousSessions}
          slots={slots}
          onClose={onCloseSession}
          onSave={onSaveSession}
          onAddActivity={onAddActivity}
          onCreateActivity={onCreateActivity}
          onNavigate={onNavigateSession}
          canPrev={sessionNav?.canPrev}
          canNext={sessionNav?.canNext}
        />
      )}
      {rangeModal}
    </div>
  );
}

function InviteAccept({ code, onDone }) {
  const [invite, setInvite] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsReset, setNeedsReset] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => onAuthStateChanged(auth, setCurrentUser), []);

  async function claimWithCurrentAccount() {
    if (!currentUser || !invite) return;
    setBusy(true);
    setError('');
    try {
      await updateDoc(doc(db, 'invites', code), { uid: currentUser.uid, status: 'active' });
      await updateDoc(doc(db, 'students', invite.studentId), { uid: currentUser.uid, status: 'active' });
      await updateDoc(doc(db, 'users', currentUser.uid), { activeClassId: invite.classId });
      window.history.replaceState({}, '', window.location.pathname);
      window.location.reload();
    } catch (failure) {
      setError(failure.code ? authMessage(failure.code) : (failure.message || 'No s’ha pogut acceptar la invitació.'));
      setBusy(false);
    }
  }

  useEffect(() => {
    async function loadInvite() {
      try {
        const data = isLocalDemo ? localGetInvite(code) : (await getDoc(doc(db, 'invites', code))).data();
        if (!data) throw new Error('Aquesta invitació no existeix.');
        if (data.status === 'active') throw new Error('Aquesta invitació ja s’ha fet servir. Contacta amb el professor.');
        setInvite(data);
        setName(data.name || '');
        setEmail(data.email || '');
      } catch (failure) {
        setError(failure.message || 'No s’ha pogut carregar la invitació.');
      }
    }
    loadInvite();
  }, [code]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Les contrasenyes no coincideixen.');
      return;
    }
    setBusy(true);
    try {
      if (isLocalDemo) {
        localAcceptInvite(code, name.trim());
      } else {
        const normalizedEmail = email.trim().toLowerCase();
        const credential = await createUserWithEmailAndPassword(auth, normalizedEmail, password);
        const uid = credential.user.uid;
        await setDoc(doc(db, 'users', uid), {
          name: name.trim(),
          email: normalizedEmail,
          role: 'student',
          activeClassId: invite.classId,
          schoolYear: invite.schoolYear,
          teacherId: invite.teacherId,
        });
        await updateDoc(doc(db, 'invites', code), { status: 'active', uid });
        await updateDoc(doc(db, 'students', invite.studentId), { status: 'active', uid });
      }
      onDone();
    } catch (failure) {
      if (failure.code === 'auth/email-already-in-use') {
        setNeedsReset(true);
        setError('El teu compte ja està creat (el professor el va generar en convidar-te). Només et falta triar la contrasenya: prem el botó de sota i rebràs un correu per fer-ho. Després entra amb el teu correu i contrasenya i quedaràs assignat al grup automàticament.');
      } else {
        setError(failure.code ? authMessage(failure.code) : (failure.message || 'No s’ha pogut crear el compte.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-body">
      <div className="auth-shell">
        <div className="auth-intro">
          <Brand light />
          <h2>T'han convidat a classe.</h2>
          <p>Tria la teva contrasenya per entrar a l'aula del professor.</p>
        </div>
        <div className="auth-panel">
          <h2>Crea el teu compte</h2>
          {invite && <p className="invite-class">{invite.className || 'Classe'} · Curs {invite.schoolYear}</p>}
          {error && <div className={`alert ${needsReset ? 'info' : 'danger'}`}>{error}</div>}
          {!error && invite && currentUser && (
            <div className="invite-claim">
              <p className="muted">Has iniciat sessió com <strong>{currentUser.email}</strong>. Pots acceptar la invitació directament amb aquest compte:</p>
              <button className="button block" type="button" disabled={busy} onClick={claimWithCurrentAccount}>
                {busy ? 'Acceptant…' : 'Accepta la invitació amb aquest compte'}
              </button>
              <p className="fine-print">O crea un compte nou amb un altre correu:</p>
            </div>
          )}
          {needsReset && (
            <>
              {resetSent ? (
                <div className="alert success">Correu enviat. Revisa la safata d'entrada (i el correu brossa), tria la contrasenya i després entra a l'app.</div>
              ) : (
                <button
                  className="button block"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await sendInviteEmail(email.trim().toLowerCase());
                      setResetSent(true);
                    } catch (failure) {
                      setError(failure.code ? authMessage(failure.code) : 'No s’ha pogut enviar el correu. Torna-ho a provar.');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Enviant…' : 'Envia’m l’enllaç per triar la contrasenya'}
                </button>
              )}
              <button className="button ghost block" type="button" onClick={onDone}>Ja tinc contrasenya · Entra</button>
            </>
          )}
          {!error && invite && (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="invite-name">Nom i cognoms</label>
                <input id="invite-name" value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="invite-email">Correu electrònic</label>
                <input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="invite-pass">Contrasenya</label>
                <input id="invite-pass" type="password" minLength="6" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="invite-confirm">Repeteix la contrasenya</label>
                <input id="invite-confirm" type="password" minLength="6" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
              </div>
              <button className="button block" type="submit" disabled={busy || !invite}>
                {busy ? 'Creant compte…' : 'Crear compte'}
              </button>
            </form>
          )}
          <div className="demo-note">Si el professor ha canviat el codi, demana-li l'enllaç nou.</div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState(null);
  const [classes, setClasses] = useState([]);
  const [timetable, setTimetable] = useState([]);
  const [years, setYears] = useState([SCHOOL_YEAR]);
  const [yearDocs, setYearDocs] = useState([]);
  const [students, setStudents] = useState([]);
  const [activities, setActivities] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [holidayRanges, setHolidayRanges] = useState([]);
  // Les dates individuals es deriven dels rangs: la generació segueix treballant amb dates.
  const holidays = expandDateRanges(holidayRanges);
  const [rangeModalOpen, setRangeModalOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState(null);
  const [weekMonday, setWeekMonday] = useState(() => mondayOf(toISODate(new Date())));
  const [editingHorari, setEditingHorari] = useState(false);
  const [inviteParam, setInviteParam] = useState(() => new URLSearchParams(window.location.search).get('invite') || '');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [seedStarted, setSeedStarted] = useState(false);
  const [section, setSection] = useState('taulell');
  const [globalView, setGlobalView] = useState(null);
  const seedingRef = useRef(false);
  const classListenerRef = useRef(null);
  const studentListenerRef = useRef(null);
  const inviteListenerRef = useRef(null);
  const activityListenerRef = useRef(null);
  const sessionListenerRef = useRef(null);

  function sessionFor(classId, date, slotIndex) {
    return sessions.find((item) => item.classId === classId && item.date === date && item.slotIndex === slotIndex) || null;
  }

  /** Franges reals d'un grup en un dia concret, segons l'horari. */
  function classSlotsOn(classId, iso, day) {
    const entries = yearTimetable.filter((entry) => entry.kind === 'class' && entry.classId === classId);
    return slots.map((slot, slotIndex) => {
      if (!entries.some((entry) => entry.day === day && slotIndexOf(entry, slots) === slotIndex)) return null;
      return { classId, date: iso, day, slotIndex, start: slot.start, end: slot.end };
    }).filter(Boolean);
  }

  /** Espais (data + franja) d'una setmana per a un grup, segons l'horari. */
  function weekSlotsOf(classId, monday) {
    return weekDates(monday).flatMap(({ iso, day }) => classSlotsOn(classId, iso, day));
  }

  /** Totes les franges d'un rang de dates, sense caps de setmana ni festes. */
  function rangeSlotTargets(classIds, start, end, holidayList = holidays) {
    const targets = [];
    let cursor = start;
    let guard = 0;
    while (cursor && end && cursor <= end && guard < 500) {
      const weekday = fromISODate(cursor).getDay();
      if (weekday >= 1 && weekday <= 5 && !holidayList.includes(cursor)) {
        for (const classId of classIds) targets.push(...classSlotsOn(classId, cursor, weekday));
      }
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    return targets;
  }

  function sessionNavFor(session) {
    if (!session) return { canPrev: false, canNext: false };
    const all = weekSlotsOf(session.classId, mondayOf(session.date));
    const index = all.findIndex((item) => item.date === session.date && item.slotIndex === session.slotIndex);
    return { canPrev: index > 0, canNext: index >= 0 && index < all.length - 1 };
  }

  async function ensureSession(classId, date, slotIndex) {
    const existing = sessionFor(classId, date, slotIndex);
    if (existing) return existing;
    const group = classes.find((item) => item.id === classId);
    const slot = slots[slotIndex] || DEFAULT_SLOTS[slotIndex] || DEFAULT_SLOTS[0];
    const data = {
      teacherId: profile.uid,
      schoolYear: profile.schoolYear,
      classId,
      date,
      day: fromISODate(date).getDay() || 7,
      slotIndex,
      start: slot.start,
      end: slot.end,
      title: group?.name || 'Sessió',
      status: 'planned',
      theory: '',
      diary: '',
      items: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const id = sessionIdKey(profile.uid, classId, date, slotIndex);
    const session = { id, ...data };
    if (!isLocalDemo) await setDoc(doc(db, 'sessions', id), data);
    setSessions((current) => current.some((item) => item.id === id) ? current : [...current, session]);
    return session;
  }

  async function openSession(classId, date, slotIndex) {
    const session = await ensureSession(classId, date, slotIndex);
    setSelectedSession(session);
    setWeekMonday(mondayOf(date));
  }

  async function navigateSession(delta) {
    if (!selectedSession) return;
    const all = weekSlotsOf(selectedSession.classId, mondayOf(selectedSession.date));
    const index = all.findIndex((item) => item.date === selectedSession.date && item.slotIndex === selectedSession.slotIndex);
    const next = all[index + delta];
    if (next) await openSession(selectedSession.classId, next.date, next.slotIndex);
  }

  async function saveSession(session) {
    if (isLocalDemo) throw new Error('Les sessions només estan disponibles amb Firebase.');
    const data = {
      teacherId: session.teacherId || profile.uid,
      schoolYear: session.schoolYear || profile.schoolYear,
      classId: session.classId,
      date: session.date,
      day: session.day,
      slotIndex: session.slotIndex,
      start: session.start,
      end: session.end,
      title: session.title,
      status: session.status || 'planned',
      theory: session.theory || '',
      diary: session.diary || '',
      followsKey: session.followsKey || '',
      followsLabel: session.followsLabel || '',
      items: session.items || [],
      updatedAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'sessions', session.id), data);
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, ...data } : item));
    setSelectedSession((current) => current?.id === session.id ? { ...current, ...data } : current);
    setNotice('Sessió desada.');
  }

  async function createWeekSessions(classIds) {
    if (isLocalDemo) throw new Error('Les sessions només estan disponibles amb Firebase.');
    const targets = classIds.flatMap((classId) => weekSlotsOf(classId, weekMonday))
      .filter((target) => !holidays.includes(target.date));
    for (const target of targets) await ensureSession(target.classId, target.date, target.slotIndex);
    setNotice(targets.length ? `S'han preparat ${targets.length} ${targets.length === 1 ? 'sessió buida' : 'sessions buides'}.` : 'No hi ha hores a la setmana.');
  }

  async function createRangeSessions(classIds, { start, end }) {
    if (isLocalDemo) throw new Error('Les sessions només estan disponibles amb Firebase.');
    const targets = rangeSlotTargets(classIds, start, end);
    for (const target of targets) await ensureSession(target.classId, target.date, target.slotIndex);
    setNotice(targets.length
      ? `S'han preparat ${targets.length} ${targets.length === 1 ? 'sessió' : 'sessions'} del ${formatDateShort(start)} al ${formatDateShort(end)}.`
      : 'No hi ha hores a l’horari dins d’aquest rang.');
  }

  async function saveHolidayRanges(next) {
    if (isLocalDemo) throw new Error('Les festes només es desen amb Firebase.');
    const sorted = [...next].sort((a, b) => a.start.localeCompare(b.start));
    setHolidayRanges(sorted);
    await setDoc(doc(db, 'settings', profile.uid), {
      teacherId: profile.uid,
      holidayRanges: sorted,
      // Camp antic mantingut per si queda alguna pestanya vella oberta.
      holidays: expandDateRanges(sorted),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  }

  async function addHolidayRange(range) {
    if (holidayRanges.some((item) => item.start === range.start && item.end === range.end)) return;
    await saveHolidayRanges([...holidayRanges, range]);
  }

  async function removeHolidayRange(index) {
    await saveHolidayRanges(holidayRanges.filter((item, position) => position !== index));
  }

  async function addActivityToSession(session, activity) {
    if (isLocalDemo) throw new Error('Les sessions només estan disponibles amb Firebase.');
    const item = {
      id: `${activity.id}_${Date.now()}`,
      activityId: activity.id,
      activityTitle: activity.title,
      title: activity.title,
      type: activity.type || 'document',
      content: '',
      instructions: '',
      dueDate: '',
    };
    const next = { ...session, items: [...(session.items || []), item] };
    await saveSession(next);
    setNotice('Activitat afegida a la sessió.');
    return next;
  }

  function applyLocal(current) {
    setProfile(current.profile);
    setClasses(current.classes);
    setTimetable(current.timetable);
    setYears(current.years || [SCHOOL_YEAR]);
    setStudents(current.students || []);
    setYearDocs((current.years || [SCHOOL_YEAR]).map((year) => ({
      year,
      slots: year === current.profile?.schoolYear ? (current.slots || DEFAULT_SLOTS) : DEFAULT_SLOTS,
    })));
  }

  function resetView() {
    setSection('taulell');
    setGlobalView(null);
    setEditingHorari(false);
    setSelectedSession(null);
  }

  useEffect(() => {
    if (isLocalDemo) {
      applyLocal(localCurrent());
      setHolidayRanges([]);
      setLoading(false);
      return undefined;
    }

    if (!isFirebaseConfigured) {
      setLoading(false);
      return undefined;
    }

    async function loadProfile(fbUser) {
      classListenerRef.current?.();
      studentListenerRef.current?.();
      inviteListenerRef.current?.();
      activityListenerRef.current?.();
      sessionListenerRef.current?.();
      classListenerRef.current = null;
      studentListenerRef.current = null;
      inviteListenerRef.current = null;
      activityListenerRef.current = null;
      sessionListenerRef.current = null;
      if (!fbUser) {
        applyLocal({ profile: null, classes: [], timetable: [], years: [SCHOOL_YEAR] });
        setActivities([]);
        setSessions([]);
        setHolidayRanges([]);
        setLoading(false);
        return;
      }
      try {
        const snapshot = await getDoc(doc(db, 'users', fbUser.uid));
        let data = snapshot.data();
        if (!data) {
          data = {
            name: fbUser.email.split('@')[0],
            email: fbUser.email,
            role: 'student',
            activeClassId: null,
            schoolYear: SCHOOL_YEAR,
          };
          await setDoc(doc(db, 'users', fbUser.uid), data);
        }
        const schoolYear = data.schoolYear || SCHOOL_YEAR;
        // El professor sempre comença a la portada: el grup actiu no es recupera
        // del doc d'usuari en tancar i tornar a obrir la sessió.
        const initialProfile = data.role === 'teacher' ? { ...data, activeClassId: null } : data;
        setProfile({ uid: fbUser.uid, ...initialProfile, schoolYear });

        if (data.role === 'teacher') {
          const holidaySnapshot = await getDoc(doc(db, 'settings', fbUser.uid));
          const settingsData = holidaySnapshot.data() || {};
          const storedRanges = settingsData.holidayRanges;
          setHolidayRanges(Array.isArray(storedRanges) && storedRanges.length
            ? storedRanges.filter((item) => item?.start && item?.end && item.start <= item.end)
            : datesToRanges(settingsData.holidays || []));

          const teacherQuery = query(collection(db, 'classes'), where('teacherId', '==', fbUser.uid));
          const classSnapshot = await getDocs(teacherQuery);
          const allClasses = classSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
          setClasses(allClasses);

          const yearQuery = query(collection(db, 'schoolYears'), where('teacherId', '==', fbUser.uid));
          const yearSnapshot = await getDocs(yearQuery);
          const seededYear = await ensureYearSeed(fbUser.uid, schoolYear, allClasses.filter((item) => item.schoolYear === schoolYear));
          const allYearDocs = [...yearSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((item) => item.year !== schoolYear), seededYear];
          const allYears = [...new Set([
            ...allYearDocs.map((item) => item.year),
            ...allClasses.map((item) => item.schoolYear),
          ])].filter(Boolean).sort();
          setYearDocs(allYearDocs);
          setYears(allYears);

          const studentQuery = query(collection(db, 'students'), where('teacherId', '==', fbUser.uid));
          const studentSnapshot = await getDocs(studentQuery);
          setStudents(studentSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })));

          // Actualització en temps real: colors, alumnes i estats canvien sense recarregar.
          classListenerRef.current = onSnapshot(teacherQuery, (snapshot) => {
            setClasses(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
          });
          studentListenerRef.current = onSnapshot(studentQuery, (snapshot) => {
            setStudents(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
          });

          const entriesQuery = query(collection(db, 'timetable'), where('teacherId', '==', fbUser.uid));
          const entriesSnapshot = await getDocs(entriesQuery);
          setTimetable(entriesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })));

          // El banc d'activitats és independent del curs i dels grups.
          const activityQuery = query(collection(db, 'activities'), where('teacherId', '==', fbUser.uid));
          activityListenerRef.current = onSnapshot(activityQuery, (snapshot) => {
            setActivities(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
          });

          const sessionQuery = query(collection(db, 'sessions'), where('teacherId', '==', fbUser.uid));
          sessionListenerRef.current = onSnapshot(sessionQuery, (snapshot) => {
            setSessions(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
          });
        } else {
          const normalizedEmail = String(fbUser.email || '').toLowerCase();
          const linked = await linkPendingInvite(fbUser.uid, normalizedEmail);
          if (linked) {
            const previousClassId = data.activeClassId || null;
            data = { ...data, activeClassId: linked.classId };
            setProfile({ uid: fbUser.uid, ...data, schoolYear });
            // Només sobreescrivim el doc si encara no tenia grup: les regles no
            // permeten canviar l'assignació d'un alumne que ja té classe.
            if (!previousClassId) {
              await updateDoc(doc(db, 'users', fbUser.uid), { activeClassId: linked.classId });
            }
          }

          // Alumnes ja creats: la classe pot venir del doc d'usuari o de la fitxa d'alumne.
          const ownStudents = await getDocs(query(collection(db, 'students'), where('email', '==', normalizedEmail)));
          const ownStudent = ownStudents.docs.map((item) => ({ id: item.id, ...item.data() }))
            .find((item) => !item.uid || item.uid === fbUser.uid);
          const classId = data.activeClassId || ownStudent?.classIds?.[0] || null;
          if (!data.activeClassId && classId) {
            data = { ...data, activeClassId: classId };
            await updateDoc(doc(db, 'users', fbUser.uid), { activeClassId: classId });
            setProfile({ uid: fbUser.uid, ...data, schoolYear });
          }

          setTimetable([]);
          setStudents([]);

          async function watchStudentClass(activeId) {
            classListenerRef.current?.();
            activityListenerRef.current?.();
            sessionListenerRef.current?.();
            classListenerRef.current = null;
            activityListenerRef.current = null;
            sessionListenerRef.current = null;
            setClasses([]);
            setActivities([]);
            setSessions([]);
            if (!activeId) return;

            sessionListenerRef.current = onSnapshot(
              query(collection(db, 'sessions'), where('classId', '==', activeId)),
              (snapshot) => setSessions(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
            );
            const classSnapshot = await getDoc(doc(db, 'classes', activeId));
            if (!classSnapshot.exists()) return;
            const group = { id: classSnapshot.id, ...classSnapshot.data() };
            setClasses([group]);
            classListenerRef.current = onSnapshot(doc(db, 'classes', activeId), (snapshot) => {
              setClasses(snapshot.exists() ? [{ id: snapshot.id, ...snapshot.data() }] : []);
            });
            const activityQuery = query(collection(db, 'activities'), where('teacherId', '==', group.teacherId));
            activityListenerRef.current = onSnapshot(activityQuery, (snapshot) => {
              setActivities(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
            });
          }

          await watchStudentClass(classId);

          // Si arriba una invitació nova mentre l'alumne ja té la sessió oberta, s'hi associa al moment.
          inviteListenerRef.current = onSnapshot(
            query(collection(db, 'invites'), where('email', '==', normalizedEmail)),
            async (snapshot) => {
              if (!snapshot.docs.some((item) => item.data().status === 'pending')) return;
              try {
                const invitation = await linkPendingInvite(fbUser.uid, normalizedEmail);
                if (!invitation) return;
                setProfile((previous) => previous ? { ...previous, activeClassId: invitation.classId } : previous);
                await watchStudentClass(invitation.classId);
              } catch (failure) {
                console.error('No s’ha pogut associar la invitació:', failure);
              }
            },
          );
        }
      } catch (error) {
        console.error(error);
        setNotice('No s’han pogut carregar les dades del compte.');
      } finally {
        setLoading(false);
      }
    }

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (seedingRef.current) return;
      if (!fbUser && !seedStarted && localStorage.getItem('aula-demo-seeded') !== 'true') {
        setSeedStarted(true);
        seedingRef.current = true;
        try {
          await ensureDemoAccount();
        } catch (error) {
          console.error(error);
        } finally {
          seedingRef.current = false;
        }
        await loadProfile(auth.currentUser);
        return;
      }
      await loadProfile(fbUser);
    });

    return () => {
      unsubscribe();
      classListenerRef.current?.();
      studentListenerRef.current?.();
      inviteListenerRef.current?.();
      activityListenerRef.current?.();
      sessionListenerRef.current?.();
    };
  }, [seedStarted, isLocalDemo]);

  async function login(email, password) {
    setNotice('');
    if (isLocalDemo) {
      applyLocal(localLogin(email, password));
      resetView();
      return;
    }
    await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  }

  async function register({ name, email, password, code }) {
    setNotice('');
    const normalized = email.trim().toLowerCase();
    if (!name.trim()) throw new Error('Escriu el teu nom i cognoms.');
    if (String(code || '').trim().toUpperCase() !== TEACHER_REGISTRATION_CODE) {
      throw new Error('El codi de registre no és correcte. Demana’l al centre.');
    }
    if (isLocalDemo) throw new Error('El registre de comptes només està disponible a la versió de Firebase.');

    const credential = await createUserWithEmailAndPassword(setupAuth, normalized, password);
    const uid = credential.user.uid;
    try {
      await setDoc(doc(setupDb, 'users', uid), {
        name: name.trim(),
        email: normalized,
        role: 'teacher',
        activeClassId: null,
        schoolYear: SCHOOL_YEAR,
      });
      await seedGroupsForTeacher(uid, setupDb);
    } finally {
      await signOut(setupAuth);
    }
    await signInWithEmailAndPassword(auth, normalized, password);
    // Refresquem per assegurar que les dades acabades de crear es llegeixin del servidor.
    window.location.reload();
  }

  async function logout() {
    if (isLocalDemo) {
      localLogout();
      applyLocal({ profile: null, classes: [], timetable: [], years: [SCHOOL_YEAR] });
    } else {
      await signOut(auth);
    }
    resetView();
    setNotice('Has tancat la sessió.');
  }

  async function activate(classId) {
    if (isLocalDemo) {
      applyLocal(localSetActive(classId));
    } else {
      // El grup actiu és només de la sessió actual: no es desa a Firestore perquè
      // en tancar i tornar a entrar sempre es mostri la portada.
      setProfile({ ...profile, activeClassId: classId });
    }
    resetView();
  }

  async function exitGroup() {
    if (isLocalDemo) {
      applyLocal(localSetActive(null));
    } else {
      setProfile({ ...profile, activeClassId: null });
    }
    resetView();
  }

  async function changeColor(classId, color) {
    if (isLocalDemo) {
      applyLocal(localSetColor(classId, color));
      return;
    }
    await updateDoc(doc(db, 'classes', classId), { color });
    setClasses(classes.map((item) => item.id === classId ? { ...item, color } : item));
    setNotice('Color del grup desat.');
  }

  async function saveActivity(activity) {
    if (isLocalDemo) throw new Error('El banc d’activitats només està disponible amb Firebase.');
    const now = new Date().toISOString();
    const data = {
      title: activity.title,
      content: activity.content || '',
      type: activity.type || 'document',
      tags: activity.tags || [],
      sourceName: activity.sourceName || '',
      attachment: activity.attachment || null,
      status: activity.status === 'pending' ? 'pending' : 'active',
      updatedAt: now,
    };
    if (activity.id) {
      await updateDoc(doc(db, 'activities', activity.id), data);
    } else {
      await setDoc(doc(collection(db, 'activities')), { ...data, teacherId: profile.uid, createdAt: now });
    }
    setNotice('Activitat desada.');
  }

  /** Activitat nova des d'una sessió: s'hi afegeix directament i queda pendent al banc. */
  async function createActivityForSession(session, activity) {
    if (isLocalDemo) throw new Error('El banc d’activitats només està disponible amb Firebase.');
    const now = new Date().toISOString();
    const reference = doc(collection(db, 'activities'));
    await setDoc(reference, {
      title: activity.title,
      content: activity.content || '',
      type: activity.type || 'document',
      tags: activity.tags || [],
      sourceName: activity.sourceName || '',
      attachment: activity.attachment || null,
      status: 'pending',
      teacherId: profile.uid,
      createdAt: now,
      updatedAt: now,
    });
    const created = { id: reference.id, title: activity.title, type: activity.type || 'document', status: 'pending' };
    const updated = await addActivityToSession(session, created);
    setNotice('Activitat afegida a la sessió i desada al banc com a pendent de validar.');
    return updated;
  }

  async function validateActivity(id) {
    if (isLocalDemo) throw new Error('El banc d’activitats només està disponible amb Firebase.');
    await updateDoc(doc(db, 'activities', id), { status: 'active', updatedAt: new Date().toISOString() });
    setNotice('Activitat afegida al banc.');
  }

  async function deleteActivity(id) {
    if (isLocalDemo) throw new Error('El banc d’activitats només està disponible amb Firebase.');
    await deleteDoc(doc(db, 'activities', id));
    setNotice('Activitat esborrada.');
  }

  async function duplicateActivity(id) {
    if (isLocalDemo) throw new Error('El banc d’activitats només està disponible amb Firebase.');
    const source = activities.find((item) => item.id === id);
    if (!source) throw new Error('No s’ha trobat l’activitat.');
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = source;
    const now = new Date().toISOString();
    await setDoc(doc(collection(db, 'activities')), {
      ...rest,
      title: `${source.title} (còpia)`,
      teacherId: profile.uid,
      createdAt: now,
      updatedAt: now,
    });
    setNotice('Activitat duplicada.');
  }

  async function createGroup(name, level) {
    if (!name) throw new Error('Escriu el nom del grup.');
    if (isLocalDemo) {
      const created = localCreateGroup(name, level);
      applyLocal(created.data);
      return created.result;
    }
    const reference = doc(collection(db, 'classes'));
    const data = {
      name,
      subject: 'Matemàtiques',
      level: level || 'ESO',
      color: nextColor(classes.length),
      schoolYear: profile.schoolYear,
      code: inviteCode(),
      teacherId: profile.uid,
      studentIds: [],
    };
    await setDoc(reference, data);
    setClasses([...classes, { id: reference.id, ...data }]);
    return reference.id;
  }

  async function renameGroup(classId, name) {
    if (!name) throw new Error('Escriu el nom del grup.');
    if (isLocalDemo) {
      applyLocal(localRenameGroup(classId, name));
      return;
    }
    await updateDoc(doc(db, 'classes', classId), { name });
    setClasses(classes.map((item) => item.id === classId ? { ...item, name } : item));
    setStudents(students.map((item) => ({
      ...item,
      classNames: (item.classNames || []).map((value, index) =>
        (item.classIds || [])[index] === classId ? name : value),
    })));
  }

  async function deleteGroup(classId) {
    if (isLocalDemo) {
      applyLocal(localDeleteGroup(classId));
      return;
    }
    await deleteDoc(doc(db, 'classes', classId));
    for (const entry of timetable.filter((item) => item.classId === classId)) {
      await deleteDoc(doc(db, 'timetable', entry.id));
    }
    const affected = students.filter((item) => (item.classIds || []).includes(classId));
    for (const student of affected) {
      await updateDoc(doc(db, 'students', student.id), {
        classIds: student.classIds.filter((id) => id !== classId),
        classNames: (student.classNames || []).filter((value, index) => student.classIds[index] !== classId),
      });
    }
    setClasses(classes.filter((item) => item.id !== classId));
    setTimetable(timetable.filter((item) => item.classId !== classId));
    setStudents(students.map((item) => affected.some((student) => student.id === item.id)
      ? {
        ...item,
        classIds: item.classIds.filter((id) => id !== classId),
        classNames: (item.classNames || []).filter((value, index) => item.classIds[index] !== classId),
      }
      : item));
  }

  async function inviteStudent(classId, name, email) {
    if (!name || !email) throw new Error("Escriu el nom i el correu de l'alumne.");
    const group = classes.find((item) => item.id === classId);
    const code = inviteCode();
    email = email.trim().toLowerCase();
    if (isLocalDemo) {
      const created = localInviteStudent(classId, name, email);
      applyLocal(created.data);
      return created.result;
    }
    const reference = doc(collection(db, 'students'));
    const student = {
      teacherId: profile.uid,
      schoolYear: profile.schoolYear,
      name,
      email,
      classIds: [classId],
      classNames: group ? [group.name] : [],
      status: 'pending',
      inviteCode: code,
      uid: null,
      invitedAt: new Date().toISOString(),
    };
    await setDoc(reference, student);
    await setDoc(doc(db, 'invites', code), {
      teacherId: profile.uid,
      classId,
      className: group?.name || '',
      schoolYear: profile.schoolYear,
      studentId: reference.id,
      email,
      name,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    setStudents([...students, { id: reference.id, ...student }]);
    let emailed = false;
    try {
      await provisionStudentAccount(email);
      await sendInviteEmail(email);
      emailed = true;
    } catch (failure) {
      console.error('No s’ha pogut enviar el correu d’invitació:', failure);
    }
    return { code, emailed };
  }

  async function regenerateInvite(studentId) {
    const student = students.find((item) => item.id === studentId);
    if (!student) throw new Error('No s’ha trobat l’alumne.');
    const code = inviteCode();
    if (isLocalDemo) {
      const created = localRegenerateInvite(studentId);
      applyLocal(created.data);
      return created.result;
    }
    if (student.inviteCode) await deleteDoc(doc(db, 'invites', student.inviteCode));
    await setDoc(doc(db, 'invites', code), {
      teacherId: profile.uid,
      classId: (student.classIds || [])[0] || null,
      className: (student.classNames || [])[0] || '',
      schoolYear: student.schoolYear,
      studentId,
      email: student.email,
      name: student.name,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    await updateDoc(doc(db, 'students', studentId), { inviteCode: code, status: 'pending' });
    setStudents(students.map((item) => item.id === studentId ? { ...item, inviteCode: code, status: 'pending' } : item));
    try {
      await provisionStudentAccount(student.email);
      await sendInviteEmail(student.email);
    } catch (failure) {
      console.error('No s’ha pogut reenviar el correu d’invitació:', failure);
    }
    return code;
  }

  async function removeStudent(studentId, classId) {
    if (isLocalDemo) {
      applyLocal(localRemoveStudent(studentId, classId));
      return;
    }
    const student = students.find((item) => item.id === studentId);
    if (!student) return;
    const classIds = (student.classIds || []).filter((id) => id !== classId);
    const classNames = (student.classNames || []).filter((value, index) => (student.classIds || [])[index] !== classId);
    await updateDoc(doc(db, 'students', studentId), { classIds, classNames });
    setStudents(students.map((item) => item.id === studentId ? { ...item, classIds, classNames } : item));
  }

  async function resetPassword(email) {
    if (isLocalDemo) return;
    await sendPasswordResetEmail(auth, email);
  }

  async function changeCell(day, slotIndex, classId) {
    const slot = slots[slotIndex] || DEFAULT_SLOTS[slotIndex];
    const id = entryId(profile.uid, profile.schoolYear, day, slotIndex);
    const previous = timetable.find((item) => item.id === id);
    const legacyEntries = timetable.filter((item) => item.id !== id && item.day === day && item.start === slot.start);
    const group = yearClasses.find((item) => item.id === classId);
    const entry = group ? {
      teacherId: profile.uid,
      schoolYear: profile.schoolYear,
      day,
      slotIndex,
      start: slot.start,
      end: slot.end,
      kind: 'class',
      classId: group.id,
      label: group.name,
    } : null;

    if (isLocalDemo) {
      applyLocal(entry ? localSaveEntry({ id, ...entry }) : localDeleteEntry(id));
      return;
    }
    for (const legacy of legacyEntries) await deleteDoc(doc(db, 'timetable', legacy.id));
    if (entry) await setDoc(doc(db, 'timetable', id), entry);
    else if (previous) await deleteDoc(doc(db, 'timetable', id));
    const withoutLegacy = timetable.filter((item) => !legacyEntries.some((legacy) => legacy.id === item.id));
    setTimetable(entry
      ? (previous ? withoutLegacy.map((item) => item.id === id ? { id, ...entry } : item) : [...withoutLegacy, { id, ...entry }])
      : withoutLegacy.filter((item) => item.id !== id));
  }

  async function changeSlot(slotIndex, field, value) {
    const nextSlots = slots.map((slot, index) => index === slotIndex ? { ...slot, [field]: value } : slot);
    if (isLocalDemo) {
      applyLocal(localSetSlots(profile.schoolYear, nextSlots));
      return;
    }
    await setDoc(doc(db, 'schoolYears', `${profile.uid}_${profile.schoolYear}`), { slots: nextSlots }, { merge: true });
    const slot = nextSlots[slotIndex];
    const affected = timetable.filter((item) => slotIndexOf(item, slots) === slotIndex);
    for (const item of affected) {
      await setDoc(doc(db, 'timetable', item.id), { ...item, start: slot.start, end: slot.end });
    }
    setTimetable(timetable.map((item) => affected.some((entry) => entry.id === item.id)
      ? { ...item, start: slot.start, end: slot.end }
      : item));
    setYearDocs(yearDocs.map((item) => item.year === profile.schoolYear ? { ...item, slots: nextSlots } : item));
  }

  async function selectYear(year) {
    if (!years.includes(year)) return;
    if (isLocalDemo) {
      applyLocal(localSelectYear(year));
    } else {
      await updateDoc(doc(db, 'users', profile.uid), { schoolYear: year, activeClassId: null });
      setProfile({ ...profile, schoolYear: year, activeClassId: null });
    }
    resetView();
  }

  async function createYear(year, mode = 'duplicate') {
    if (!isValidSchoolYear(year)) throw new Error('Escriu el curs amb el format 2027-2028.');
    if (years.includes(year)) throw new Error('Aquest curs ja existeix.');

    if (isLocalDemo) {
      applyLocal(localCreateYear(year));
      resetView();
      return;
    }

    await setDoc(doc(db, 'schoolYears', `${profile.uid}_${year}`), {
      teacherId: profile.uid,
      year,
      createdAt: new Date().toISOString(),
      timetableSeeded: true,
      slots: slots.map((slot) => ({ ...slot })),
    });

    const idMap = new Map();
    const copiedClasses = [];
    const copiedEntries = [];
    if (mode !== 'blank') {
    for (const item of yearClasses) {
      const reference = doc(collection(db, 'classes'));
      const { id, studentIds, ...rest } = item;
      const copy = { ...rest, schoolYear: year, studentIds: [] };
      await setDoc(reference, copy);
      copiedClasses.push({ id: reference.id, ...copy });
      idMap.set(id, reference.id);
    }

    for (const entry of yearTimetable.filter((item) => item.kind === 'class')) {
      const slotIndex = slotIndexOf(entry, slots);
      const slot = slots[slotIndex] || DEFAULT_SLOTS[slotIndex];
      const id = entryId(profile.uid, year, entry.day, slotIndex);
      const copy = {
        teacherId: profile.uid,
        schoolYear: year,
        day: entry.day,
        slotIndex,
        start: slot?.start || entry.start,
        end: slot?.end || entry.end,
        kind: 'class',
        label: entry.label,
        classId: entry.classId ? (idMap.get(entry.classId) || null) : null,
      };
      await setDoc(doc(db, 'timetable', id), copy);
      copiedEntries.push({ id, ...copy });
    }
    }

    const newYearDoc = { teacherId: profile.uid, year, timetableSeeded: true, slots: slots.map((slot) => ({ ...slot })) };
    await updateDoc(doc(db, 'users', profile.uid), { schoolYear: year, activeClassId: null });
    setClasses([...classes, ...copiedClasses]);
    setTimetable([...timetable, ...copiedEntries]);
    setYearDocs([...yearDocs, { id: `${profile.uid}_${year}`, ...newYearDoc }]);
    setYears([...years, year].sort());
    setProfile({ ...profile, schoolYear: year, activeClassId: null });
    resetView();
  }

  if (!isFirebaseConfigured) {
    return (
      <div className="auth-body">
        <div className="auth-shell">
          <div className="auth-panel">
            <h2>Configura Firebase</h2>
            <p>Copia <code>web/.env.example</code> a <code>web/.env.local</code> i omple les dades del projecte de Firebase.</p>
          </div>
        </div>
      </div>
    );
  }

  if (inviteParam) {
    return (
      <InviteAccept
        code={inviteParam}
        onDone={() => {
          setInviteParam('');
          window.history.replaceState({}, '', window.location.pathname);
          setNotice('Ja pots entrar amb el teu correu i contrasenya.');
        }}
      />
    );
  }

  if (loading) return <div className="auth-body"><div className="auth-panel"><p>Carregant…</p></div></div>;

  if (!profile) return <Login notice={notice} onLogin={login} onRegister={register} />;

  const yearClasses = classes.filter((item) => item.schoolYear === profile.schoolYear);
  const yearTimetable = timetable.filter((item) => item.schoolYear === profile.schoolYear);
  const yearStudents = students.filter((item) => item.schoolYear === profile.schoolYear);
  const slots = yearDocs.find((item) => item.year === profile.schoolYear)?.slots || DEFAULT_SLOTS;
  const activeClass = profile.activeClassId ? yearClasses.find((item) => item.id === profile.activeClassId) : null;
  const rangeClassIds = globalView || !activeClass ? yearClasses.map((item) => item.id) : [activeClass.id];
  const rangeModal = rangeModalOpen ? (
    <SessionRangeModal
      schoolYear={profile.schoolYear}
      previewCount={(start, end) => rangeSlotTargets(rangeClassIds, start, end).length}
      onGenerate={async ({ start, end }) => {
        try {
          await createRangeSessions(rangeClassIds, { start, end });
        } catch (failure) {
          setNotice(failure.message || 'No s’han pogut crear les sessions.');
        }
      }}
      onClose={() => setRangeModalOpen(false)}
    />
  ) : null;

  if (globalView && profile.role === 'teacher') {
    return (
      <GlobalPage
        section={globalView}
        classes={yearClasses}
        students={yearStudents}
        timetable={yearTimetable}
        slots={slots}
        schoolYear={profile.schoolYear}
        notice={notice}
        holidays={holidays}
        holidayRanges={holidayRanges}
        onAddHolidayRange={addHolidayRange}
        onRemoveHolidayRange={removeHolidayRange}
        years={years}
        onSelectYear={selectYear}
        onCreateYear={createYear}
        onBack={() => setGlobalView(null)}
        onLogout={logout}
        onChangeCell={changeCell}
        editingHorari={editingHorari}
        onToggleEditHorari={() => setEditingHorari((value) => !value)}
        onChangeSlot={changeSlot}
        onCreateGroup={createGroup}
        onRenameGroup={renameGroup}
        onDeleteGroup={deleteGroup}
        onChangeColor={changeColor}
        onInviteStudent={inviteStudent}
        onRemoveStudent={removeStudent}
        onRegenerateInvite={regenerateInvite}
        onResetPassword={resetPassword}
        activities={activities}
        onSaveActivity={saveActivity}
        onDeleteActivity={deleteActivity}
        onDuplicateActivity={duplicateActivity}
        onValidateActivity={validateActivity}
        sessionFor={sessionFor}
        weekMonday={weekMonday}
        onWeekChange={setWeekMonday}
        onOpenSession={openSession}
        onCreateWeek={() => createWeekSessions(yearClasses.map((item) => item.id))}
        onOpenRange={() => setRangeModalOpen(true)}
        rangeModal={rangeModal}
        selectedSession={selectedSession}
        sessions={sessions}
        onSaveSession={saveSession}
        onAddActivity={addActivityToSession}
        onCreateActivity={createActivityForSession}
        onCloseSession={() => setSelectedSession(null)}
        onNavigateSession={navigateSession}
        sessionNav={sessionNavFor(selectedSession)}
      />
    );
  }

  if (profile.role !== 'teacher') {
    return (
      <StudentHome
        profile={profile}
        group={classes[0] || null}
        sessions={sessions}
        activities={activities}
        onLogout={logout}
      />
    );
  }

  if (profile.role === 'teacher' && !activeClass) {
    return (
      <Principal
        key={profile.schoolYear}
        profile={profile}
        classes={yearClasses}
        students={yearStudents}
        notice={notice}
        onActivate={activate}
        onLogout={logout}
        onOpenGlobal={setGlobalView}
      />
    );
  }

  return (
    <GroupLayout
      activeClass={activeClass}
      notice={notice}
      section={section}
      onNavigate={setSection}
      onExit={exitGroup}
      onLogout={logout}
      sessions={sessions}
      activities={activities}
      students={students}
      timetable={yearTimetable}
      slots={slots}
      schoolYear={profile.schoolYear}
      weekMonday={weekMonday}
      holidays={holidays}
      onWeekChange={setWeekMonday}
      sessionFor={sessionFor}
      onOpenSession={openSession}
      onCreateWeek={() => createWeekSessions([activeClass.id])}
      onOpenRange={() => setRangeModalOpen(true)}
      rangeModal={rangeModal}
      onSaveSession={saveSession}
      onAddActivity={addActivityToSession}
      onCreateActivity={createActivityForSession}
      selectedSession={selectedSession}
      onCloseSession={() => setSelectedSession(null)}
      onNavigateSession={navigateSession}
      sessionNav={sessionNavFor(selectedSession)}
    />
  );
}
