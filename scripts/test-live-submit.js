#!/usr/bin/env node
/**
 * Submit one realistic onboarding form against the running dev server,
 * using a real student from the binus-simprug tenant.
 *
 * Usage: node scripts/test-live-submit.js
 */
'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local'), override: false });

const path = require('path');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';

const TENANT = 'binus-simprug';
const SID = '1770007166';                   // Caelyn Grace William, 6B (real)
const GUARDIAN = 'Mrs. Test Parent';
const EMAIL = 'test.parent@example.com';
const PHONE = '+62-812-0000-0001';

// 1×1 PNG (smallest valid)
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function api(p, body, ip = '203.0.113.42') {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { json = await r.text(); }
  return { status: r.status, body: json };
}

(async () => {
  const { signPickupOnboardingToken } = require(path.join(__dirname, '..', 'lib', 'pickup-token'));
  const token = signPickupOnboardingToken({ tenantId: TENANT, studentId: SID });
  console.log('▸ tenant   :', TENANT);
  console.log('▸ studentId:', SID);
  console.log('▸ token    :', token.slice(0, 32) + '...\n');

  console.log('── 1. lookup student ─────────────────────');
  const r1 = await api('/api/pickup/onboarding/lookup', { token, studentId: SID });
  console.log('  status:', r1.status);
  console.log('  student:', r1.body?.student?.name, '|', r1.body?.student?.homeroom);
  if (r1.status !== 200) { console.error('LOOKUP FAILED', r1.body); process.exit(1); }

  console.log('\n── 2. upload chaperone face ──────────────');
  const tempId = 'chap-temp-' + Date.now();
  const r2 = await api('/api/pickup/onboarding/face', {
    token, tempId, photoIndex: 0, imageBase64: PNG_DATA_URL,
  });
  console.log('  status:', r2.status, '| path:', r2.body?.path);
  if (r2.status !== 200) { console.error('FACE FAILED', r2.body); process.exit(1); }
  const facePath = r2.body.path;

  console.log('\n── 3. submit form ────────────────────────');
  const r3 = await api('/api/pickup/onboarding/submit', {
    token,
    guardianName: GUARDIAN,
    guardianEmail: EMAIL,
    guardianPhone: PHONE,
    students: [{
      id: SID,
      name: r1.body.student.name,
      homeroom: r1.body.student.homeroom,
    }],
    chaperones: [{
      tempId,
      name: 'Aunt Test Chaperone',
      relation: 'aunt',
      phone: '+62-812-0000-0002',
      idNumber: 'KTP-TEST-001',
      email: 'aunt.test@example.com',
      authorizedStudentIds: [SID],
      facePaths: [facePath],
    }],
    consentSignature: GUARDIAN,
  });
  console.log('  status:', r3.status);
  console.log('  body  :', JSON.stringify(r3.body, null, 2));
  if (r3.status !== 200) { console.error('\nSUBMIT FAILED'); process.exit(1); }

  console.log('\n✅ Submitted. Check admin UI at http://localhost:3000/v2/pickup-admin (Pending tab)');
  console.log('   Record ID  :', r3.body.recordId);
  console.log('   Form Number:', r3.body.formNumber);
})().catch((e) => { console.error(e); process.exit(1); });
