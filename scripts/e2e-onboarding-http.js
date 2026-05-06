#!/usr/bin/env node
/**
 * Phase 3 end-to-end simulation — HTTP variant.
 *
 * Assumes `next dev` is running on http://127.0.0.1:3000.
 *
 *   node scripts/e2e-onboarding-http.js
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local'), override: false });

const path = require('path');
const crypto = require('crypto');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';

async function api(p, body, ip = '127.0.0.99') {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      'x-api-key': process.env.DASHBOARD_API_KEY || process.env.API_KEY || '',
    },
    body: JSON.stringify(body),
  });
  let body2 = null;
  try { body2 = await r.json(); } catch { body2 = await r.text(); }
  const headers = {};
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: r.status, body: body2, headers };
}

function tinyPngDataUrl() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
}

(async () => {
  const TID = `e2e-${Date.now().toString(36)}`;
  const SID = 'E2ESTU0001';

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 3 onboarding e2e simulation (HTTP)');
  console.log('  Base       :', BASE);
  console.log('  Test tenant:', TID);
  console.log('  Test sid   :', SID);
  console.log('═══════════════════════════════════════════════════════════\n');

  const { signPickupOnboardingToken } = require(path.join(__dirname, '..', 'lib', 'pickup-token'));
  const { initializeFirebase, getFirebaseStorage } = require(path.join(__dirname, '..', 'lib', 'firebase-admin'));
  const tenancy = require(path.join(__dirname, '..', 'lib', 'tenancy'));
  const admin = require('firebase-admin');

  initializeFirebase();
  const db = admin.firestore();

  // Seed
  await db.doc(`${tenancy.studentsPath(TID)}/${SID}`).set({
    name: 'E2E Test Student', homeroom: '4Z', photoUrl: null,
  });
  console.log('✓ seeded student', SID);

  const token = signPickupOnboardingToken({ tenantId: TID, studentId: SID });
  console.log('✓ signed token\n');

  let pass = 0, fail = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label} — ${detail || ''}`); fail++; }
  };

  // 1. Lookup miss → hit
  console.log('── Test 1: lookup cache ─────────────────────────────────');
  const r1a = await api('/api/pickup/onboarding/lookup', { token, studentId: SID });
  expect('200', r1a.status === 200, JSON.stringify(r1a.body));
  expect('name', r1a.body?.student?.name === 'E2E Test Student');
  expect('cache MISS', r1a.headers['x-cache'] === 'MISS');
  const r1b = await api('/api/pickup/onboarding/lookup', { token, studentId: SID });
  expect('cache HIT on 2nd call', r1b.headers['x-cache'] === 'HIT');
  expect('Cache-Control private', /private/.test(r1b.headers['cache-control'] || ''));

  // 2. Bad sid → 400
  console.log('\n── Test 2: bad sid → 400 ────────────────────────────────');
  const r2 = await api('/api/pickup/onboarding/lookup', { token, studentId: 'bad!' });
  expect('400', r2.status === 400);

  // 3. Bad token → 401
  console.log('\n── Test 3: bad token → 401 ──────────────────────────────');
  const r3 = await api('/api/pickup/onboarding/lookup', { token: 'garbage', studentId: SID });
  expect('401', r3.status === 401);

  // 4. Face upload
  console.log('\n── Test 4: face upload ──────────────────────────────────');
  const tempId = 'tmp-' + crypto.randomBytes(6).toString('hex');
  const r4a = await api('/api/pickup/onboarding/face', {
    token, tempId, photoIndex: 0, imageBase64: tinyPngDataUrl(),
  });
  expect('200', r4a.status === 200, JSON.stringify(r4a.body));
  expect('storage path tenants/<TID>/...',
    typeof r4a.body?.path === 'string' && r4a.body.path.startsWith(`tenants/${TID}/`));
  const r4b = await api('/api/pickup/onboarding/face', {
    token, tempId, photoIndex: 5, imageBase64: tinyPngDataUrl(),
  });
  expect('photoIndex 5 → 400', r4b.status === 400);
  const r4c = await api('/api/pickup/onboarding/face', {
    token, tempId, photoIndex: 0, imageBase64: 'data:image/gif;base64,xx',
  });
  expect('gif → 400', r4c.status === 400);
  const r4d = await api('/api/pickup/onboarding/face', {
    token, tempId: 'bad!!', photoIndex: 0, imageBase64: tinyPngDataUrl(),
  });
  expect('bad tempId → 400', r4d.status === 400);
  const facePath = r4a.body.path;

  // 5. Submit happy path
  console.log('\n── Test 5: submit happy ─────────────────────────────────');
  const submitBody = {
    token,
    guardianName: 'Jane Parent',
    guardianEmail: 'jane@example.com',
    guardianPhone: '+62-812-9999-0000',
    students: [{ id: SID, name: 'E2E Test Student', homeroom: '4Z' }],
    chaperones: [{
      tempId, name: 'Driver Bob', relation: 'driver',
      phone: '+62-812-1111-2222', idNumber: 'KTP-9999', email: '',
      authorizedStudentIds: [SID], facePaths: [facePath],
    }],
    consentSignature: 'Jane Parent',
  };
  const r5 = await api('/api/pickup/onboarding/submit', submitBody, '127.0.0.50');
  expect('200', r5.status === 200, JSON.stringify(r5.body));
  expect('formNumber PKP-YYYY-NNNNN', /^PKP-\d{4}-\d{5}$/.test(r5.body?.formNumber || ''));
  const formNumber1 = r5.body?.formNumber;
  const recordId1 = r5.body?.recordId;

  const lockSnap = await db.doc(`${tenancy.pickupStudentLocksPath(TID)}/${SID}`).get();
  expect('lock doc created', lockSnap.exists);
  expect('lock status=pending', (lockSnap.data() || {}).status === 'pending');
  expect('lock formNumber matches', (lockSnap.data() || {}).formNumber === formNumber1);

  // 6. Dedupe
  console.log('\n── Test 6: dedupe → 409 ─────────────────────────────────');
  const tempId2 = 'tmp-' + crypto.randomBytes(6).toString('hex');
  const r6face = await api('/api/pickup/onboarding/face', {
    token, tempId: tempId2, photoIndex: 0, imageBase64: tinyPngDataUrl(),
  }, '127.0.0.51');
  const submitBody2 = { ...submitBody };
  submitBody2.chaperones = [{ ...submitBody.chaperones[0], tempId: tempId2, facePaths: [r6face.body.path] }];
  const r6 = await api('/api/pickup/onboarding/submit', submitBody2, '127.0.0.51');
  expect('409', r6.status === 409, `got ${r6.status} ${JSON.stringify(r6.body)}`);
  expect('error code', r6.body?.error === 'student-already-registered');
  expect('conflict formNumber matches', r6.body?.conflicts?.[0]?.formNumber === formNumber1);
  expect('message mentions ACOP', /ACOP/i.test(r6.body?.message || ''));

  // 7. No faces
  console.log('\n── Test 7: no faces → 400 ───────────────────────────────');
  const submitBody3 = { ...submitBody };
  submitBody3.chaperones = [{ ...submitBody.chaperones[0], facePaths: [] }];
  const r7 = await api('/api/pickup/onboarding/submit', submitBody3, '127.0.0.52');
  expect('400', r7.status === 400);

  // 8. Too many chaperones
  console.log('\n── Test 8: >3 chaperones → 400 ──────────────────────────');
  const four = Array.from({ length: 4 }, () => submitBody.chaperones[0]);
  const r8 = await api('/api/pickup/onboarding/submit', { ...submitBody, chaperones: four }, '127.0.0.53');
  expect('400', r8.status === 400);

  // 9. Signature mismatch
  console.log('\n── Test 9: signature mismatch → 400 ─────────────────────');
  const r9 = await api('/api/pickup/onboarding/submit',
    { ...submitBody, consentSignature: 'Wrong Name' }, '127.0.0.54');
  expect('400', r9.status === 400);

  // 10. Reject releases lock + re-submit succeeds
  console.log('\n── Test 10: reject → re-submit ──────────────────────────');
  const r10reject = await api('/api/pickup/admin/reject',
    { recordId: recordId1, tenant: TID, reason: 'e2e simulation' }, '127.0.0.55');
  expect('reject 200', r10reject.status === 200, JSON.stringify(r10reject.body));
  const lock2 = await db.doc(`${tenancy.pickupStudentLocksPath(TID)}/${SID}`).get();
  expect('lock status=rejected', (lock2.data() || {}).status === 'rejected');

  const tempId3 = 'tmp-' + crypto.randomBytes(6).toString('hex');
  const r10face = await api('/api/pickup/onboarding/face', {
    token, tempId: tempId3, photoIndex: 0, imageBase64: tinyPngDataUrl(),
  }, '127.0.0.56');
  const submitBody4 = { ...submitBody };
  submitBody4.chaperones = [{ ...submitBody.chaperones[0], tempId: tempId3, facePaths: [r10face.body.path] }];
  const r10sub = await api('/api/pickup/onboarding/submit', submitBody4, '127.0.0.56');
  expect('re-submit 200', r10sub.status === 200, JSON.stringify(r10sub.body));
  expect('new formNumber',
    r10sub.body?.formNumber && r10sub.body.formNumber !== formNumber1);
  const recordId2 = r10sub.body?.recordId;

  // 11. Submit rate limit
  console.log('\n── Test 11: submit RL (5/hr) ────────────────────────────');
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await api('/api/pickup/onboarding/submit', { token: 'invalid' }, '127.0.0.77');
    if (r.status === 429) { saw429 = true; break; }
  }
  expect('429 within 8 calls', saw429);

  // ── Cleanup ─────────────────────────────────────────────────────
  console.log('\n── Cleanup ───────────────────────────────────────────────');
  const cleanups = [
    db.doc(`${tenancy.studentsPath(TID)}/${SID}`).delete(),
    db.doc(`${tenancy.pickupStudentLocksPath(TID)}/${SID}`).delete(),
    db.doc(tenancy.idAllocationsDoc('pickup-form-counter', TID)).delete(),
  ];
  const obSnap = await db.collection(tenancy.pickupOnboardingPath(TID)).get();
  obSnap.forEach((d) => cleanups.push(d.ref.delete()));
  await Promise.allSettled(cleanups);
  console.log(`  ✓ deleted ${cleanups.length} firestore docs`);
  try {
    const bucket = getFirebaseStorage().bucket();
    const [files] = await bucket.getFiles({ prefix: `tenants/${TID}/` });
    await Promise.all(files.map((f) => f.delete().catch(() => {})));
    console.log(`  ✓ deleted ${files.length} storage objects`);
  } catch (e) { console.log('  ⚠ storage cleanup skipped:', e.message); }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n✗ FATAL', e);
  process.exit(2);
});
