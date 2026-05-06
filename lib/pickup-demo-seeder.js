const admin = require('firebase-admin');
const tenancy = require('./tenancy');

const DEMO_FLAG = 'pyp35-demo-v1';
const DEFAULT_TARGET_PROFILE_ID = 'pyp-lobby-grades-3-5';
const DEFAULT_TEACHER_EMAIL = 'albert@binus.edu';
const DEFAULT_CLASS_SCOPE = '4C';
const DEFAULT_EVENT_COUNT = 35;
const MAX_EVENT_COUNT = 80;

const RELATIONS = ['Father', 'Mother', 'Uncle', 'Aunt', 'Driver', 'Grandmother'];
const CHAPERONE_FIRST = ['Andi', 'Sari', 'Budi', 'Maya', 'Rina', 'Hadi', 'Dewi', 'Arif'];
const CHAPERONE_LAST = ['Wijaya', 'Halim', 'Setiawan', 'Pranata', 'Kusuma', 'Tanjung'];

const DEFAULT_GATES = [
  'PYP Lobby Entrance (DS-K1T342MFX)',
  'Basement 1 Terminal (DS-K1T341AMF)',
  'MYP Tower (DS-K1T342MFX)',
];

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function clampEventCount(raw, fallback) {
  const n = parseInt(String(raw || fallback), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(5, Math.min(MAX_EVENT_COUNT, n));
}

function normalizeClass(code) {
  return String(code || '').trim().toUpperCase();
}

function parseClassScopes(raw) {
  if (!raw) return [];
  return [...new Set(String(raw).split(',').map(normalizeClass).filter(Boolean))];
}

function pick(arr, i) {
  return arr[i % arr.length];
}

function randomName(i) {
  return `${pick(CHAPERONE_FIRST, i)} ${pick(CHAPERONE_LAST, i + 3)}`;
}

function profileMatchesTarget(profileId, profileName) {
  const targetId = String(process.env.PICKUP_DEMO_PROFILE_ID || DEFAULT_TARGET_PROFILE_ID).trim().toLowerCase();
  const byId = String(profileId || '').trim().toLowerCase() === targetId;
  if (byId) return true;

  const targetName = String(process.env.PICKUP_DEMO_PROFILE_NAME || '').trim().toLowerCase();
  if (!targetName) return false;
  return String(profileName || '').trim().toLowerCase().includes(targetName);
}

function decisionForIndex(i) {
  if (i % 10 === 0) return { decision: 'unknown_chaperone', cardState: 'red' };
  if (i % 6 === 0) return { decision: 'reenroll_overdue', cardState: 'yellow' };
  if (i % 13 === 0) return { decision: 'suspended', cardState: 'yellow' };
  return { decision: 'ok', cardState: 'green' };
}

async function resolveTeacherClassScopes(db, teacherEmail) {
  const doc = await db.collection('dashboard_users').doc(String(teacherEmail).toLowerCase()).get();
  if (!doc.exists) return [];
  const user = doc.data() || {};
  if (!Array.isArray(user.classScopes)) return [];
  return [...new Set(user.classScopes.map(normalizeClass).filter(Boolean))];
}

function nameFromStudentDoc(data) {
  return data.name || data.studentName || data.fullName || data.displayName || null;
}

async function loadScopedStudents(db, tid, classScopes) {
  const path = tenancy.studentMetadataPath(tid);
  const snap = await db.collection(path).limit(1500).get();
  const out = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const homeroom = normalizeClass(data.homeroom);
    const name = nameFromStudentDoc(data);
    if (!homeroom || !name) continue;
    if (classScopes.length > 0 && !classScopes.includes(homeroom)) continue;
    out.push({
      id: data.id || doc.id,
      name,
      homeroom,
      photoUrl: null,
    });
  }
  return out;
}

function fallbackStudents(classScopes) {
  const scopes = classScopes.length > 0 ? classScopes : [DEFAULT_CLASS_SCOPE];
  const names = [
    'Aidan Hartono',
    'Bella Pranata',
    'Calvin Wijaya',
    'Darren Halim',
    'Elena Kusuma',
    'Felix Tanjung',
    'Grace Setiawan',
    'Hugo Lim',
    'Irene Suryadi',
    'Jason Hartono',
  ];
  return names.map((name, i) => ({
    id: `fallback-${i + 1}`,
    name,
    homeroom: scopes[i % scopes.length],
    photoUrl: null,
  }));
}

async function resolveProfile(db, tid, profileId, profileNameHint) {
  if (profileId) {
    const snap = await db.doc(`tenants/${tid}/kiosk_profiles/${profileId}`).get();
    if (snap.exists) {
      const data = snap.data() || {};
      return {
        id: snap.id,
        name: data.name || profileNameHint || snap.id,
        gates: Array.isArray(data.gates) ? data.gates : [],
      };
    }
  }
  return {
    id: profileId || process.env.PICKUP_DEMO_PROFILE_ID || DEFAULT_TARGET_PROFILE_ID,
    name: profileNameHint || process.env.PICKUP_DEMO_PROFILE_NAME || 'PYP 35',
    gates: [],
  };
}

