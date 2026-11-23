'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { currentYear, currentClassId } = require('../courses');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  if (req.user.role === 'teacher') return renderTeacherDashboard(req, res);
  return renderStudentDashboard(req, res);
});

async function renderTeacherDashboard(req, res) {
  const year = await currentYear();
  const active = await currentClassId(req.user.id);
  if (!active) return renderTeacherStart(req, res, year);

  // El taulell es deixa buit de moment; només es mostra el grup escollit.
  const classRow = await db.prepare('SELECT name FROM classes WHERE id = ?').get(active);
  res.render('dashboard-blank', {
    title: 'Taulell',
    subtitle: classRow ? `Grup ${classRow.name} · curs ${year}` : `Curs ${year}`,
  });
}

async function renderTeacherStart(req, res, year) {
  const groups = await db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count
    FROM classes c WHERE c.teacher_id = ? AND c.school_year = ? ORDER BY c.name ASC
  `).all(req.user.id, year);

  res.render('teacher-start', {
    title: 'Principal',
    subtitle: `Curs ${year} · tria una classe per continuar.`,
    groups,
  });
}

async function renderStudentDashboard(req, res) {
  const userId = req.user.id;
  const year = await currentYear();

  const stats = {
    classes: Number((await db.prepare(`
      SELECT COUNT(*) AS n FROM enrollments e JOIN classes c ON c.id = e.class_id
      WHERE e.student_id = ? AND c.school_year = ?
    `).get(userId, year)).n),
    pending: Number((await db.prepare(`
      SELECT COUNT(*) AS n FROM assignments asg
      JOIN sessions s ON s.id = asg.session_id
      JOIN enrollments e ON e.class_id = s.class_id AND e.student_id = ?
      LEFT JOIN submissions sub ON sub.assignment_id = asg.id AND sub.student_id = ?
      WHERE s.school_year = ? AND sub.id IS NULL
    `).get(userId, userId, year)).n),
    submitted: Number((await db.prepare(`
      SELECT COUNT(*) AS n FROM submissions sub
      JOIN assignments asg ON asg.id = sub.assignment_id
      JOIN sessions s ON s.id = asg.session_id
      WHERE sub.student_id = ? AND s.school_year = ? AND sub.submitted_at IS NOT NULL
    `).get(userId, year)).n),
    graded: Number((await db.prepare(`
      SELECT COUNT(*) AS n FROM submissions sub
      JOIN assignments asg ON asg.id = sub.assignment_id
      JOIN sessions s ON s.id = asg.session_id
      WHERE sub.student_id = ? AND s.school_year = ? AND sub.grade IS NOT NULL
    `).get(userId, year)).n),
  };

  const pending = await db.prepare(`
    SELECT asg.id AS assignment_id, asg.due_at, asg.instructions,
           a.title AS activity_title, a.subject, a.difficulty,
           s.title AS session_title, c.name AS class_name, c.color AS class_color
    FROM assignments asg
    JOIN activities a ON a.id = asg.activity_id
    JOIN sessions s ON s.id = asg.session_id
    JOIN classes c ON c.id = s.class_id
    JOIN enrollments e ON e.class_id = c.id AND e.student_id = ?
    LEFT JOIN submissions sub ON sub.assignment_id = asg.id AND sub.student_id = ?
    WHERE sub.id IS NULL AND s.school_year = ?
    ORDER BY (asg.due_at IS NULL), asg.due_at ASC, asg.id ASC LIMIT 6
  `).all(userId, userId, year);

  const grades = await db.prepare(`
    SELECT sub.id, sub.grade, sub.graded_at, a.title AS activity_title, c.name AS class_name, c.color AS class_color
    FROM submissions sub
    JOIN assignments asg ON asg.id = sub.assignment_id
    JOIN activities a ON a.id = asg.activity_id
    JOIN sessions s ON s.id = asg.session_id
    JOIN classes c ON c.id = s.class_id
    WHERE sub.student_id = ? AND s.school_year = ? AND sub.grade IS NOT NULL
    ORDER BY sub.graded_at DESC, sub.id DESC LIMIT 5
  `).all(userId, year);

  res.render('dashboard-student', {
    title: 'Tauler',
    subtitle: `Curs ${year} · les teves tasques i els teus resultats.`,
    stats, pending, grades,
  });
}

module.exports = router;
