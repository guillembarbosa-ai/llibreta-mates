'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');
const { requireAuth, requireTeacher } = require('../auth');
const { currentYear, setCurrentClass } = require('../courses');
const { isValidColor, nextColor } = require('../colors');

const router = express.Router();
router.use(requireAuth);

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function uniqueCode() {
  let code;
  do {
    code = generateCode();
  } while (await db.prepare('SELECT id FROM classes WHERE code = ?').get(code));
  return code;
}

async function getClass(id, user) {
  const classRow = await db.prepare(`
    SELECT c.*, u.name AS teacher_name FROM classes c
    JOIN users u ON u.id = c.teacher_id WHERE c.id = ?
  `).get(id);
  if (!classRow) return null;
  if (classRow.school_year !== await currentYear()) return null;
  if (user.role === 'teacher' && Number(classRow.teacher_id) !== user.id) return null;
  if (user.role === 'student') {
    const enrolled = await db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?').get(id, user.id);
    if (!enrolled) return null;
  }
  return classRow;
}

function redirectWithError(res, path, message) {
  return res.redirect(`${path}?error=${encodeURIComponent(message)}`);
}

router.get('/', async (req, res) => {
  if (req.user.role === 'teacher') return renderTeacherClasses(req, res);
  return renderStudentClasses(req, res);
});

async function renderTeacherClasses(req, res) {
  const classes = await db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.class_id = c.id) AS session_count
    FROM classes c WHERE c.teacher_id = ? AND c.school_year = ? ORDER BY c.name ASC
  `).all(req.user.id, await currentYear());
  res.render('classes-teacher', { title: 'Classes', subtitle: 'Organitza els grups i el codi d’accés.', classes });
}

async function renderStudentClasses(req, res) {
  const classes = await db.prepare(`
    SELECT c.*, u.name AS teacher_name,
      (SELECT COUNT(*) FROM sessions s WHERE s.class_id = c.id) AS session_count
    FROM classes c
    JOIN users u ON u.id = c.teacher_id
    JOIN enrollments e ON e.class_id = c.id AND e.student_id = ?
    WHERE c.school_year = ?
    ORDER BY c.name ASC
  `).all(req.user.id, await currentYear());
  res.render('classes-student', { title: 'Classes', subtitle: 'Afegeix-te amb el codi que et doni el professor.', classes });
}

router.post('/', requireTeacher, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const subject = String(req.body.subject || '').trim();
  const level = String(req.body.level || '').trim();
  let color = String(req.body.color || '').trim();
  if (!name) return redirectWithError(res, '/classes', 'El nom de la classe és obligatori.');
  if (!isValidColor(color)) {
    const count = await db.prepare('SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ? AND school_year = ?')
      .get(req.user.id, await currentYear());
    color = nextColor(Number(count.n));
  }

  await db.prepare(`
    INSERT INTO classes (name, subject, level, color, school_year, code, teacher_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, subject, level, color, await currentYear(), await uniqueCode(), req.user.id);
  res.redirect('/classes?notice=' + encodeURIComponent('Classe creada correctament.'));
});

router.post('/activate', requireTeacher, async (req, res) => {
  const raw = String(req.body.class_id || '').trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) return redirectWithError(res, '/classes', 'Grup no vàlid.');
    const classRow = await getClass(raw, req.user);
    if (!classRow) return redirectWithError(res, '/classes', 'Aquest grup no és del curs actiu.');
    await setCurrentClass(req.user.id, Number(classRow.id));
    return res.redirect(`/?notice=${encodeURIComponent(`Ara gestiones el grup ${classRow.name}.`)}`);
  }
  await setCurrentClass(req.user.id, null);
  res.redirect('/?notice=' + encodeURIComponent('Tria el grup que vols gestionar.'));
});

