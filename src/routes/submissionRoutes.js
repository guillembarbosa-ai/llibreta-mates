'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const { db } = require('../db');
const { requireAuth, requireTeacher, checkCsrf } = require('../auth');
const { escapeLike } = require('../security');
const { currentYear, currentClassId } = require('../courses');
const { saveUpload, deleteUpload, sendUpload } = require('../storage');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'text/plain',
  'image/png',
  'image/jpeg',
  'application/zip',
  'application/x-zip-compressed',
]);

// El fitxer es guarda a memòria i storage.js el desa al lloc corresponent
// (Supabase Storage a producció, disc local en desenvolupament).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return callback(new Error('Format de fitxer no permès.'));
    }
    callback(null, true);
  },
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'El fitxer és massa gran (màxim 10 MB).'
        : 'El fitxer no és vàlid. Formats permesos: PDF, Word, ODT, TXT, imatge o ZIP.';
      return res.redirect(`/submissions/new/${req.params.assignment_id}?error=${encodeURIComponent(message)}`);
    }
    next();
  });
}

async function getSubmission(id, user) {
  const submission = await db.prepare(`
    SELECT sub.*, asg.id AS assignment_id, asg.instructions, asg.due_at,
           a.title AS activity_title, s.id AS session_id, s.title AS session_title,
           s.teacher_id, s.class_id, s.school_year, c.name AS class_name, c.color AS class_color,
           u.name AS student_name, u.email AS student_email
    FROM submissions sub
    JOIN assignments asg ON asg.id = sub.assignment_id
    JOIN activities a ON a.id = asg.activity_id
    JOIN sessions s ON s.id = asg.session_id
    JOIN classes c ON c.id = s.class_id
    JOIN users u ON u.id = sub.student_id
    WHERE sub.id = ?
  `).get(id);
  if (!submission || submission.school_year !== await currentYear()) return null;
  if (user.role === 'teacher') {
    if (Number(submission.teacher_id) !== user.id) return null;
    const active = await currentClassId(user.id);
    return active && Number(submission.class_id) !== active ? null : submission;
  }
  return Number(submission.student_id) === user.id ? submission : null;
}

async function getAssignment(id, user) {
  const assignment = await db.prepare(`
    SELECT asg.*, a.title AS activity_title, a.description,
           s.id AS session_id, s.title AS session_title, s.class_id, s.school_year,
           c.name AS class_name, c.color AS class_color
    FROM assignments asg
    JOIN activities a ON a.id = asg.activity_id
    JOIN sessions s ON s.id = asg.session_id
    JOIN classes c ON c.id = s.class_id
    WHERE asg.id = ?
  `).get(id);
  if (!assignment || assignment.school_year !== await currentYear()) return null;
  if (user.role === 'teacher') {
    const active = await currentClassId(user.id);
    if (active && Number(assignment.class_id) !== active) return null;
  }
  return assignment;
}

async function canSubmit(assignment, user) {
  if (user.role !== 'student' || !assignment) return false;
  return Boolean(await db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?')
    .get(assignment.class_id, user.id));
}

router.get('/', async (req, res) => {
  if (req.user.role === 'teacher') return renderTeacherList(req, res);
  return renderStudentList(req, res);
});

