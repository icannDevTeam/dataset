#!/usr/bin/env node
/**
 * One-shot: backfill `gradeScopes: string[]` on every doc in
 * tenants/{tid}/terminals.
 *
 * Strategy:
 *   1. If the doc already has a non-empty gradeScopes array → leave it alone.
 *   2. If the script knows an explicit override for the doc id (below) → use it.
 *   3. Otherwise parse the legacy gradeLabel string.
 *
 * Run:  node scripts/backfill-terminal-grade-scopes.js [--tenant=binus-simprug]
 */
const admin = require('firebase-admin');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const tid = args.tenant || 'binus-simprug';

admin.initializeApp({
  credential: admin.credential.cert(
    require(path.join(__dirname, '..', '..', 'facial-attendance-binus-firebase-adminsdk.json'))
  ),
});
const db = admin.firestore();

function parseGradeLabel(label) {
  if (!label) return [];
  const s = String(label).trim().toLowerCase();
  if (!s || s === 'all' || s === 'shared' || s === 'any') return [];
  const range = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
  if (range) {
    const [a, b] = [parseInt(range[1], 10), parseInt(range[2], 10)].sort((x, y) => x - y);
    const out = [];
    for (let g = a; g <= b; g += 1) out.push(String(g));
    return out;
  }
  return [...s.matchAll(/\d+/g)].map((m) => m[0]);
}

// Known overrides (terminal id → canonical grade scopes).
const OVERRIDES = {
  '2dc4c6f35f89': ['1', '2', '3', '4', '5'], // PYP Lobby
  '875e8b213c76': [],                          // Basement Terminal (shared)
  'cf18e11f9d8e': ['5'],                       // "GRADE 5" (formerly MYP Tower)
  '472a2370ca48': ['EY1', 'EY2', 'EY3'],       // Pole 1 / Terminal 01 — all Early Years
  'f462250f7ca3': ['EY1', 'EY2', 'EY3'],       // Pole 1 / Terminal 02 — all Early Years
  '455b597cf22f': ['1', '2'],                  // Pole 2 / Terminal 03 — Grades 1-2
  'c318f11f62be': ['1', '2'],                  // Pole 2 / Terminal 04 — Grades 1-2
  'cf24a199e5b6': ['3'],                       // Pole 3 / Terminal 05 — Grade 3
  'ddbb94f15ae0': ['3'],                       // Pole 3 / Terminal 06 — Grade 3
  '5ecd40a48e49': ['4'],                       // Pole 4 / Terminal 07
  '0d847419cf16': ['4'],                       // Pole 4 / Terminal 08
  '30754945c9eb': ['5'],                       // Pole 5 / Terminal 09
  'ed53afa9b079': ['5'],                       // Pole 5 / Terminal 10
};

(async () => {
  const col = db.collection(`tenants/${tid}/terminals`);
  const snap = await col.get();
  console.log(`scanning ${snap.size} terminal docs in ${tid}/terminals`);
  for (const d of snap.docs) {
    const data = d.data() || {};
    if (Array.isArray(data.gradeScopes) && data.gradeScopes.length > 0) {
      console.log(`  skip   ${d.id}  ${data.name || ''}  (already has gradeScopes=${JSON.stringify(data.gradeScopes)})`);
      continue;
    }
    const override = OVERRIDES[d.id];
    const scopes = Array.isArray(override) ? override : parseGradeLabel(data.gradeLabel);
    await d.ref.update({ gradeScopes: scopes });
    console.log(`  update ${d.id}  ${data.name || ''}  → ${JSON.stringify(scopes)}`);
  }
  console.log('done.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
