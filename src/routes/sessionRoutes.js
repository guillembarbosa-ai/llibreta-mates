'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireTeacher } = require('../auth');
const { currentYear, currentClassId } = require('../courses');

const router = express.Router();
router.use(requireAuth);

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function getSession(id, user) {
  const session = await db.prepare(`
    SELECT s.*, c.name AS class_name, c.subject AS class_subject, c.color AS class_color
    FROM sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?
  `).get(id);
  if (!session || session.school_year !== await currentYear()) return null;
  if (user.role === 'teacher') {
    if (session.teacher_id !== user.id) return null;
    const active = await currentClassId(user.id);
    if (active && session.class_id !== active) return null;
    return session;
  }
  const enrolled = await db.prepare('SELECT 1 FROM enrollments WHERE class_id = ? AND student_id = ?')
    .get(session.class_id, user.id);
  return enrolled ? session : null;
}

async function teacherClasses(userId) {
  return await db.prepare('SELECT * FROM classes WHERE teacher_id = ? AND school_year = ? ORDER BY name ASC')
    .all(userId, await currentYear());
}

async function sessionActivities(sessionId, studentId = 0) {
  return await db.prepare(`
    SELECT asg.*, a.title, a.description, a.subject, a.difficulty, a.activity_type, a.duration_min,
      (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = asg.id) AS submission_count,
      (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = asg.id AND s.grade IS NOT NULL) AS graded_count,
      mine.id AS my_submission_id, mine.grade AS my_grade, mine.submitted_at AS my_submitted_at
    FROM assignments asg
    JOIN activities a ON a.id = asg.activity_id
    LEFT JOIN submissions mine ON mine.assignment_id = asg.id AND mine.student_id = ?
    WHERE asg.session_id = ? ORDER BY asg.position ASC, asg.id ASC
  `).all(studentId, sessionId);
}

router.get('/', async (req, res) => {
  const filters = {
    class_id: String(req.query.class_id || ''),
    status: String(req.query.status || ''),
  };
  const conditions = ['s.school_year = ?'];
  const params = [await currentYear()];

  if (req.user.role === 'teacher') {
    conditions.push('s.teacher_id = ?');
    params.push(req.user.id);
    const active = await currentClassId(req.user.id);
    if (active) {
      conditions.push('s.class_id = ?');
      params.push(active);
    }
  } else {
    conditions.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.class_id = s.class_id AND e.student_id = ?)');
    params.push(req.user.id);
  }
  if (filters.class_id && /^\d+$/.test(filters.class_id)) {
    conditions.push('s.class_id = ?');
    params.push(filters.class_id);
  }
  if (['planificada', 'en_curs', 'finalitzada'].includes(filters.status)) {
    conditions.push('s.status = ?');
    params.push(filters.status);
  }
  const sessions = await db.prepare(`
    SELECT s.*, c.name AS class_name, c.color AS class_color,
      (SELECT COUNT(*) FROM assignments a WHERE a.session_id = s.id) AS activity_count
    FROM sessions s JOIN classes c ON c.id = s.class_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.session_date DESC, s.id DESC LIMIT 300
  `).all(...params);

  const classes = req.user.role === 'teacher'
    ? await teacherClasses(req.user.id)
    : await db.prepare(`
        SELECT c.* FROM classes c JOIN enrollments e ON e.class_id = c.id
        WHERE e.student_id = ? AND c.school_year = ? ORDER BY c.name ASC
      `).all(req.user.id, await currentYear());

  res.render('sessions', {
    title: 'Sessions', subtitle: 'Planifica les classes i hi assigna activitats.',
    sessions, classes, filters,
  });
});

router.get('/new', requireTeacher, async (req, res) => {
  const classes = await teacherClasses(req.user.id);
  if (classes.length === 0) {
    return res.redirect('/classes?error=' + encodeURIComponent('Crea una classe abans de programar sessions.'));
  }
  const activities = await db.prepare('SELECT id, title, subject FROM activities WHERE teacher_id = ? AND school_year = ? ORDER BY title ASC')
    .all(req.user.id, await currentYear());
  res.render('session-form', {
    title: 'Nova sessió',
    session: null,
    classes, activities,
    action: '/sessions',
    selectedActivities: toArray(req.query.activity_id).map(String),
  });
});

