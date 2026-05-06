#!/usr/bin/env node
/**
 * Phase 3 end-to-end simulation for the parent onboarding flow.
 *
 * Drives the API handlers directly (no HTTP) against a real Firestore
 * project under a sandbox tenant id. Cleans up everything it creates.
 *
 *   node scripts/e2e-onboarding.js
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local'), override: false });

const path = require('path');
const crypto = require('crypto');

// ── tiny req/res mocks ───────────────────────────────────────────────
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}
function mockReq(method, body, ip = '127.0.0.1') {
  return {
    method,
    body,
    headers: { 'x-forwarded-for': ip, 'user-agent': 'e2e-sim/1.0' },
    socket: { remoteAddress: ip },
  };
}

async function call(handler, method, body, ipSuffix = 0) {
  const req = mockReq(method, body, `127.0.0.${100 + ipSuffix}`);
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

// ── Tiny PNG (1×1 red) for face upload test ─────────────────────────
function tinyPngDataUrl() {
  // valid 1x1 red PNG
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  return 'data:image/png;base64,' + b64;
}

// ── Main ─────────────────────────────────────────────────────────────
(async () => {
  const TID = `e2e-${Date.now().toString(36)}`;
  const SID = 'E2ESTU0001';

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 3 onboarding e2e simulation');
  console.log('  Test tenant:', TID);
  console.log('  Test sid   :', SID);
  console.log('═══════════════════════════════════════════════════════════\n');

  const { signPickupOnboardingToken } = require(path.join(__dirname, '..', 'lib', 'pickup-token'));
  const { initializeFirebase } = require(path.join(__dirname, '..', 'lib', 'firebase-admin'));
  const tenancy = require(path.join(__dirname, '..', 'lib', 'tenancy'));
  const admin = require('firebase-admin');

  const lookupHandler = require(path.join(__dirname, '..', 'pages', 'api', 'pickup', 'onboarding', 'lookup')).default;
  const faceHandler = require(path.join(__dirname, '..', 'pages', 'api', 'pickup', 'onboarding', 'face')).default;
  const submitHandler = require(path.join(__dirname, '..', 'pages', 'api', 'pickup', 'onboarding', 'submit')).default;
  const rejectHandler = require(path.join(__dirname, '..', 'pages', 'api', 'pickup', 'admin', 'reject')).default;

  initializeFirebase();
  const db = admin.firestore();

  // ── Seed: a student in the test tenant so lookup hits ──
  await db.doc(`${tenancy.studentsPath(TID)}/${SID}`).set({
    name: 'E2E Test Student',
    homeroom: '4Z',
    photoUrl: null,
  });
  console.log('✓ seeded student', SID);

  const token = signPickupOnboardingToken({ tenantId: TID, studentId: SID });
  console.log('✓ signed token', token.slice(0, 24) + '…\n');

  let pass = 0, fail = 0;
  const expect = (label, cond, detail) => {
    if (cond) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label} — ${detail || ''}`); fail++; }
  };

  // ────────────────────────────────────────────────────────────────
  console.log('── Test 1: lookup (cache miss → hit) ─────────────────────');
  const r1a = await call(lookupHandler, 'POST', { token, studentId: SID });
  expect('200', r1a.status === 200, `got ${r1a.status} ${JSON.stringify(r1a.body)}`);
  expect('student name', r1a.body?.student?.name === 'E2E Test Student');
  expect('cache MISS header', r1a.headers['x-cache'] === 'MISS');

  const r1b = await call(lookupHandler, 'POST', { token, studentId: SID });
  expect('cache HIT header', r1b.headers['x-cache'] === 'HIT');
  expect('Cache-Control set', /private/.test(r1b.headers['cache-control'] || ''));

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 2: lookup with bad sid → 400 ────────────────────');
  const r2 = await call(lookupHandler, 'POST', { token, studentId: 'bad!' });
  expect('400 on bad format', r2.status === 400);

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 3: lookup with bad token → 401 ──────────────────');
  const r3 = await call(lookupHandler, 'POST', { token: 'garbage', studentId: SID });
  expect('401', r3.status === 401);

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 4: face upload ──────────────────────────────────');
  const tempId = 'tmp-' + crypto.randomBytes(6).toString('hex');
  const r4a = await call(faceHandler, 'POST', {
    token, tempId, photoIndex: 0, imageBase64: tinyPngDataUrl(),
  });
  expect('200', r4a.status === 200, JSON.stringify(r4a.body));
  expect('storage path returned', typeof r4a.body?.path === 'string' && r4a.body.path.includes(TID));

  const r4b = await call(faceHandler, 'POST', {
    token, tempId, photoIndex: 5, imageBase64: tinyPngDataUrl(),
  });
  expect('photoIndex 5 → 400', r4b.status === 400);

  const r4c = await call(faceHandler, 'POST', {
    token, tempId, photoIndex: 0, imageBase64: 'data:image/gif;base64,xx',
  });
  expect('gif → 400', r4c.status === 400);

  const r4d = await call(faceHandler, 'POST', {
    token, tempId: 'bad!!', photoIndex: 0, imageBase64: tinyPngDataUrl(),
  });
  expect('bad tempId → 400', r4d.status === 400);

  const facePath = r4a.body.path;

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 5: submit (happy path) ───────────────────────────');
  const submitBody = {
    token,
    guardianName: 'Jane Parent',
    guardianEmail: 'jane@example.com',
    guardianPhone: '+62-812-9999-0000',
    students: [{ id: SID, name: 'E2E Test Student', homeroom: '4Z' }],
    chaperones: [{
      tempId,
      name: 'Driver Bob',
      relation: 'driver',
      phone: '+62-812-1111-2222',
      idNumber: 'KTP-9999',
      email: '',
      authorizedStudentIds: [SID],
      facePaths: [facePath],
    }],
    consentSignature: 'Jane Parent',
  };
  const r5 = await call(submitHandler, 'POST', submitBody);
  expect('200', r5.status === 200, JSON.stringify(r5.body));
  expect('formNumber PKP-YYYY-NNNNN', /^PKP-\d{4}-\d{5}$/.test(r5.body?.formNumber || ''));
  expect('recordId returned', typeof r5.body?.recordId === 'string');
  const formNumber1 = r5.body?.formNumber;
  const recordId1 = r5.body?.recordId;

  // Verify lock doc
  const lockSnap = await db.doc(`${tenancy.pickupStudentLocksPath(TID)}/${SID}`).get();
  expect('lock doc created', lockSnap.exists);
  expect('lock status=pending', (lockSnap.data() || {}).status === 'pending');
  expect('lock formNumber matches', (lockSnap.data() || {}).formNumber === formNumber1);

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 6: submit again (dedupe → 409) ───────────────────');
  // Need a fresh face upload because facePaths are validated as starting with tenants/
  const tempId2 = 'tmp-' + crypto.randomBytes(6).toString('hex');
  const r6face = await call(faceHandler, 'POST', {
    token, tempId: tempId2, photoIndex: 0, imageBase64: tinyPngDataUrl(),
  }, 1);
  const submitBody2 = { ...submitBody };
  submitBody2.chaperones = [{ ...submitBody.chaperones[0], tempId: tempId2, facePaths: [r6face.body.path] }];
  const r6 = await call(submitHandler, 'POST', submitBody2, 1);
  expect('409', r6.status === 409, `got ${r6.status} ${JSON.stringify(r6.body)}`);
  expect('error code', r6.body?.error === 'student-already-registered');
  expect('conflicts[].formNumber present', r6.body?.conflicts?.[0]?.formNumber === formNumber1);
  expect('message mentions ACOP', /ACOP/i.test(r6.body?.message || ''));

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 7: missing face photos → 400 ─────────────────────');
  const submitBody3 = { ...submitBody };
  submitBody3.chaperones = [{ ...submitBody.chaperones[0], facePaths: [] }];
  const r7 = await call(submitHandler, 'POST', submitBody3, 2);
  expect('400 (no faces)', r7.status === 400);

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 8: too many chaperones → 400 ─────────────────────');
  const four = Array.from({ length: 4 }, () => submitBody.chaperones[0]);
  const r8 = await call(submitHandler, 'POST', { ...submitBody, chaperones: four }, 3);
  expect('400 (>3 chaperones)', r8.status === 400);

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 9: signature mismatch → 400 ──────────────────────');
  const r9 = await call(submitHandler, 'POST', { ...submitBody, consentSignature: 'Wrong Name' }, 4);
  expect('400 (sig mismatch)', r9.status === 400);

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 10: reject releases lock → re-submit succeeds ────');
  const r10reject = await call(rejectHandler, 'POST', {
    recordId: recordId1, tenant: TID, reason: 'e2e simulation',
  }, 5);
  expect('reject 200', r10reject.status === 200, JSON.stringify(r10reject.body));
  const lock2 = await db.doc(`${tenancy.pickupStudentLocksPath(TID)}/${SID}`).get();
  expect('lock status=rejected', (lock2.data() || {}).status === 'rejected');

  const tempId3 = 'tmp-' + crypto.randomBytes(6).toString('hex');
  const r10face = await call(faceHandler, 'POST', {
    token, tempId: tempId3, photoIndex: 0, imageBase64: tinyPngDataUrl(),
  }, 6);
  const submitBody4 = { ...submitBody };
  submitBody4.chaperones = [{ ...submitBody.chaperones[0], tempId: tempId3, facePaths: [r10face.body.path] }];
  const r10sub = await call(submitHandler, 'POST', submitBody4, 6);
  expect('re-submit 200', r10sub.status === 200, `got ${r10sub.status} ${JSON.stringify(r10sub.body)}`);
  expect('new formNumber different', r10sub.body?.formNumber && r10sub.body.formNumber !== formNumber1);

  // ────────────────────────────────────────────────────────────────
  console.log('\n── Test 11: rate limit on submit (5/hour) ────────────────');
  // Fire 5 more from a fresh IP to push it over the limit. We don't
  // expect them to succeed (lock now active) but the RL should trigger
  // before validation either way.
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await call(submitHandler, 'POST', { token: 'invalid' }, 10); // bogus body, same IP
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
  // Onboarding records
  const obSnap = await db.collection(tenancy.pickupOnboardingPath(TID)).get();
  obSnap.forEach((d) => cleanups.push(d.ref.delete()));
  await Promise.allSettled(cleanups);
  console.log(`  ✓ deleted ${cleanups.length} firestore docs`);

  // Storage cleanup
  try {
    const { getFirebaseStorage } = require(path.join(__dirname, '..', 'lib', 'firebase-admin'));
    const bucket = getFirebaseStorage().bucket();
    const [files] = await bucket.getFiles({ prefix: `tenants/${TID}/` });
    await Promise.all(files.map((f) => f.delete().catch(() => {})));
    console.log(`  ✓ deleted ${files.length} storage objects`);
  } catch (e) {
    console.log('  ⚠ storage cleanup skipped:', e.message);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n✗ FATAL', e);
  process.exit(2);
});
