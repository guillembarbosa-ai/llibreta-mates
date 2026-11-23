'use strict';

const { db } = require('./db');
const { randomToken, sign, safeEqual } = require('./security');

const COOKIE_NAME = 'aula_sid';
const SESSION_HOURS = 12;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  throw new Error('Cal definir SESSION_SECRET a les variables d’entorn de producció.');
}
const SECRET = process.env.SESSION_SECRET || 'canvia-aquest-secret-a-production-aula-2026';

function cookieValue(token) {
  return `${token}.${sign(token, SECRET)}`;
}

function parseCookie(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

async function createSession(res, userId) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  await db.prepare('INSERT INTO auth_sessions (token, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, csrfToken, expiresAt);
  res.cookie(COOKIE_NAME, cookieValue(token), {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
  return csrfToken;
}

async function destroySession(req, res) {
  if (req.session) {
    await db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(req.session.token);
  }
  res.clearCookie(COOKIE_NAME);
}

async function sessionMiddleware(req, res, next) {
  const raw = parseCookie(req.headers.cookie)[COOKIE_NAME];
  req.user = null;
  req.session = null;
  req.csrfToken = null;

  if (raw) {
    const separator = raw.lastIndexOf('.');
    const token = separator === -1 ? '' : raw.slice(0, separator);
    const signature = separator === -1 ? '' : raw.slice(separator + 1);
    if (token && safeEqual(signature, sign(token, SECRET))) {
      const session = await db.prepare(`
        SELECT s.token, s.csrf_token, s.expires_at, u.id, u.name, u.email, u.role
        FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
      `).get(token);
      if (session && Number(session.expires_at) > Date.now()) {
        req.user = { id: Number(session.id), name: session.name, email: session.email, role: session.role };
        req.session = { token: session.token };
        req.csrfToken = session.csrf_token;
      }
    }
  }

  res.locals.user = req.user;
  res.locals.csrfToken = req.csrfToken;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireTeacher(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'teacher') {
    req.flash = 'Aquesta acció només és per al professorat.';
    return res.status(403).render('error', { title: 'Accés denegat', message: req.flash, status: 403 });
  }
  next();
}

function checkCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const received = req.body?._csrf || req.query?._csrf || req.headers['x-csrf-token'];
  if (!req.csrfToken) return next(); // sessions sense autenticar (login/registre)
  if (received && safeEqual(received, req.csrfToken)) return next();
  return res.status(403).render('error', {
    title: 'Sessió caducada',
    message: 'La sessió ha caducat o el formulari no és vàlid. Torna a carregar la pàgina.',
    status: 403,
  });
}

module.exports = {
  COOKIE_NAME,
  createSession,
  destroySession,
  sessionMiddleware,
  requireAuth,
  requireTeacher,
  checkCsrf,
};
