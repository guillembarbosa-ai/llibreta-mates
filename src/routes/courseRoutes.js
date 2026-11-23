'use strict';

const express = require('express');
const { requireAuth, requireTeacher } = require('../auth');
const {
  currentYear, setCurrentYear, listYears, yearStats, createYear, deleteYear,
} = require('../courses');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireTeacher, async (req, res) => {
  // No s'anomena `years` perquè el capçal comú fa servir aquest nom per a la llista de cursos del desplegable.
  const yearRows = await Promise.all((await listYears()).map(async (year) => ({
    year,
    active: year === (await currentYear()),
    stats: await yearStats(year, req.user.id),
  })));
  res.render('courses', {
    title: 'Cursos escolars',
    subtitle: 'Separa la feina de cada curs per no barrejar grups, sessions ni notes.',
    yearRows,
    currentYear: await currentYear(),
    suggestedYear: `${Number((await currentYear()).slice(0, 4)) + 1}-${Number((await currentYear()).slice(5)) + 1}`,
  });
});

router.post('/switch', requireTeacher, async (req, res) => {
  const year = String(req.body.year || '').trim();
  if (!(await listYears()).includes(year)) {
    return res.redirect('/courses?error=' + encodeURIComponent('Curs no vàlid.'));
  }
  await setCurrentYear(year);
  res.redirect(`/?notice=${encodeURIComponent(`Ara estàs al curs ${year}.`)}`);
});

router.post('/create', requireTeacher, async (req, res) => {
  const year = String(req.body.year || '').trim();
  try {
    const result = await createYear({
      year,
      teacherId: req.user.id,
      copyTimetable: req.body.copy_timetable === 'on',
      copyActivities: req.body.copy_activities === 'on',
    });
    const details = [];
    if (result.classes) details.push(`${result.classes} grups`);
    if (result.entries) details.push(`${result.entries} franges`);
    if (result.activities) details.push(`${result.activities} activitats`);
    const notice = `Curs ${year} creat${details.length ? ' (' + details.join(', ') + ')' : ''}.`;
    res.redirect(`/?notice=${encodeURIComponent(notice)}`);
  } catch (error) {
    res.redirect('/courses?error=' + encodeURIComponent(error.message));
  }
});

router.post('/delete', requireTeacher, async (req, res) => {
  const year = String(req.body.year || '').trim();
  try {
    await deleteYear(year, req.user.id);
    res.redirect(`/courses?notice=${encodeURIComponent(`Curs ${year} eliminat.`)}`);
  } catch (error) {
    res.redirect('/courses?error=' + encodeURIComponent(error.message));
  }
});

module.exports = router;
