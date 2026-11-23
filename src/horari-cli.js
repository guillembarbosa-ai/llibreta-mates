'use strict';

const { db, initDb, client } = require('./db');
const { currentYear } = require('./courses');
const { importTimetable, generateSessions, mondayOf, addDays } = require('./horari');

async function main() {
  await initDb();
  const teacher = await db.prepare("SELECT id, name FROM users WHERE role = 'teacher' ORDER BY id LIMIT 1").get();
  if (!teacher) {
    console.error('No hi cap professor. Registra’n un primer a /register.');
    client.close();
    process.exit(1);
  }

  const year = await currentYear();
  const start = process.argv[2] || mondayOf();
  const end = process.argv[3] || addDays(start, 27);

  const imported = await importTimetable(teacher.id, year);
  const generated = await generateSessions(teacher.id, start, end, year);

  console.log(`Horari de ${teacher.name} · curs ${year}:`);
  console.log(`  Grups creats: ${imported.createdClasses}; franges creades: ${imported.createdEntries}`);
  console.log(`  Sessions generades entre ${start} i ${end}: ${generated.created}`);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
