/**
 * seed-demo.js  —  run with:
 *   node -r dotenv/config scripts/seed-demo.js dotenv_config_path=../.env
 *
 * Seeds today's demo data into Firestore:
 *   1. Pickup events      (via lib/pickup-demo-seeder)
 *   2. Attendance records (facial recognition, today)
 *   3. Onboarding forms   (pending submissions)
 */

'use strict';

const admin = require('firebase-admin');
const path  = require('path');

// ─── Firebase init ────────────────────────────────────────────────────────────
function cleanEnv(v) {
  if (!v) return '';
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.trim();
}

function initFirebase() {
  if (admin.apps.length) return;
  let pk = cleanEnv(process.env.FIREBASE_PRIVATE_KEY);
  pk = pk.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      type: 'service_account',
      project_id: cleanEnv(process.env.FIREBASE_PROJECT_ID),
      private_key_id: cleanEnv(process.env.FIREBASE_PRIVATE_KEY_ID),
      private_key: pk,
      client_email: cleanEnv(process.env.FIREBASE_CLIENT_EMAIL),
      client_id: cleanEnv(process.env.FIREBASE_CLIENT_ID),
    }),
    storageBucket: cleanEnv(process.env.FIREBASE_STORAGE_BUCKET),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TENANT_ID = process.env.TENANT_ID || 'binus-simprug';

function wibDate() {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}
function wibTimeStr(offsetMinutes = 0) {
  const d = new Date(Date.now() + 7 * 3600_000 + offsetMinutes * 60_000);
  return d.toISOString().slice(11, 19);
}
function tsNow(offsetMinutes = 0) {
  return admin.firestore.Timestamp.fromMillis(Date.now() + offsetMinutes * 60_000);
}

function pick(arr, i) { return arr[i % arr.length]; }

// ─── 1. Pickup events ─────────────────────────────────────────────────────────
async function seedPickupEvents(db) {
  const { runPickupDemoSeed } = require('../lib/pickup-demo-seeder');
  console.log('  → Seeding pickup events via pickup-demo-seeder…');
  const result = await runPickupDemoSeed({
    db,
    tid: TENANT_ID,
    profileId: null,
    profileName: null,
    force: true,
    reason: 'manual_seed_script',
    actorEmail: 'seed-script@demo',
    eventCount: 45,
  });
  if (result.triggered) {
    console.log(`     ✓ ${result.eventCount} pickup events created (batch ${result.batchId})`);
  } else {
    console.log('     ⚠ seeder skipped:', result.reason);
  }
}

// ─── 2. Attendance records ────────────────────────────────────────────────────
const ATTENDANCE_STUDENTS = [
  { id: 'STU001', name: 'Aidan Hartono',    homeroom: '4A', grade: '4' },
  { id: 'STU002', name: 'Bella Pranata',    homeroom: '4A', grade: '4' },
  { id: 'STU003', name: 'Calvin Wijaya',    homeroom: '4B', grade: '4' },
  { id: 'STU004', name: 'Darren Halim',     homeroom: '4B', grade: '4' },
  { id: 'STU005', name: 'Elena Kusuma',     homeroom: '4C', grade: '4' },
  { id: 'STU006', name: 'Felix Tanjung',    homeroom: '4C', grade: '4' },
  { id: 'STU007', name: 'Grace Setiawan',   homeroom: '5A', grade: '5' },
  { id: 'STU008', name: 'Hugo Lim',         homeroom: '5A', grade: '5' },
  { id: 'STU009', name: 'Irene Suryadi',    homeroom: '5B', grade: '5' },
  { id: 'STU010', name: 'Jason Hartono',    homeroom: '5B', grade: '5' },
  { id: 'STU011', name: 'Keiko Tanaka',     homeroom: '5C', grade: '5' },
  { id: 'STU012', name: 'Leo Santoso',      homeroom: '5C', grade: '5' },
  { id: 'STU013', name: 'Maya Dewi',        homeroom: '6A', grade: '6' },
  { id: 'STU014', name: 'Niko Pranata',     homeroom: '6A', grade: '6' },
  { id: 'STU015', name: 'Olive Adriani',    homeroom: '6B', grade: '6' },
  { id: 'STU016', name: 'Patrick Susilo',   homeroom: '6B', grade: '6' },
  { id: 'STU017', name: 'Queenie Halim',    homeroom: '6C', grade: '6' },
  { id: 'STU018', name: 'Ryan Setiawan',    homeroom: '6C', grade: '6' },
  { id: 'STU019', name: 'Sandra Wijaya',    homeroom: '4A', grade: '4' },
  { id: 'STU020', name: 'Timothy Lim',      homeroom: '4B', grade: '4' },
  { id: 'STU021', name: 'Uma Kusuma',       homeroom: '4C', grade: '4' },
  { id: 'STU022', name: 'Victor Hartono',   homeroom: '5A', grade: '5' },
  { id: 'STU023', name: 'Wendy Tanjung',    homeroom: '5B', grade: '5' },
  { id: 'STU024', name: 'Xavier Pranata',   homeroom: '5C', grade: '5' },
  { id: 'STU025', name: 'Yolanda Santoso',  homeroom: '6A', grade: '6' },
  { id: 'STU026', name: 'Zachary Dewi',     homeroom: '6B', grade: '6' },
];

