/**
 * scripts/seed-grade5-pickup.js
 *
 * One-shot seeder for the Grade 5 teacher iPad pickup demo.
 *
 * Creates 3 approved chaperones (one per real Grade 5 student) and 3 fresh
 * `pickup_events` so the paired Grade 5 iPad immediately shows meaningful
 * data on the Active + Held rails.
 *
 * Tagged with `demoFlag: 'grade5-seed-v1'` for easy cleanup.
 *
 * Usage:
 *   node scripts/seed-grade5-pickup.js              # seed
 *   node scripts/seed-grade5-pickup.js --cleanup    # delete everything tagged
 */
const admin = require('firebase-admin');
const path = require('path');

const SERVICE_ACCOUNT = require(
  path.join(__dirname, '..', '..', 'facial-attendance-binus-firebase-adminsdk.json')
);

const TENANT = 'binus-simprug';
const RELEASE_GROUP_ID = 'VF5ZcEkhBtVoJUyIwzCg';
const DEMO_FLAG = 'grade5-seed-v1';

// Grade 5 release group's terminals (already verified in Firestore):
const TERMINALS = {
  '2dc4c6f35f89': 'PYP Lobby Entrance (DS-K1T342MFX)',
  'cf18e11f9d8e': 'MYP Tower (DS-K1T342MFX)',
  '875e8b213c76': 'Basement 1 Terminal (DS-K1T341AMF)',
};

// Realistic Grade 5 demo: many chaperones + events covering all three
// terminals, mix of pending/held, mix of green/yellow/red. Timestamps
// spread from "just now" to ~22 minutes ago so the cards look organic.
const ROSTER = [
  // ── PENDING (active rail, hard-capped to 2 client-side; rest queue up) ──
  {
    student: { id: '1870001744', name: 'Connor Henry Owen', homeroom: '5A' },
    chaperone: { name: 'Daniel Owen', relation: 'Father', phone: '+62 812 1111 2222' },
    terminalId: '2dc4c6f35f89',
    status: 'pending', cardState: 'green', decision: 'ok', minutesAgo: 0,
  },
  {
    student: { id: '1970003014', name: 'Carter Surya Putra', homeroom: '5A' },
    chaperone: { name: 'Linda Putra', relation: 'Mother', phone: '+62 813 3333 4444' },
    terminalId: '2dc4c6f35f89',
    status: 'pending', cardState: 'green', decision: 'ok', minutesAgo: 1,
  },
  {
    student: { id: '1870002777', name: 'Ayla Madina Zulkarnain', homeroom: '5A' },
    chaperone: { name: 'Rizki Zulkarnain', relation: 'Father', phone: '+62 815 2020 3030' },
    terminalId: '2dc4c6f35f89',
    status: 'pending', cardState: 'green', decision: 'ok', minutesAgo: 2,
  },
  {
    student: { id: '1970003074', name: 'Shaylene Louise Mak', homeroom: '5B' },
    chaperone: { name: 'Jessica Mak', relation: 'Aunt', phone: '+62 811 5555 6666' },
    terminalId: '875e8b213c76',
    status: 'pending', cardState: 'yellow', decision: 'ok', minutesAgo: 3,
  },
  {
    student: { id: '2470006068', name: 'Soyi Shin', homeroom: '5A' },
    chaperone: { name: 'Min-Jung Shin', relation: 'Mother', phone: '+62 817 9090 1010' },
    terminalId: 'cf18e11f9d8e',
    status: 'pending', cardState: 'green', decision: 'ok', minutesAgo: 4,
  },
  // Multi-student pickup: one parent collecting siblings (3 kids) — demos the big list state
  {
    students: [
      { id: '1870001744', name: 'Connor Henry Owen',     homeroom: '5A' },
      { id: '1970003014', name: 'Carter Surya Putra',    homeroom: '5A' },
      { id: '1870002777', name: 'Ayla Madina Zulkarnain', homeroom: '5A' },
    ],
    chaperone: { name: 'Carpool Driver - Bu Ratna', relation: 'Other', phone: '+62 821 1414 9090' },
    terminalId: '2dc4c6f35f89',
    status: 'pending', cardState: 'yellow', decision: 'ok', minutesAgo: 1,
  },
  // ── HELD (below the divider, smaller cards in a grid) ────────────────────
  {
    student: { id: '2470006068', name: 'Soyi Shin', homeroom: '5A' },
    chaperone: { name: 'Hyun-Woo Shin', relation: 'Father', phone: '+62 817 1212 3434' },
    terminalId: '2dc4c6f35f89',
    status: 'held', cardState: 'yellow', decision: 'ok', minutesAgo: 5,
  },
  {
    student: { id: '1870001744', name: 'Connor Henry Owen', homeroom: '5A' },
    chaperone: { name: 'Maria Lim (Nanny)', relation: 'Other', phone: '+62 819 7878 9090' },
    terminalId: 'cf18e11f9d8e',
    status: 'held', cardState: 'red', decision: 'unknown_chaperone', minutesAgo: 7,
  },
  {
    student: { id: '1970003074', name: 'Shaylene Louise Mak', homeroom: '5B' },
    chaperone: { name: 'Brian Mak', relation: 'Uncle', phone: '+62 818 4444 5555' },
    terminalId: '875e8b213c76',
    status: 'held', cardState: 'green', decision: 'ok', minutesAgo: 9,
  },
  {
    student: { id: '1970003014', name: 'Carter Surya Putra', homeroom: '5A' },
    chaperone: { name: 'Putri Surya', relation: 'Mother', phone: '+62 821 6060 7070' },
    terminalId: '2dc4c6f35f89',
    status: 'held', cardState: 'green', decision: 'ok', minutesAgo: 11,
  },
  // Multi-student held: 2 siblings being picked up by an aunt
  {
    students: [
      { id: '1870002777', name: 'Ayla Madina Zulkarnain', homeroom: '5A' },
      { id: '1970003074', name: 'Shaylene Louise Mak',    homeroom: '5B' },
    ],
    chaperone: { name: 'Aunt Diana Halim', relation: 'Aunt', phone: '+62 813 1717 8181' },
    terminalId: '875e8b213c76',
    status: 'held', cardState: 'green', decision: 'ok', minutesAgo: 12,
  },
  {
    student: { id: '1870002777', name: 'Ayla Madina Zulkarnain', homeroom: '5A' },
    chaperone: { name: 'Sari Zulkarnain', relation: 'Mother', phone: '+62 822 3030 1010' },
    terminalId: 'cf18e11f9d8e',
    status: 'held', cardState: 'yellow', decision: 'ok', minutesAgo: 13,
  },
  {
    student: { id: '1970003074', name: 'Shaylene Louise Mak', homeroom: '5B' },
    chaperone: { name: 'Unknown Visitor', relation: 'Other', phone: '+62 800 0000 0000' },
    terminalId: '875e8b213c76',
    status: 'held', cardState: 'red', decision: 'unknown_chaperone', minutesAgo: 16,
  },
  {
    student: { id: '1870001744', name: 'Connor Henry Owen', homeroom: '5A' },
    chaperone: { name: 'Sophia Owen', relation: 'Sister', phone: '+62 813 7070 8080' },
    terminalId: '2dc4c6f35f89',
    status: 'held', cardState: 'green', decision: 'ok', minutesAgo: 18,
  },
  {
    student: { id: '2470006068', name: 'Soyi Shin', homeroom: '5A' },
    chaperone: { name: 'Driver - Pak Joko', relation: 'Other', phone: '+62 856 1010 2020' },
    terminalId: 'cf18e11f9d8e',
    status: 'held', cardState: 'yellow', decision: 'ok', minutesAgo: 22,
  },
];

