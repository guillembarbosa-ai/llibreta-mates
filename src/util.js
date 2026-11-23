'use strict';

const MONTHS = ['gen', 'feb', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'des'];

function formatDate(value) {
  if (!value) return '—';
  //Les dates de la base són ISO o "YYYY-MM-DD HH:MM:SS" en UTC
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value);
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] || ''} ${match[1]}`.trim();
}

function formatDateTime(value) {
  if (!value) return '—';
  const time = String(value).match(/T?(\d{2}):(\d{2})/);
  const date = formatDate(value);
  return time ? `${date}, ${time[1]}:${time[2]}` : date;
}

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseTags(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

function statusLabel(status) {
  return {
    planificada: 'Planificada',
    en_curs: 'En curs',
    finalitzada: 'Finalitzada',
  }[status] || status || '—';
}

function difficultyLabel(level) {
  return { baixa: 'Fàcil', mitjana: 'Mitjana', alta: 'Difícil' }[level] || level || '—';
}

module.exports = {
  formatDate,
  formatDateTime,
  formatFileSize,
  parseTags,
  initials,
  statusLabel,
  difficultyLabel,
};
