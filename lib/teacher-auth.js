function normalizeClassCode(value) {
  return String(value || '').trim().toUpperCase();
}

function sanitizeClassScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes
    .map(normalizeClassCode)
    .filter(Boolean)
    .slice(0, 50))];
}

function isTeacherEmail(email, teacherEmailDomain) {
  const domain = String(teacherEmailDomain || '').toLowerCase().trim();
  if (!domain) return false;
  return String(email || '').toLowerCase().trim().endsWith(`@${domain}`);
}

function normalizeClassSet(values) {
  return new Set((values || []).map(normalizeClassCode).filter(Boolean));
}

function classesIntersect(left, right) {
  const leftSet = normalizeClassSet(left);
  const rightSet = normalizeClassSet(right);
  for (const cls of leftSet) {
    if (rightSet.has(cls)) return true;
  }
  return false;
}

module.exports = {
  sanitizeClassScopes,
  isTeacherEmail,
  normalizeClassSet,
  classesIntersect,
};