router.post('/', requireTeacher, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const sessionDate = String(req.body.session_date || '').trim();
  const classId = Number(req.body.class_id);
  const owned = await db.prepare('SELECT id FROM classes WHERE id = ? AND teacher_id = ?').get(classId, req.user.id);

  if (!title || !sessionDate || !owned) {
    return res.status(400).render('session-form', {
      title: 'Nova sessió', session: req.body, classes: await teacherClasses(req.user.id),
      activities: await db.prepare('SELECT id, title, subject FROM activities WHERE teacher_id = ? AND school_year = ? ORDER BY title')
        .all(req.user.id, await currentYear()),
      action: '/sessions', selectedActivities: toArray(req.body.activity_ids).map(String),
      error: 'Cal indicar un títol, una data i una classe.',
    });
  }

  const result = await db.prepare(`
    INSERT INTO sessions (class_id, teacher_id, school_year, title, session_date, start_time, end_time, objectives, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(classId, req.user.id, await currentYear(), title, sessionDate,
    String(req.body.start_time || '').trim() || null,
    String(req.body.end_time || '').trim() || null,
    String(req.body.objectives || '').trim(), String(req.body.notes || '').trim(),
    ['planificada', 'en_curs', 'finalitzada'].includes(req.body.status) ? req.body.status : 'planificada');

  const sessionId = Number(result.lastInsertRowid);
  const insertAssignment = db.prepare(`
    INSERT OR IGNORE INTO assignments (session_id, activity_id, instructions, due_at, position)
    VALUES (?, ?, ?, ?, ?)
  `);
  let position = 0;
  for (const activityId of toArray(req.body.activity_ids)) {
    if (!/^\d+$/.test(String(activityId))) continue;
    const activity = await db.prepare('SELECT id FROM activities WHERE id = ? AND teacher_id = ? AND school_year = ?')
      .get(activityId, req.user.id, await currentYear());
    if (!activity) continue;
    await insertAssignment.run(sessionId, activity.id, '', null, position++);
  }

  res.redirect(`/sessions/${sessionId}?notice=${encodeURIComponent('Sessió creada.')}`);
});

router.get('/:id', async (req, res) => {
  const session = await getSession(req.params.id, req.user);
  if (!session) return res.redirect('/sessions?error=' + encodeURIComponent('Sessió no trobada.'));

  const activities = await sessionActivities(session.id, req.user.role === 'student' ? req.user.id : 0);
  const availableActivities = req.user.role === 'teacher'
    ? await db.prepare(`
        SELECT a.id, a.title, a.subject FROM activities a
        WHERE a.teacher_id = ? AND a.school_year = ? AND a.id NOT IN (SELECT activity_id FROM assignments WHERE session_id = ?)
        ORDER BY a.title ASC
      `).all(req.user.id, await currentYear(), session.id)
    : [];
  const students = await db.prepare(`
    SELECT u.id, u.name FROM users u JOIN enrollments e ON e.student_id = u.id
    WHERE e.class_id = ? ORDER BY u.name ASC
  `).all(session.class_id);

  res.render('session-detail', {
    title: session.title,
    subtitle: `${session.class_name} · ${formatSafeDate(session.session_date)}`,
    session, activities, availableActivities, students,
  });
});

function formatSafeDate(value) {
  return String(value || '').slice(0, 10);
}

router.get('/:id/edit', requireTeacher, async (req, res) => {
  const session = await getSession(req.params.id, req.user);
  if (!session) return res.redirect('/sessions');
  res.render('session-form', {
    title: 'Editar sessió', session,
    classes: await teacherClasses(req.user.id),
    activities: [], action: `/sessions/${session.id}/edit`, selectedActivities: [],
  });
});

router.post('/:id/edit', requireTeacher, async (req, res) => {
  const session = await getSession(req.params.id, req.user);
  if (!session) return res.redirect('/sessions');
  const title = String(req.body.title || '').trim();
  const sessionDate = String(req.body.session_date || '').trim();
  if (!title || !sessionDate) {
    return res.status(400).render('session-form', {
      title: 'Editar sessió', session: { ...session, ...req.body },
      classes: await teacherClasses(req.user.id), activities: [],
      action: `/sessions/${session.id}/edit`, selectedActivities: [],
      error: 'Cal indicar un títol i una data.',
    });
  }
  await db.prepare(`
    UPDATE sessions SET title = ?, session_date = ?, start_time = ?, end_time = ?,
      objectives = ?, notes = ?, status = ?
    WHERE id = ?
  `).run(title, sessionDate,
    String(req.body.start_time || '').trim() || null,
    String(req.body.end_time || '').trim() || null,
    String(req.body.objectives || '').trim(),
    String(req.body.notes || '').trim(),
    ['planificada', 'en_curs', 'finalitzada'].includes(req.body.status) ? req.body.status : session.status,
    session.id);
  res.redirect(`/sessions/${session.id}?notice=${encodeURIComponent('Sessió actualitzada.')}`);
});

router.post('/:id/status', requireTeacher, async (req, res) => {
  const session = await getSession(req.params.id, req.user);
  if (!session) return res.redirect('/sessions');
  const status = req.body.status;
  if (['planificada', 'en_curs', 'finalitzada'].includes(status)) {
    await db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, session.id);
  }
  res.redirect(`/sessions/${session.id}?notice=${encodeURIComponent('Estat actualitzat.')}`);
});

router.post('/:id/activities', requireTeacher, async (req, res) => {
  const session = await getSession(req.params.id, req.user);
  if (!session) return res.redirect('/sessions');
  const activityId = Number(req.body.activity_id);
  const activity = await db.prepare('SELECT id FROM activities WHERE id = ? AND teacher_id = ? AND school_year = ?')
    .get(activityId, req.user.id, await currentYear());
  if (!activity) return res.redirect(`/sessions/${session.id}?error=${encodeURIComponent('Activitat no vàlida.')}`);

  const dueAt = String(req.body.due_at || '').trim() || null;
  const position = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM assignments WHERE session_id = ?')
    .get(session.id)).next;
  await db.prepare(`
    INSERT OR IGNORE INTO assignments (session_id, activity_id, instructions, due_at, position)
    VALUES (?, ?, ?, ?, ?)
  `).run(session.id, activity.id, String(req.body.instructions || '').trim(), dueAt, position);
  res.redirect(`/sessions/${session.id}?notice=${encodeURIComponent('Activitat afegida a la sessió.')}`);
});

router.post('/:id/activities/remove', requireTeacher, async (req, res) => {
  const session = await getSession(req.params.id, req.user);
  if (!session) return res.redirect('/sessions');
  await db.prepare('DELETE FROM assignments WHERE id = ? AND session_id = ?').run(req.body.assignment_id, session.id);
  res.redirect(`/sessions/${session.id}?notice=${encodeURIComponent('Activitat eliminada de la sessió.')}`);
});

router.post('/:id/delete', requireTeacher, async (req, res) => {
  const session = await getSession(req.params.id, req.user);
  if (!session) return res.redirect('/sessions');
  await db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  res.redirect('/sessions?notice=' + encodeURIComponent('Sessió eliminada.'));
});

module.exports = router;
