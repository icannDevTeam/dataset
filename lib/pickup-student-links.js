/**
 * lib/pickup-student-links.js
 *
 * Resolves temporary student IDs (tmp-...) on pickup onboarding forms into
 * real roster IDs (or deterministic pilot-* synthetic IDs) AT APPROVAL TIME,
 * and guarantees that every referenced student has a resolvable doc in BOTH
 * `tenants/{tid}/students` and legacy root `students`.
 *
 * Why: parents can type students in free-text instead of picking from the
 * roster. The submit flow stores those rows with tmp-* tokens. If approval
 * keeps the tokens, chaperone docs carry authorizedStudentIds that no tablet
 * can resolve — the pole iPads then display the raw `tmp-...` string instead
 * of a student name (pilot incident 2026-07-21, DEPINA / Pole 5).
 *
 * The synthetic ID algorithm intentionally matches
 * backend/scripts/repair_pickup_tmp_student_links.py (`pilot-` + sha1[:12] of
 * "NAME|HOMEROOM|GRADE") so approval-time resolution and after-the-fact
 * repairs converge on the same IDs.
 */
const crypto = require('crypto');

function normalizeName(s) {
  let x = String(s || '').toUpperCase().trim();
  x = x.replace(/\s*\([^)]*\)/g, ''); // drop parenthetical nicknames
  x = x.replace(/[^A-Z0-9 ]+/g, ' ');
  x = x.replace(/\s+/g, ' ').trim();
  return x;
}

function isTmpId(v) {
  return !!v && String(v).toLowerCase().startsWith('tmp-');
}

function rowStudentId(row) {
  for (const key of ['id', 'studentId', 'binusId']) {
    if (row && row[key]) return String(row[key]);
  }
  return null;
}

function syntheticStudentId(name, homeroom, grade) {
  const base = `${normalizeName(name)}|${String(homeroom || '').trim().toUpperCase()}|${String(grade || '').trim().toUpperCase()}`;
  const digest = crypto.createHash('sha1').update(base, 'utf8').digest('hex').slice(0, 12);
  return `pilot-${digest}`;
}

// Extract grade ('1'…'12', or 'EY') from a homeroom string like '4A', 'EY2'.
function gradeFromHomeroom(hr) {
  if (!hr) return null;
  const s = String(hr).trim().toUpperCase();
  if (s.startsWith('EY')) return 'EY';
  const m = s.match(/^(\d{1,2})/);
  return m ? m[1] : null;
}

// EY classes first, then everything else in insertion order.
function sortEyFirst(values) {
  return [...values].sort((a, b) => {
    const ae = String(a).toUpperCase().startsWith('EY') ? 0 : 1;
    const be = String(b).toUpperCase().startsWith('EY') ? 0 : 1;
    return ae - be;
  });
}

/**
 * Build a normalized-name → candidates index over BOTH student collections.
 * Only called when a form actually contains tmp-* rows (rare admin action).
 */
async function indexStudentsByName(db, tid) {
  const out = new Map();
  const seen = new Set();
  const addSnap = (snap) => {
    snap.forEach((d) => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      const data = d.data() || {};
      const key = normalizeName(data.name || data.fullName || data.studentName || '');
      if (!key) return;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ id: d.id, data });
    });
  };
  try { addSnap(await db.collection('students').get()); } catch (e) { console.error('[student-links] root roster scan', e.message); }
  try { addSnap(await db.collection(`tenants/${tid}/students`).get()); } catch (e) { console.error('[student-links] tenant roster scan', e.message); }
  return out;
}

function bestMatch(candidates, homeroom) {
  if (!candidates || candidates.length === 0) return null;
  const hr = String(homeroom || '').trim().toUpperCase();
  if (hr) {
    const exact = candidates.filter((c) => {
      const chr = String(c.data.homeroom || c.data.className || '').trim().toUpperCase();
      return chr === hr;
    });
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null; // ambiguous
  }
  if (candidates.length === 1) return candidates[0];
  return null; // ambiguous
}

/**
 * Ensure a student doc exists in BOTH tenant + root paths for every resolved
 * (non-tmp) student row. Idempotent — never overwrites existing docs.
 */
