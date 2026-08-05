function normalizeHomeroom(value) {
  const s = String(value || '').trim().toUpperCase();
  if (!s) return '';
  return s.replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
}

function deriveGradeBucket(input = {}) {
  const explicit = normalizeHomeroom(input.gradeSelection || input.grade || input.gradeCode || '');
  if (explicit === 'EY') {
    const hrFromEy = normalizeHomeroom(input.className || input.homeroom || '');
    if (/^EY[1-3]$/.test(hrFromEy)) return hrFromEy;
    return 'EY';
  }
  if (/^EY[1-3]$/.test(explicit)) return explicit;
  if (/^[1-9][0-9]?$/.test(explicit)) return explicit;

  const hr = normalizeHomeroom(input.className || input.homeroom || '');
  if (/^EY[1-3]$/.test(hr)) return hr;
  if (hr === 'EY') return 'EY';

  const m = hr.match(/^(\d{1,2})/);
  if (m) return m[1];
  return 'UNASSIGNED';
}

function normalizeClassLabel(input = {}) {
  const hr = normalizeHomeroom(input.className || input.homeroom || '');
  if (hr) return hr;
  const g = deriveGradeBucket(input);
  return g === 'UNASSIGNED' ? 'UNASSIGNED' : g;
}

function compareGradeBucket(a, b) {
  const rank = (v) => {
    const s = String(v || '').toUpperCase();
    if (s === 'EY1') return 1;
    if (s === 'EY2') return 2;
    if (s === 'EY3') return 3;
    if (s === 'EY') return 4;
    if (/^\d{1,2}$/.test(s)) return 100 + Number(s);
    if (s === 'UNASSIGNED') return 999;
    return 900;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return String(a || '').localeCompare(String(b || ''));
}

function splitRowsByGrade(rows = [], gradeGetter) {
  const buckets = {
    EY1: [],
    EY2: [],
    EY3: [],
    '1': [],
    '2': [],
    '3': [],
    '4': [],
    '5': [],
    UNASSIGNED: [],
  };

  rows.forEach((row) => {
    const grade = String(gradeGetter(row) || 'UNASSIGNED').toUpperCase();
    if (buckets[grade]) buckets[grade].push(row);
    else buckets.UNASSIGNED.push(row);
  });

  return buckets;
}

module.exports = {
  normalizeHomeroom,
  deriveGradeBucket,
  normalizeClassLabel,
  compareGradeBucket,
  splitRowsByGrade,
};
