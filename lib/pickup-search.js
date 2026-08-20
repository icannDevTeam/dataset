function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function tokenizeSearchText(value) {
  const norm = normalizeSearchText(value);
  return norm.match(/[a-z0-9]+/g) || [];
}

function uniqueLimited(values, maxItems) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const t = String(v || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildPrefixesFromTokens(tokens, { minPrefix = 2, maxPrefix = 12 } = {}) {
  const out = [];
  for (const tokenRaw of tokens) {
    const token = normalizeSearchText(tokenRaw);
    if (!token) continue;
    if (token.length <= maxPrefix) out.push(token);
    const stop = Math.min(token.length, maxPrefix);
    for (let i = minPrefix; i <= stop; i += 1) {
      out.push(token.slice(0, i));
    }
  }
  return uniqueLimited(out, 256);
}

function collectOnboardingSearchFields(record) {
  return [
    record?.id,
    record?.formNumber,
    record?.guardian?.name,
    record?.guardian?.email,
    record?.guardian?.phone,
    ...(record?.students || []).flatMap((s) => [
      s?.id,
      s?.studentId,
      s?.name,
      s?.firstName,
      s?.nickname,
      s?.homeroom,
      s?.className,
      s?.grade,
      s?.gradeSelection,
    ]),
    ...(record?.chaperones || []).flatMap((c) => [
      c?.name,
      c?.relation,
      c?.relationship,
      c?.email,
      c?.phone,
      c?.idNumber,
    ]),
  ].filter(Boolean);
}

function buildOnboardingSearchPrefixes(record) {
  const fields = collectOnboardingSearchFields(record);
  const tokens = fields.flatMap((v) => tokenizeSearchText(v));
  return buildPrefixesFromTokens(tokens);
}

function buildSearchTermsFromQuery(q) {
  const tokens = tokenizeSearchText(q);
  if (tokens.length === 0) return [];
  const out = [];
  const joined = normalizeSearchText(q).replace(/\s+/g, ' ');
  if (joined.length >= 2) out.push(joined.slice(0, 12));
  tokens.forEach((t) => {
    if (t.length >= 2) out.push(t.slice(0, 12));
  });
  return uniqueLimited(out, 8).sort((a, b) => b.length - a.length);
}

module.exports = {
  normalizeSearchText,
  tokenizeSearchText,
  buildOnboardingSearchPrefixes,
  buildSearchTermsFromQuery,
};
