'use strict';

const express = require('express');
const { db } = require('../db');
const { hashPassword, verifyPassword } = require('../security');
const { createSession, destroySession, requireAuth } = require('../auth');
const { currentYear } = require('../courses');
const { importTimetable } = require('../horari');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Iniciar sessió' });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).render('login', {
      title: 'Iniciar sessió',
      error: 'El correu o la contrasenya no són correctes.',
      email,
    });
  }

  await createSession(res, Number(user.id));
  res.redirect(`/?notice=${encodeURIComponent(`Hola, ${user.name.split(' ')[0]}!`)}`);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Crear compte' });
});

router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'teacher' ? 'teacher' : 'student';

  const renderError = (error) => res.status(400).render('register', {
    title: 'Crear compte', error, values: { name, email, role },
  });

  if (name.length < 2) return renderError('Escriu el teu nom complet.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return renderError('Escriu un correu electrònic vàlid.');
  if (password.length < 8) return renderError('La contrasenya ha de tenir almenys 8 caràcters.');
  if (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return renderError('Ja existeix un compte amb aquest correu.');
  }

  const result = await db.prepare(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(name, email, hashPassword(password), role);

  const userId = Number(result.lastInsertRowid);
  if (role === 'teacher') await importTimetable(userId, await currentYear());
  await createSession(res, userId);
  const notice = role === 'teacher'
    ? 'Compte creat. L’horari ja està importat: edita’l si cal.'
    : 'Compte creat correctament.';
  const target = '/';
  res.redirect(`${target}?notice=${encodeURIComponent(notice)}`);
});

router.post('/logout', requireAuth, async (req, res) => {
  await destroySession(req, res);
  res.redirect('/login?notice=' + encodeURIComponent('Has tancat la sessió.'));
});

module.exports = router;
