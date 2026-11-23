'use strict';

const path = require('node:path');
const express = require('express');
const { ROOT, initDb } = require('./db');
const util = require('./util');
const colors = require('./colors');
const { sessionMiddleware, checkCsrf } = require('./auth');
const { currentYear, listYears, ensureDefaults, currentClassId, selectableClasses } = require('./courses');
const { ensureDemoTeacher } = require('./seed-user');
const { ensureBucket } = require('./storage');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// Inicialització diferida: Vercel importa l'app sense obrir la BD fins al primer request.
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = initDb()
      .then(() => ensureDemoTeacher())
      .then(() => ensureBucket().catch((error) => {
        console.error('No s’ha pogut comprovar el bucket de Storage:', error.message);
      }));
  }
  return readyPromise;
}
app.use(async (req, res, next) => {
  try { await ready(); next(); } catch (error) { next(error); }
});

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0, etag: true }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});
// Els formularis multipart es validen a la ruta, després que Multer parsegi el cos.
app.use((req, res, next) => {
  if (req.is('multipart/form-data')) return next();
  return checkCsrf(req, res, next);
});

app.use(async (req, res, next) => {
  try {
    await ensureDefaults();
    Object.assign(res.locals, util);
    Object.assign(res.locals, colors);
    res.locals.notice = req.query.notice || '';
    res.locals.error = req.query.error || '';
    res.locals.currentPath = req.path;
    res.locals.currentYear = await currentYear();
    res.locals.years = req.user ? await listYears() : [];
    res.locals.activeClassId = req.user && req.user.role === 'teacher' ? await currentClassId(req.user.id) : null;
    res.locals.groupOptions = req.user && req.user.role === 'teacher' ? await selectableClasses(req.user.id) : [];
    next();
  } catch (error) {
    next(error);
  }
});

// Un professor ha de triar una classe abans d'entrar a la plataforma.
app.use(async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'teacher' || await currentClassId(req.user.id)) return next();
    const allowed = /^\/(?:$|classes(?:\/|$)|timetable(?:\/|$)|courses(?:\/|$)|logout$)/.test(req.path);
    return allowed ? next() : res.redirect('/');
  } catch (error) {
    return next(error);
  }
});

app.use('/', require('./routes/authRoutes'));
app.use('/', require('./routes/mainRoutes'));
app.use('/courses', require('./routes/courseRoutes'));
app.use('/timetable', require('./routes/timetableRoutes'));
app.use('/classes', require('./routes/classRoutes'));
app.use('/activities', require('./routes/activityRoutes'));
app.use('/sessions', require('./routes/sessionRoutes'));
app.use('/submissions', require('./routes/submissionRoutes'));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Pàgina no trobada',
    message: 'La pàgina que busques no existeix o s’ha mogut.',
    status: 404,
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).render('error', {
    title: 'S’ha produït un error',
    message: 'Hi ha hagut un problema intern. Torna-ho a provar.',
    status: 500,
  });
});

const PORT = Number(process.env.PORT) || 3100;
if (require.main === module) {
  ready()
    .then(() => app.listen(PORT, () => {
      console.log(`Aula dia a dia escoltant a http://localhost:${PORT}`);
    }))
    .catch((error) => {
      console.error('No s’ha pogut iniciar l’aplicació:', error);
      process.exit(1);
    });
}

module.exports = app;
module.exports.ready = ready;
