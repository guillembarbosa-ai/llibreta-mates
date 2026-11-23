export const GROUP_COLORS = [
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

export function colorOf(key) {
  return GROUP_COLORS.find((item) => item.key === key) || GROUP_COLORS[0];
}

export function nextColor(count) {
  return GROUP_COLORS[Math.max(0, count) % GROUP_COLORS.length].key;
}