const FIRST_CHAPERONE_NO = 9000099000; // out of the way of real allocations

// FR signal generator — keeps demo numbers realistic per cardState/decision.
function frSignals(item) {
  if (item.decision === 'unknown_chaperone') {
    // Unknown visitor: low-confidence, possible spoof, low liveness
    const isSpoof = item.chaperone && /unknown|visitor/i.test(item.chaperone.name || '');
    return {
      confidence: +(0.32 + Math.random() * 0.18).toFixed(3),         // 0.32-0.50
      distance:   +(0.55 + Math.random() * 0.15).toFixed(3),
      liveness:   +(0.30 + Math.random() * 0.20).toFixed(3),
      livenessPassed: false,
      spoof: isSpoof,
      retries: 2 + Math.floor(Math.random() * 2),
      engine: 'arcface-r100-onnx',
      enrolledPhotoPath: null,
    };
  }
  if (item.cardState === 'yellow') {
    return {
      confidence: +(0.66 + Math.random() * 0.12).toFixed(3),         // 0.66-0.78
      distance:   +(0.34 + Math.random() * 0.10).toFixed(3),
      liveness:   +(0.62 + Math.random() * 0.15).toFixed(3),
      livenessPassed: true,
      spoof: false,
      retries: 1 + Math.floor(Math.random() * 2),
      engine: 'arcface-r100-onnx',
      enrolledPhotoPath: null,
    };
  }
  // green / ok
  return {
    confidence: +(0.90 + Math.random() * 0.08).toFixed(3),           // 0.90-0.98
    distance:   +(0.18 + Math.random() * 0.08).toFixed(3),
    liveness:   +(0.85 + Math.random() * 0.10).toFixed(3),
    livenessPassed: true,
    spoof: false,
    retries: 1,
    engine: 'arcface-r100-onnx',
    enrolledPhotoPath: null,
  };
}

admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) });
const db = admin.firestore();

async function cleanup() {
  console.log('[cleanup] deleting demo chaperones + events tagged', DEMO_FLAG);
  const ev = await db.collection(`tenants/${TENANT}/pickup_events`)
    .where('demoFlag', '==', DEMO_FLAG).get();
  for (const d of ev.docs) await d.ref.delete();
  console.log(`  deleted ${ev.size} pickup_events`);
  const ch = await db.collection(`tenants/${TENANT}/chaperones`)
    .where('demoFlag', '==', DEMO_FLAG).get();
  for (const d of ch.docs) await d.ref.delete();
  console.log(`  deleted ${ch.size} chaperones`);
}

async function seed() {
  // Verify release group is still paired so we don't seed into the void.
  const rg = await db.doc(`tenants/${TENANT}/release_groups/${RELEASE_GROUP_ID}`).get();
  if (!rg.exists) throw new Error(`release group ${RELEASE_GROUP_ID} not found`);
  const rgData = rg.data();
  console.log('[ok] release group:', rgData.name, '|', rgData.gradeLabel,
    '| paired to:', rgData.tabletDeviceId, '| terminals:', rgData.terminalIds);

  const now = Date.now();
  let chaperoneSeq = FIRST_CHAPERONE_NO;

  for (const item of ROSTER) {
    const employeeNo = String(chaperoneSeq++);
    const chaperoneId = `chap-${employeeNo}`;
    const recordedAt = new Date(now - item.minutesAgo * 60_000);
    const eventId = `g5seed-${chaperoneId}-${recordedAt.getTime()}`;

    // Normalize: support either single .student or .students[] in the roster
    const studentList = Array.isArray(item.students) && item.students.length > 0
      ? item.students
      : [item.student];
    const studentIds = studentList.map((s) => s.id);
    const homerooms = Array.from(new Set(studentList.map((s) => s.homeroom).filter(Boolean)));

    // 1. Approved chaperone doc.
    await db.doc(`tenants/${TENANT}/chaperones/${chaperoneId}`).set({
      chaperoneId,
      employeeNo,
      tenantId: TENANT,
      name: item.chaperone.name,
      relation: item.chaperone.relation,
      phone: item.chaperone.phone,
      email: null,
      idNumber: null,
      guardianName: item.chaperone.name,
      guardianEmail: null,
      guardianPhone: item.chaperone.phone,
      authorizedStudentIds: studentIds,
      studentClasses: homerooms,
      studentGrades: ['5'],
      facePaths: [],
      status: 'approved_pending_faces',
      deviceEnrolled: false,
      deviceEnrollErrors: null,
      approvedAt: new Date().toISOString(),
      approvedFromOnboarding: 'grade5-seed',
      reEnrollDueAt: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
      suspendedAt: null,
      demoFlag: DEMO_FLAG,
    }, { merge: false });

    // 2. Pickup event the iPad will pick up.
    await db.doc(`tenants/${TENANT}/pickup_events/${eventId}`).set({
      eventId,
      scannedAt: admin.firestore.Timestamp.fromDate(recordedAt),
      recordedAt: admin.firestore.Timestamp.fromDate(recordedAt),
      deviceName: TERMINALS[item.terminalId],
      gate: TERMINALS[item.terminalId],
      terminalId: item.terminalId,
      decision: item.decision,
      cardState: item.cardState,
      holdSeconds: 60,
      status: item.status,
      chaperone: {
        id: chaperoneId,
        chaperoneId,
        employeeNo,
        name: item.chaperone.name,
        relation: item.chaperone.relation,
        phone: item.chaperone.phone,
        photoUrl: null,
        suspended: false,
        reEnrollOverdue: false,
      },
      students: studentList.map((s) => ({
        id: s.id,
        name: s.name,
        homeroom: s.homeroom,
        photoUrl: null,
      })),
      capturePath: null,
      teacherRelease: null,
      fr: frSignals(item),
      demoFlag: DEMO_FLAG,
    });

    console.log(`[+] ${item.status.toUpperCase().padEnd(8)} ${chaperoneId}` +
      `  ${item.chaperone.name}  →  ${studentList.map((s) => s.name).join(' + ')}` +
      `  @ ${TERMINALS[item.terminalId]}`);
  }
  console.log('\nDone. The Grade 5 iPad should now show 5 active (cap 2 visible) + 8 held pickups.');
}

(async () => {
  try {
    if (process.argv.includes('--cleanup')) await cleanup();
    else await seed();
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
