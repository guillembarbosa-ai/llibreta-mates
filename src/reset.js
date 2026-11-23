'use strict';

// Deixa la base de dades completament buida, amb només el curs inicial configurat.
// Funciona tant amb el fitxer local com amb la base de dades remota (Turso).
// ATENCIÓ: esborra TOTS els usuaris llevat del professor de proves.

const fs = require('node:fs');
const path = require('node:path');
const { db, client, initDb, UPLOADS_DIR, IS_REMOTE, DEFAULT_YEAR } = require('./db');
const { ensureDefaults, currentYear } = require('./courses');
const { ensureDemoTeacher, DEMO } = require('./seed-user');

async function main() {
  await initDb();

  // Ordre compatible amb les claus foranes.
  for (const table of [
    'submissions', 'assignments', 'sessions', 'timetable', 'enrollments',
    'activities', 'classes', 'auth_sessions', 'school_years', 'settings',
  ]) {
    await db.exec(`DELETE FROM ${table}`);
  }

  if (!IS_REMOTE) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    for (const entry of fs.readdirSync(UPLOADS_DIR)) {
      fs.rmSync(path.join(UPLOADS_DIR, entry), { recursive: true, force: true });
    }
  }

  await ensureDefaults();
  await ensureDemoTeacher();

  console.log('Dades esborrades. Base de dades a punt per fer proves.');
  console.log(`  Curs inicial: ${await currentYear()} (${DEFAULT_YEAR})`);
  console.log(`  Professor de proves: ${DEMO.email} / ${DEMO.password}`);
  if (IS_REMOTE) console.log('  Recorda buidar també els fitxers de Supabase Storage.');
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
