'use strict';

// Compte de professor fixe per fer proves. Es crea si no existeix i no s'esborra
// en reiniciar el servidor. L'horari s'importa igual que en un registre normal.

const { db } = require('./db');
const { hashPassword } = require('./security');
const { currentYear } = require('./courses');
const { importTimetable } = require('./horari');

const DEMO = {
  name: 'Professor Prova',
  email: 'profe@test.cat',
  password: 'prova12345',
};

async function ensureDemoTeacher() {
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO.email);
  if (existing) return { id: Number(existing.id), created: false };

  const result = await db.prepare(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).run(DEMO.name, DEMO.email, hashPassword(DEMO.password), 'teacher');

  const id = Number(result.lastInsertRowid);
  await importTimetable(id, await currentYear());
  return { id, created: true };
}

module.exports = { ensureDemoTeacher, DEMO };