async function ensureStudentDocs(db, tid, students) {
  const now = new Date().toISOString();
  for (const row of students || []) {
    if (!row || typeof row !== 'object') continue;
    const sid = rowStudentId(row);
    if (!sid || isTmpId(sid)) continue;
    const rawName = String(row.name || row.studentName || row.firstName || '').trim();
    const fullName = rawName.replace(/\s*\([^)]*\)/g, '').trim() || rawName;
    if (!fullName) continue;
    const homeroom = String(row.homeroom || row.className || '').trim();
    const grade = String(row.grade || row.gradeSelection || '').trim() || gradeFromHomeroom(homeroom);
    const payload = {
      id: sid,
      studentId: sid,
      name: fullName,
      fullName,
      studentName: fullName,
      homeroom,
      className: homeroom,
      grade: grade || null,
      gradeSelection: grade || null,
      tenantId: tid,
      source: 'pickup-approve',
      updatedAt: now,
    };
    for (const path of [`tenants/${tid}/students/${sid}`, `students/${sid}`]) {
      try {
        const ref = db.doc(path);
        const snap = await ref.get();
        if (!snap.exists) await ref.set(payload);
      } catch (e) {
        console.error('[student-links] ensure student doc', path, e.message);
      }
    }
  }
}

/**
 * Resolve every tmp-* student row on an onboarding record.
 *
 * - Maps tmp-* → real roster ID (exact normalized-name + homeroom match) or
 *   deterministic pilot-* synthetic ID.
 * - Rewrites `students[]` and every chaperone's authorizedStudentIds /
 *   studentIds / authorizedFor arrays.
 * - Persists the patched arrays back onto the onboarding doc (tenant + root
 *   mirror) so re-reads never see tmp tokens again.
 * - Creates missing student docs in both students collections.
 *
 * Returns the patched record object (same reference shape as `rec`).
 */
async function resolveStudentLinks({ db, tid, rec, recRef }) {
  const students = Array.isArray(rec.students) ? rec.students : [];
  const hasTmp = students.some((row) => row && isTmpId(rowStudentId(row)));

  if (!hasTmp) {
    // Nothing to remap — still make sure every referenced student resolves.
    await ensureStudentDocs(db, tid, students);
    return rec;
  }

  const index = await indexStudentsByName(db, tid);
  const idMap = {};
  for (const row of students) {
    if (!row || typeof row !== 'object') continue;
    const oldId = rowStudentId(row);
    if (!isTmpId(oldId)) continue;
    const name = String(row.name || row.studentName || row.firstName || '');
    const homeroom = String(row.homeroom || row.className || '');
    const grade = String(row.grade || row.gradeSelection || '');
    const match = bestMatch(index.get(normalizeName(name)) || [], homeroom);
    idMap[oldId] = match ? match.id : syntheticStudentId(name, homeroom, grade);
    console.log(`[student-links] ${oldId} -> ${idMap[oldId]} (${name} / ${homeroom})${match ? '' : ' [synthetic]'}`);
  }

  const students2 = students.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const row2 = { ...row };
    for (const key of ['id', 'studentId', 'binusId']) {
      if (row2[key] && idMap[String(row2[key])]) row2[key] = idMap[String(row2[key])];
    }
    return row2;
  });

  const chaperones2 = (Array.isArray(rec.chaperones) ? rec.chaperones : []).map((c) => {
    if (!c || typeof c !== 'object') return c;
    const c2 = { ...c };
    for (const key of ['authorizedStudentIds', 'studentIds', 'authorizedFor']) {
      if (Array.isArray(c2[key])) c2[key] = c2[key].map((x) => idMap[String(x)] || x);
    }
    return c2;
  });

  const patch = { students: students2, chaperones: chaperones2 };
  await recRef.set(patch, { merge: true });

  // Root mirror (legacy dual-read). Full copy if the mirror doesn't exist yet.
  try {
    const rootRef = db.doc(`pickup_onboarding/${recRef.id}`);
    const rootSnap = await rootRef.get();
    await rootRef.set(rootSnap.exists ? patch : { ...rec, ...patch }, { merge: true });
  } catch (e) {
    console.error('[student-links] root form mirror', e.message);
  }

  await ensureStudentDocs(db, tid, students2);
  return { ...rec, ...patch };
}

module.exports = {
  normalizeName,
  isTmpId,
  syntheticStudentId,
  gradeFromHomeroom,
  sortEyFirst,
  resolveStudentLinks,
  ensureStudentDocs,
};
