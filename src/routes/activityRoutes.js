'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireTeacher } = require('../auth');
const { escapeLike } = require('../security');
const { currentYear } = require('../courses');

const router = express.Router();
router.use(requireAuth);

function parseForm(body) {
  const tags = String(body.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    subject: String(body.subject || '').trim(),
    level: String(body.level || '').trim(),
    activity_type: String(body.activity_type || '').trim(),
    difficulty: ['baixa', 'mitjana', 'alta'].includes(body.difficulty) ? body.difficulty : 'mitjana',
    duration_min: body.duration_min === '' || body.duration_min == null ? null : Math.max(1, Number(body.duration_min) || 1),
    objectives: String(body.objectives || '').trim(),
    tags: JSON.stringify(tags),
  };
}

async function getActivity(id, user) {
  const activity = await db.prepare('SELECT * FROM activities WHERE id = ? AND school_year = ?')
    .get(id, await currentYear());
  if (!activity) return null;
  if (user.role === 'teacher') return Number(activity.teacher_id) === user.id ? activity : null;
  const allowed = await db.prepare(`
    SELECT 1 FROM enrollments e
    JOIN classes c ON c.id = e.class_id
    WHERE e.student_id = ? AND c.teacher_id = ?
  `).get(user.id, Number(activity.teacher_id));
  return allowed ? activity : null;
}

router.get('/', async (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim(),
    subject: String(req.query.subject || '').trim(),
    level: String(req.query.level || '').trim(),
    activity_type: String(req.query.activity_type || '').trim(),
    difficulty: String(req.query.difficulty || '').trim(),
  };

  const conditions = [];
  const params = [];
  conditions.push('a.school_year = ?');
  params.push(await currentYear());
  if (req.user.role === 'teacher') {
    conditions.push('a.teacher_id = ?');
    params.push(req.user.id);
  } else {
    conditions.push(`EXISTS (
      SELECT 1 FROM enrollments e JOIN classes c ON c.id = e.class_id
      WHERE e.student_id = ? AND c.teacher_id = a.teacher_id
    )`);
    params.push(req.user.id);
  }
  if (filters.q) {
    conditions.push('(a.title LIKE ? ESCAPE \'\\\' OR a.description LIKE ? ESCAPE \'\\\' OR a.tags LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(filters.q)}%`;
    params.push(like, like, like);
  }
  for (const key of ['subject', 'level', 'activity_type', 'difficulty']) {
    if (filters[key]) {
      conditions.push(`a.${key} = ?`);
      params.push(filters[key]);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const activities = await db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM assignments asg WHERE asg.activity_id = a.id) AS usage_count
    FROM activities a ${where}
    ORDER BY a.updated_at DESC, a.id DESC LIMIT 300
  `).all(...params);

  const filterValues = await db.prepare(`
    SELECT DISTINCT subject, level, activity_type FROM activities
    WHERE school_year = ? ${req.user.role === 'teacher' ? 'AND teacher_id = ?' : ''}
    ORDER BY subject, level
  `).all(...(req.user.role === 'teacher' ? [await currentYear(), req.user.id] : [await currentYear()]));

  res.render('activities', {
    title: 'Biblioteca d’activitats',
    subtitle: req.user.role === 'teacher' ? 'Organitza i reutilitza les teves activitats.' : 'Activitats dels teus professors.',
    activities, filters, filterValues,
  });
});

router.get('/new', requireTeacher, (req, res) => {
  res.render('activity-form', { title: 'Nova activitat', activity: null, action: '/activities' });
});

router.post('/', requireTeacher, async (req, res) => {
  const data = parseForm(req.body);
  if (!data.title) return res.status(400).render('activity-form', {
    title: 'Nova activitat', activity: req.body, action: '/activities', error: 'El títol és obligatori.',
  });
  await db.prepare(`
    INSERT INTO activities (teacher_id, school_year, title, description, subject, level, activity_type,
                            difficulty, duration_min, objectives, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, await currentYear(), data.title, data.description, data.subject, data.level,
    data.activity_type, data.difficulty, data.duration_min, data.objectives, data.tags);
  res.redirect('/activities?notice=' + encodeURIComponent('Activitat creada.'));
});

router.get('/:id', async (req, res) => {
  const activity = await getActivity(req.params.id, req.user);
  if (!activity) return res.redirect('/activities?error=' + encodeURIComponent('Activitat no trobada.'));

  const usage = await db.prepare(`
    SELECT s.id AS session_id, s.title AS session_title, s.session_date, c.name AS class_name, c.color AS class_color
    FROM assignments asg
    JOIN sessions s ON s.id = asg.session_id
    JOIN classes c ON c.id = s.class_id
    WHERE asg.activity_id = ? ORDER BY s.session_date DESC
  `).all(activity.id);

  res.render('activity-detail', { title: activity.title, activity, usage });
});

router.get('/:id/edit', requireTeacher, async (req, res) => {
  const activity = await getActivity(req.params.id, req.user);
  if (!activity) return res.redirect('/activities');
  res.render('activity-form', {
    title: 'Editar activitat', activity, action: `/activities/${Number(activity.id)}`,
  });
});

router.post('/:id/edit', requireTeacher, async (req, res) => {
  const activity = await getActivity(req.params.id, req.user);
  if (!activity) return res.redirect('/activities');
  const data = parseForm(req.body);
  if (!data.title) return res.status(400).render('activity-form', {
    title: 'Editar activitat', activity: { ...activity, ...req.body },
    action: `/activities/${Number(activity.id)}`, error: 'El títol és obligatori.',
  });
  await db.prepare(`
    UPDATE activities SET title = ?, description = ?, subject = ?, level = ?, activity_type = ?,
      difficulty = ?, duration_min = ?, objectives = ?, tags = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(data.title, data.description, data.subject, data.level, data.activity_type,
    data.difficulty, data.duration_min, data.objectives, data.tags, activity.id);
  res.redirect(`/activities/${Number(activity.id)}?notice=${encodeURIComponent('Activitat actualitzada.')}`);
});

router.post('/:id/delete', requireTeacher, async (req, res) => {
  const activity = await getActivity(req.params.id, req.user);
  if (!activity) return res.redirect('/activities');
  await db.prepare('DELETE FROM activities WHERE id = ?').run(activity.id);
  res.redirect('/activities?notice=' + encodeURIComponent('Activitat eliminada.'));
});

module.exports = router;
