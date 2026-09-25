function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
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
  // Score 6: word-boundary contains \u2014 query must start at a word boundary in
  // searchKey to avoid mid-word false positives (e.g. "gan" matching "kegan").
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp('(?:^| )' + escaped).test(student.searchKey || '')) return 6;
  // Score 7: fuzzy match \u2014 catches phonetic variants and spelling errors
  // (e.g. "ganaya" finding "ghanya"). Only for queries \u22654 chars; threshold
  // is 1 edit for 4-5 char queries, 2 edits for 6+ char queries.
  if (query.length >= 4) {
    const maxDist = query.length >= 6 ? 2 : 1;
    const allTokens = [...new Set([name, ...tokens])];
    if (allTokens.some((token) => Math.abs(token.length - query.length) <= maxDist
      && levenshtein(query, token) <= maxDist)) return 7;
  }
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