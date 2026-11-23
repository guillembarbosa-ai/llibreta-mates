'use strict';

// Paleta de colors per als grups. Cada color té un fons, una vora i un text llegibles.
const GROUP_COLORS = [
  { key: 'indigo', label: 'Indigo', bg: '#eef2ff', border: '#a5b4fc', text: '#3730a3' },
  { key: 'blue', label: 'Blau', bg: '#eff6ff', border: '#93c5fd', text: '#1e40af' },
  { key: 'teal', label: 'Verd blau', bg: '#f0fdfa', border: '#5eead4', text: '#0f766e' },
  { key: 'green', label: 'Verd', bg: '#f0fdf4', border: '#86efac', text: '#166534' },
  { key: 'amber', label: 'Ambre', bg: '#fffbeb', border: '#fcd34d', text: '#92400e' },
  { key: 'orange', label: 'Taronja', bg: '#fff7ed', border: '#fdba74', text: '#9a3412' },
  { key: 'rose', label: 'Rosa', bg: '#fff1f2', border: '#fda4af', text: '#9f1239' },
  { key: 'purple', label: 'Lila', bg: '#faf5ff', border: '#d8b4fe', text: '#6b21a8' },
  { key: 'slate', label: 'Gris', bg: '#f8fafc', border: '#cbd5e1', text: '#475569' },
];

function isValidColor(key) {
  return GROUP_COLORS.some((item) => item.key === key);
}

function colorOf(key) {
  return GROUP_COLORS.find((item) => item.key === key) || GROUP_COLORS[0];
}

/** Estil inline per a un xip del grup (fons, vora i text). */
function classColorStyle(key) {
  if (!key) return '';
  const color = colorOf(key);
  return `background:${color.bg};border-color:${color.border};color:${color.text}`;
}

/** Estil per a una casella de l'horari: només la vora i un fons molt clar. */
function classCellStyle(key) {
  if (!key) return '';
  const color = colorOf(key);
  return `background:${color.bg};border-left:4px solid ${color.border}`;
}

/** Color següent de la paleta, repartint els grups de manera equilibrada. */
function nextColor(count) {
  return GROUP_COLORS[Math.max(0, count) % GROUP_COLORS.length].key;
}

module.exports = { GROUP_COLORS, isValidColor, colorOf, classColorStyle, classCellStyle, nextColor };