router.post('/:id/color', requireTeacher, async (req, res) => {
  const classRow = await getClass(req.params.id, req.user);
  if (!classRow) return res.redirect('/classes');
  const color = String(req.body.color || '').trim();
  if (!isValidColor(color)) {
    return redirectWithError(res, `/classes/${Number(classRow.id)}`, 'Color no vàlid.');
  }
  await db.prepare('UPDATE classes SET color = ? WHERE id = ?').run(color, classRow.id);
  res.redirect(`/classes?notice=${encodeURIComponent(`Color de ${classRow.name} actualitzat.`)}`);
});

router.post('/join', async (req, res) => {
  if (req.user.role !== 'student') return res.redirect('/classes');
  const code = String(req.body.code || '').trim().toUpperCase();
  const classRow = await db.prepare('SELECT * FROM classes WHERE code = ?').get(code);
  if (!classRow || classRow.school_year !== await currentYear()) {
    return redirectWithError(res, '/classes', 'No s’ha trobat cap classe amb aquest codi en el curs actiu.');
  }

  const already = await db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?')
    .get(classRow.id, req.user.id);
  if (!already) {
    await db.prepare('INSERT INTO enrollments (class_id, student_id) VALUES (?, ?)')
      .run(classRow.id, req.user.id);
  }
  res.redirect(`/classes/${Number(classRow.id)}?notice=${encodeURIComponent('T’has afegit a la classe.')}`);
});

router.get('/:id', async (req, res) => {
  const classRow = await getClass(req.params.id, req.user);
  if (!classRow) return res.redirect('/classes?error=' + encodeURIComponent('Classe no trobada.'));

  const students = await db.prepare(`
    SELECT u.id, u.name, u.email,
      (SELECT COUNT(*) FROM submissions sub
       JOIN assignments a ON a.id = sub.assignment_id
       JOIN sessions s ON s.id = a.session_id
       WHERE sub.student_id = u.id AND s.class_id = c.id) AS submission_count
    FROM users u
    JOIN enrollments e ON e.student_id = u.id
    JOIN classes c ON c.id = e.class_id
    WHERE e.class_id = ? ORDER BY u.name ASC
  `).all(classRow.id);

  const sessions = await db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM assignments a WHERE a.session_id = s.id) AS activity_count
    FROM sessions s WHERE s.class_id = ? ORDER BY s.session_date DESC, s.id DESC LIMIT 12
  `).all(classRow.id);

  res.render('class-detail', { title: classRow.name, subtitle: `${classRow.subject || 'Classe'} · ${classRow.school_year || '—'}`, classRow, students, sessions });
});

router.post('/:id/students', requireTeacher, async (req, res) => {
  const classRow = await getClass(req.params.id, req.user);
  if (!classRow) return res.redirect('/classes');
  const email = String(req.body.email || '').trim().toLowerCase();
  const student = await db.prepare("SELECT id FROM users WHERE email = ? AND role = 'student'").get(email);
  if (!student) {
    return redirectWithError(res, `/classes/${Number(classRow.id)}`, 'No s’ha trobat cap alumne amb aquest correu. Primer s’ha de registrar.');
  }
  const already = await db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?')
    .get(classRow.id, student.id);
  if (!already) {
    await db.prepare('INSERT INTO enrollments (class_id, student_id) VALUES (?, ?)')
      .run(classRow.id, student.id);
  }
  res.redirect(`/classes/${Number(classRow.id)}?notice=${encodeURIComponent('Alumne afegit a la classe.')}`);
});

router.post('/:id/students/remove', requireTeacher, async (req, res) => {
  const classRow = await getClass(req.params.id, req.user);
  if (!classRow) return res.redirect('/classes');
  await db.prepare('DELETE FROM enrollments WHERE class_id = ? AND student_id = ?')
    .run(classRow.id, req.body.student_id);
  res.redirect(`/classes/${Number(classRow.id)}?notice=${encodeURIComponent('Alumne eliminat de la classe.')}`);
});

router.post('/:id/delete', requireTeacher, async (req, res) => {
  const classRow = await getClass(req.params.id, req.user);
  if (!classRow) return res.redirect('/classes');
  await db.prepare('DELETE FROM classes WHERE id = ?').run(classRow.id);
  res.redirect('/classes?notice=' + encodeURIComponent('Classe eliminada.'));
});

module.exports = router;