async function clearPreviousDemoBatch(db, tid, profileId) {
  const col = db.collection(tenancy.pickupEventsPath(tid));
  const snap = await col
    .where('demoFlag', '==', DEMO_FLAG)
    .where('demoProfileId', '==', String(profileId))
    .limit(400)
    .get();

  if (snap.empty) return 0;

  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
  return snap.size;
}

function buildSeedEvents({ count, gates, students, profileId, classScopes, batchId }) {
  const now = Date.now();
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(now - (i * 38 * 1000));
    const scannedAt = admin.firestore.Timestamp.fromDate(ts);
    const recordedAt = admin.firestore.Timestamp.fromDate(ts);

    const { decision, cardState } = decisionForIndex(i + 1);
    const gate = pick(gates, i);

    const studentCount = cardState === 'red' ? (i % 3 === 0 ? 0 : 1) : (i % 4) + 1;
    const selected = [];
    for (let s = 0; s < studentCount; s += 1) {
      const source = students[(i + s) % students.length];
      selected.push({
        id: String(source.id || `seed-${i}-${s}`),
        name: source.name,
        homeroom: source.homeroom,
        photoUrl: null,
      });
    }

    const eventId = `demo-${profileId}-${batchId}-${String(i + 1).padStart(3, '0')}`;
    events.push({
      eventId,
      tenantId: null,
      employeeNo: `9${String(100000000 + i)}`,
      scannedAt,
      recordedAt,
      deviceName: gate.split(' (')[0],
      gate,
      decision,
      cardState,
      chaperone: {
        id: `seed-chaperone-${i + 1}`,
        name: randomName(i),
        relation: pick(RELATIONS, i),
        photoUrl: null,
        phone: null,
        suspended: decision === 'suspended',
        reEnrollDueAt: null,
        reEnrollOverdue: decision === 'reenroll_overdue',
      },
      students: selected,
      capturePath: null,
      officerOverride: null,
      teacherRelease: null,
      overrideCode: decision === 'ok' ? null : String(100000 + i).slice(-6),
      holdSeconds: 60,
      status: 'pending',
      demoFlag: DEMO_FLAG,
      demoBatchId: batchId,
      demoProfileId: String(profileId),
      demoClassScopes: classScopes,
      demoSeededAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return events;
}

async function runPickupDemoSeed({
  db,
  tid,
  profileId,
  profileName,
  force = false,
  reason = 'manual',
  actorEmail = null,
  eventCount = null,
}) {
  const enabled = envBool('PICKUP_DEMO_AUTO_SEED', true);
  if (!enabled && !force) {
    return { triggered: false, reason: 'disabled' };
  }

  const profile = await resolveProfile(db, tid, profileId, profileName);
  if (!force && !profileMatchesTarget(profile.id, profile.name)) {
    return { triggered: false, reason: 'profile_not_targeted', profileId: profile.id };
  }

  const teacherEmail = String(process.env.PICKUP_DEMO_TEACHER_EMAIL || DEFAULT_TEACHER_EMAIL).toLowerCase();
  let classScopes = await resolveTeacherClassScopes(db, teacherEmail);
  if (classScopes.length === 0) {
    classScopes = parseClassScopes(process.env.PICKUP_DEMO_CLASS_SCOPES);
  }
  if (classScopes.length === 0) {
    classScopes = [DEFAULT_CLASS_SCOPE];
  }

  let students = await loadScopedStudents(db, tid, classScopes);
  if (students.length === 0) {
    students = fallbackStudents(classScopes);
  }

  const count = clampEventCount(eventCount || process.env.PICKUP_DEMO_EVENT_COUNT, DEFAULT_EVENT_COUNT);
  const gates = profile.gates && profile.gates.length > 0 ? profile.gates : DEFAULT_GATES;
  const batchId = `${Date.now()}`;

  const deleted = await clearPreviousDemoBatch(db, tid, profile.id);
  const events = buildSeedEvents({
    count,
    gates,
    students,
    profileId: profile.id,
    classScopes,
    batchId,
  });

  const col = db.collection(tenancy.pickupEventsPath(tid));
  let created = 0;
  for (const payload of events) {
    await col.doc().set(payload);
    created += 1;
  }

  return {
    triggered: true,
    profileId: profile.id,
    profileName: profile.name,
    classScopes,
    eventCount: created,
    deletedPrevious: deleted,
    batchId,
    teacherEmail,
    reason,
    actorEmail,
  };
}

async function maybeSeedPickupDemoOnClaim({
  db,
  tid,
  profileId,
  profileName,
  claimedBy,
}) {
  return runPickupDemoSeed({
    db,
    tid,
    profileId,
    profileName,
    force: false,
    reason: `claim:${claimedBy || 'unknown'}`,
    actorEmail: null,
    eventCount: null,
  });
}

module.exports = {
  runPickupDemoSeed,
  maybeSeedPickupDemoOnClaim,
};
