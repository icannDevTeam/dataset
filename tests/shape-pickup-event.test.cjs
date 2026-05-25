/**
 * Unit tests for lib/shape-pickup-event.js
 *
 * Verifies the wire-format shaper used by both:
 *   - /api/pickup/tablet/feed.js (polling / initial hydration)
 *   - lib/pickup-event-bus.js    (SSE broadcaster)
 *
 * Both paths must emit byte-identical payloads so the iPad PWA doesn't care
 * which channel delivered the event.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { shapePickupEvent, SILENT_ON_IPAD } =
  require('../lib/shape-pickup-event');

// ── Mock Storage bucket ─────────────────────────────────────────────────────
function makeBucket() {
  return {
    file(path) {
      return {
        async getSignedUrl() { return [`https://signed.example/${path}?ttl=300`]; },
      };
    },
    async getFiles({ prefix }) {
      if (prefix.includes('/UNKNOWN/')) return [[]];
      return [[{ name: `${prefix}photo-001.jpg` }]];
    },
  };
}

// Synthetic Firestore DocumentSnapshot
function makeDoc(id, data) {
  return {
    id,
    data: () => data,
  };
}

const tid = 'binus-simprug';

test('shapePickupEvent: full payload with chaperone + students + capture', async () => {
  const bucket = makeBucket();
  const doc = makeDoc('evt-1', {
    eventId: 'evt-1',
    scannedAt: '2026-05-25T07:30:00.000Z',
    recordedAt: '2026-05-25T07:30:00.500Z',
    deviceName: 'Basement 1',
    gate: 'basement',
    terminalId: 'term-bsm-1',
    decision: 'ok',
    cardState: 'green',
    holdSeconds: 45,
    status: 'pending',
    chaperone: {
      chaperoneId: '9001',
      displayName: 'Test Parent',
      photoUrl: 'tenants/binus-simprug/chaperones/9001/face.jpg',
    },
    students: [
      { name: 'Alice Test', homeroom: '4A' },
      { name: 'Bob Test', homeroom: '4A', photoUrl: 'https://prefilled.example/bob.jpg' },
    ],
    capturePath: 'tenants/binus-simprug/captures/evt-1.jpg',
  });

  const shaped = await shapePickupEvent(bucket, tid, doc);
  assert.equal(shaped.id, 'evt-1');
  assert.equal(shaped.terminalId, 'term-bsm-1');
  assert.equal(shaped.status, 'pending');
  assert.equal(shaped.cardState, 'green');
  assert.equal(shaped.blocked, false);
  assert.equal(shaped.holdSeconds, 45);

  // Chaperone photo signed from storage path.
  assert.match(shaped.chaperone.photoUrl, /^https:\/\/signed\.example\/tenants\/binus-simprug\/chaperones\/9001\/face\.jpg/);

  // Student[0]: no photoUrl → resolved via face_dataset listing.
  assert.match(shaped.students[0].photoUrl, /face_dataset\/4A\/Alice Test\/photo-001\.jpg/);

  // Student[1]: pre-supplied https URL passed through untouched.
  assert.equal(shaped.students[1].photoUrl, 'https://prefilled.example/bob.jpg');

  // Capture image signed.
  assert.match(shaped.capturePath, /^https:\/\/signed\.example\/tenants\/binus-simprug\/captures\/evt-1\.jpg/);
});

test('shapePickupEvent: blocked=true when decision === unknown_chaperone', async () => {
  const bucket = makeBucket();
  const doc = makeDoc('evt-2', {
    decision: 'unknown_chaperone',
    cardState: 'red',
    chaperone: {},
    students: [],
  });
  const shaped = await shapePickupEvent(bucket, tid, doc);
  assert.equal(shaped.blocked, true);
});

test('shapePickupEvent: tolerates missing students/chaperone/capture', async () => {
  const bucket = makeBucket();
  const doc = makeDoc('evt-3', {
    decision: 'ok',
    cardState: 'green',
  });
  const shaped = await shapePickupEvent(bucket, tid, doc);
  assert.deepEqual(shaped.students, []);
  assert.equal(shaped.chaperone.photoUrl, null);
  assert.equal(shaped.capturePath, null);
  assert.equal(shaped.status, 'pending'); // default
});

test('shapePickupEvent: Firestore Timestamp objects coerced to ISO', async () => {
  const bucket = makeBucket();
  const ts = { toDate: () => new Date('2026-05-25T08:00:00.000Z') };
  const doc = makeDoc('evt-4', {
    scannedAt: ts,
    recordedAt: ts,
    teacherRelease: { at: ts, by: 'teacher@x' },
    decision: 'ok',
  });
  const shaped = await shapePickupEvent(bucket, tid, doc);
  assert.equal(shaped.scannedAt, '2026-05-25T08:00:00.000Z');
  assert.equal(shaped.recordedAt, '2026-05-25T08:00:00.000Z');
  assert.equal(shaped.teacherRelease.at, '2026-05-25T08:00:00.000Z');
  assert.equal(shaped.teacherRelease.by, 'teacher@x');
});

test('SILENT_ON_IPAD: hides audit-only decisions from the teacher app', () => {
  assert.equal(SILENT_ON_IPAD.has('outside_window'), true);
  assert.equal(SILENT_ON_IPAD.has('unknown_chaperone'), true);
  assert.equal(SILENT_ON_IPAD.has('wrong_terminal'), true);
  // Real-delivery decisions must NOT be silent.
  assert.equal(SILENT_ON_IPAD.has('ok'), false);
  assert.equal(SILENT_ON_IPAD.has('hold'), false);
});

test('shapePickupEvent: student photo cache short-circuits second lookup', async () => {
  let getFilesCalls = 0;
  const bucket = {
    file: (path) => ({ async getSignedUrl() { return [`https://s/${path}`]; } }),
    async getFiles({ prefix }) {
      getFilesCalls += 1;
      return [[{ name: `${prefix}cached.jpg` }]];
    },
  };
  const doc1 = makeDoc('a', { decision: 'ok', students: [{ name: 'Cache Hit', homeroom: '5A' }] });
  const doc2 = makeDoc('b', { decision: 'ok', students: [{ name: 'Cache Hit', homeroom: '5A' }] });
  await shapePickupEvent(bucket, tid, doc1);
  await shapePickupEvent(bucket, tid, doc2);
  // Same (homeroom,name) → second lookup served from cache.
  assert.equal(getFilesCalls, 1, 'second call should hit student-path cache');
});
