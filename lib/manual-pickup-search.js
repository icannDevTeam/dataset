function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function searchScore(student, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (query.length < 2) return null;
  const id = student.searchId || normalizeSearchText(student.studentId || student.id);
  const name = student.searchName || normalizeSearchText(student.name);
  const homeroom = student.searchHomeroom || normalizeSearchText(student.homeroom);
  const tokens = student.searchTokens || name.split(' ').filter(Boolean);
  if (id === query) return 0;
  if (name === query) return 1;
  if (id.startsWith(query)) return 2;
  if (name.startsWith(query)) return 3;
  if (tokens.some((token) => token.startsWith(query))) return 4;
  if (homeroom === query || homeroom.startsWith(query)) return 5;
  if ((student.searchKey || '').includes(query)) return 6;
  return null;
}

function searchStudents(students, query) {
  return (students || [])
    .map((student) => ({ student, score: searchScore(student, query) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => left.score - right.score
      || (left.student.searchName || left.student.name).localeCompare(right.student.searchName || right.student.name))
    .map((entry) => entry.student);
}

module.exports = { normalizeSearchText, searchStudents };