const GATES = [
  'PYP Lobby Entrance (DS-K1T342MFX)',
  'Basement 1 Terminal (DS-K1T341AMF)',
  'MYP Tower (DS-K1T342MFX)',
];
// 90% present on time, 5% late, 5% absent (just don't write a record)
async function seedAttendance(db) {
  const today = wibDate();
  const col = db.collection('attendance').doc(today).collection('records');
  const snap = await col.limit(1).get();
  if (!snap.empty) {
    console.log(`  → Attendance for ${today} already has data, skipping.`);
    return;
  }
  console.log(`  → Seeding attendance for ${today}…`);
  let count = 0;
  const batch = db.batch();
  for (let i = 0; i < ATTENDANCE_STUDENTS.length; i++) {
    // Skip ~5% for absent simulation
    if (i % 20 === 19) continue;
    const s = ATTENDANCE_STUDENTS[i];
    const late = (i % 10 === 0);
    // Early arrivals 06:50→07:25, late ones 07:31→07:50
    const offsetMin = late
      ? -((-19) + (i % 5) * 4)  // 07:31–07:50
      : -((-(-50) + i * 3) % 55); // 06:50–07:25
    const arrivalMin = late
      ? 31 + (i % 5) * 4
      : 50 - (i % 12) * 3;
    const baseHour7Min = late
      ? 31 + (i % 5) * 4
      : -(50 - (i % 12) * 3);
    // Simple deterministic time: 07:HH:SS
    const minInDay = 7 * 60 + (late ? 31 + (i % 5) * 4 : Math.max(1, (i * 2) % 35));
    const h = String(Math.floor(minInDay / 60)).padStart(2, '0');
    const m = String(minInDay % 60).padStart(2, '0');
    const sec = String((i * 17) % 60).padStart(2, '0');
    const ts = `${today} ${h}:${m}:${sec}`;
    const ref = col.doc(s.id);
    batch.set(ref, {
      employeeNo: s.id,
      name: s.name,
      homeroom: s.homeroom,
      grade: s.grade,
      timestamp: ts,
      status: late ? 'Late' : 'Present',
      late,
      source: i % 3 === 0 ? 'mobile' : 'hikvision',
      deviceName: pick(GATES, i),
      confidence: 0.85 + (i % 15) * 0.01,
      date: today,
    });
    count++;
  }
  await batch.commit();
  // Write day-level summary doc
  await db.collection('attendance').doc(today).set({
    date: today,
    total: count,
    present: count - ATTENDANCE_STUDENTS.filter((_, i) => i % 10 === 0).length,
    late: ATTENDANCE_STUDENTS.filter((_, i) => i % 10 === 0 && i % 20 !== 19).length,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`     ✓ ${count} attendance records written`);
}

// ─── 3. Onboarding forms (pending submissions) ────────────────────────────────
const FORM_GUARDIANS = [
  { name: 'Budi Hartono',    phone: '+62811000001', email: 'budi.hartono@gmail.com' },
  { name: 'Siti Pranata',    phone: '+62811000002', email: 'siti.pranata@gmail.com' },
  { name: 'Andi Wijaya',     phone: '+62811000003', email: 'andi.wijaya@gmail.com' },
  { name: 'Dewi Halim',      phone: '+62811000004', email: 'dewi.halim@gmail.com' },
  { name: 'Rudi Kusuma',     phone: '+62811000005', email: 'rudi.kusuma@gmail.com' },
  { name: 'Maya Setiawan',   phone: '+62811000006', email: 'maya.setiawan@gmail.com' },
  { name: 'Hadi Santoso',    phone: '+62811000007', email: 'hadi.santoso@gmail.com' },
  { name: 'Rina Tanjung',    phone: '+62811000008', email: 'rina.tanjung@gmail.com' },
];
const CHAP_NAMES = ['Ahmad Yusuf', 'Sari Indah', 'Bayu Pratama', 'Lestari Wulan', 'Deni Kurniawan'];
const RELATIONS = ['Father', 'Mother', 'Driver', 'Grandmother', 'Uncle'];
const FORM_STUDENTS = [
  ['STU001', 'Aidan Hartono',  '4A'],
  ['STU003', 'Calvin Wijaya',  '4B'],
  ['STU005', 'Elena Kusuma',   '4C'],
  ['STU007', 'Grace Setiawan', '5A'],
  ['STU009', 'Irene Suryadi',  '5B'],
  ['STU011', 'Keiko Tanaka',   '5C'],
  ['STU013', 'Maya Dewi',      '6A'],
  ['STU015', 'Olive Adriani',  '6B'],
];

async function seedOnboardingForms(db) {
  const col = db.collection(`tenants/${TENANT_ID}/pickup_onboarding`);
  const snap = await col.where('status', '==', 'pending').limit(1).get();
  if (!snap.empty) {
    console.log('  → Onboarding forms: pending submissions already exist, skipping.');
    return;
  }
  console.log('  → Seeding onboarding form submissions…');
  let count = 0;
  for (let i = 0; i < FORM_GUARDIANS.length; i++) {
    const g = FORM_GUARDIANS[i];
    const [stuId, stuName, stuRoom] = FORM_STUDENTS[i];
    const chapName = pick(CHAP_NAMES, i);
    const relation = pick(RELATIONS, i);
    const minutesAgo = 10 + i * 25;
    await col.add({
      status: i < 5 ? 'pending' : (i < 7 ? 'approved' : 'rejected'),
      submittedAt: tsNow(-minutesAgo),
      guardian: { name: g.name, phone: g.phone, email: g.email },
      students: [{ id: stuId, name: stuName, homeroom: stuRoom }],
      chaperones: [{
        name: chapName,
        relation,
        idNumber: `KTP${String(1000000 + i).padStart(7, '0')}`,
        photoUrl: null,
        faceEnrolled: false,
      }],
      approvalNotes: '',
      rejectionReason: i >= 7 ? 'Incomplete documentation' : '',
      reviewedAt: i >= 5 ? tsNow(-5) : null,
      reviewedBy: i >= 5 ? 'admin@binus.edu' : null,
      tenantId: TENANT_ID,
    });
    count++;
  }
  console.log(`     ✓ ${count} form submissions written (5 pending, 2 approved, 1 rejected)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🌱 Starting demo data seed…\n');
  try {
    initFirebase();
    const db = admin.firestore();

    await seedPickupEvents(db);
    await seedAttendance(db);
    await seedOnboardingForms(db);

    console.log('\n✅ Seed complete.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