async function renderTeacherList(req, res) {
  const filters = {
    class_id: String(req.query.class_id || ''),
    activity_id: String(req.query.activity_id || ''),
    status: String(req.query.status || ''),
    q: String(req.query.q || '').trim(),
  };
  const conditions = ['s.teacher_id = ?', 's.school_year = ?'];
  const params = [req.user.id, await currentYear()];
  const active = await currentClassId(req.user.id);
  if (active) { conditions.push('s.class_id = ?'); params.push(active); }
  if (/^\d+$/.test(filters.class_id)) { conditions.push('s.class_id = ?'); params.push(filters.class_id); }
  if (/^\d+$/.test(filters.activity_id)) { conditions.push('asg.activity_id = ?'); params.push(filters.activity_id); }
  if (filters.status === 'pending') conditions.push('sub.grade IS NULL');
  if (filters.status === 'graded') conditions.push('sub.grade IS NOT NULL');
  if (filters.q) {
    conditions.push('(u.name LIKE ? ESCAPE \'\\\' OR a.title LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(filters.q)}%`;
    params.push(like, like);
  }

  const submissions = await db.prepare(`
    SELECT sub.id, sub.submitted_at, sub.grade, sub.feedback, sub.file_name,
           u.name AS student_name, a.title AS activity_title,
           s.title AS session_title, c.name AS class_name, c.color AS class_color
    FROM submissions sub
    JOIN assignments asg ON asg.id = sub.assignment_id
    JOIN activities a ON a.id = asg.activity_id
    JOIN sessions s ON s.id = asg.session_id
    JOIN classes c ON c.id = s.class_id
    JOIN users u ON u.id = sub.student_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY (sub.grade IS NULL) DESC, sub.submitted_at DESC, sub.id DESC LIMIT 400
  `).all(...params);

  const classes = await db.prepare('SELECT * FROM classes WHERE teacher_id = ? AND school_year = ? ORDER BY name ASC')
    .all(req.user.id, await currentYear());
  const activities = await db.prepare('SELECT id, title FROM activities WHERE teacher_id = ? AND school_year = ? ORDER BY title ASC')
    .all(req.user.id, await currentYear());

  res.render('submissions-teacher', {
    title: 'Lliuraments', subtitle: 'Corregeix i avalua les tasques rebudes.',
    submissions, classes, activities, filters,
  });
}

async function renderStudentList(req, res) {
  const submissions = await db.prepare(`
    SELECT sub.id, sub.submitted_at, sub.grade, sub.feedback, sub.file_name,
           a.title AS activity_title, s.title AS session_title,
           c.name AS class_name, c.color AS class_color, asg.due_at
    FROM submissions sub
    JOIN assignments asg ON asg.id = sub.assignment_id
    JOIN activities a ON a.id = asg.activity_id
    JOIN sessions s ON s.id = asg.session_id
    JOIN classes c ON c.id = s.class_id
    WHERE sub.student_id = ? AND s.school_year = ?
    ORDER BY sub.submitted_at DESC, sub.id DESC LIMIT 400
  `).all(req.user.id, await currentYear());

  res.render('submissions-student', {
    title: 'Les meves tasques', subtitle: 'Els teus lliuraments i les teves notes.',
    submissions,
  });
}

router.get('/new/:assignment_id', async (req, res) => {
  const assignment = await getAssignment(req.params.assignment_id, req.user);
  if (!await canSubmit(assignment, req.user)) {
    return res.redirect('/sessions?error=' + encodeURIComponent('No pots lliurar aquesta tasca.'));
  }
  const existing = await db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?')
    .get(assignment.id, req.user.id);
  res.render('submission-form', { title: 'Lliurar tasca', assignment, submission: existing });
});

// Multer ja ha omplert req.body, ara podem validar el CSRF del formulari.
router.post('/new/:assignment_id', handleUpload, checkCsrf, async (req, res) => {
  const assignment = await getAssignment(req.params.assignment_id, req.user);
  if (!await canSubmit(assignment, req.user)) return res.redirect('/sessions');

  const text = String(req.body.text || '').trim();
  const file = req.file;
  if (!text && !file) {
    return res.redirect(`/submissions/new/${assignment.id}?error=${encodeURIComponent('Escriu una resposta o puja un fitxer.')}`);
  }

  const fileData = file ? {
    file_name: file.originalname,
    file_path: `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`,
    file_mime: file.mimetype,
    file_size: file.size,
  } : { file_name: null, file_path: null, file_mime: null, file_size: null };

  if (file) await saveUpload(fileData.file_path, file.buffer, file.mimetype);

  const existing = await db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?')
    .get(assignment.id, req.user.id);

  if (existing) {
    if (file && existing.file_path) await deleteUpload(existing.file_path);
    await db.prepare(`
      UPDATE submissions SET text = ?, file_name = ?, file_path = ?, file_mime = ?, file_size = ?,
        submitted_at = COALESCE(submitted_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ?
    `).run(text, fileData.file_name, fileData.file_path || existing.file_path,
      fileData.file_mime || existing.file_mime, fileData.file_size || existing.file_size, existing.id);
    return res.redirect(`/submissions/${existing.id}?notice=${encodeURIComponent('Lliurament actualitzat.')}`);
  }

  const result = await db.prepare(`
    INSERT INTO submissions (assignment_id, student_id, text, file_name, file_path, file_mime,
                             file_size, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(assignment.id, req.user.id, text, fileData.file_name, fileData.file_path,
    fileData.file_mime, fileData.file_size);

  res.redirect(`/submissions/${Number(result.lastInsertRowid)}?notice=${encodeURIComponent('Tasca lliurada correctament.')}`);
});

router.get('/:id', async (req, res) => {
  const submission = await getSubmission(req.params.id, req.user);
  if (!submission) return res.redirect('/submissions?error=' + encodeURIComponent('Lliurament no trobat.'));
  res.render('submission-detail', { title: 'Fitxa del lliurament', submission });
});

router.post('/:id/grade', requireTeacher, async (req, res) => {
  const submission = await getSubmission(req.params.id, req.user);
  if (!submission) return res.redirect('/submissions');

  const rawGrade = String(req.body.grade || '').trim().replace(',', '.');
  const grade = rawGrade === '' ? null : Number(rawGrade);
  if (grade !== null && (!Number.isFinite(grade) || grade < 0 || grade > 10)) {
    return res.redirect(`/submissions/${submission.id}?error=${encodeURIComponent('La nota ha d’estar entre 0 i 10.')}`);
  }
  const feedback = String(req.body.feedback || '').trim();

  if (grade === null) {
    await db.prepare('UPDATE submissions SET grade = NULL, feedback = ?, graded_at = NULL, graded_by = NULL WHERE id = ?')
      .run(feedback, submission.id);
  } else {
    await db.prepare("UPDATE submissions SET grade = ?, feedback = ?, graded_at = datetime('now'), graded_by = ? WHERE id = ?")
      .run(grade, feedback, req.user.id, submission.id);
  }
  res.redirect(`/submissions/${submission.id}?notice=${encodeURIComponent('Avaluació desada.')}`);
});

router.get('/file/:id', async (req, res) => {
  const submission = await getSubmission(req.params.id, req.user);
  if (!submission || !submission.file_path) {
    return res.redirect('/submissions?error=' + encodeURIComponent('Fitxer no disponible.'));
  }
  const sent = await sendUpload(submission.file_path, submission.file_mime, submission.file_name || 'lliurament', res);
  if (!sent) return res.redirect('/submissions?error=' + encodeURIComponent('El fitxer ja no existeix.'));
});

router.post('/:id/delete', async (req, res) => {
  const submission = await getSubmission(req.params.id, req.user);
  if (!submission || req.user.role !== 'student') return res.redirect('/submissions');
  if (submission.file_path) await deleteUpload(submission.file_path);
  await db.prepare('DELETE FROM submissions WHERE id = ?').run(submission.id);
  res.redirect('/submissions?notice=' + encodeURIComponent('Lliurament eliminat.'));
});

module.exports = router;
