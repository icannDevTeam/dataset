/**
 * Unit tests for lib/pickup-event-bus.js
 *
 * The bus is the SSE broker: subscribers register via subscribe(), and the
 * bus starts a per-tenant Firestore onSnapshot listener on first subscribe.
 * When the listener fires with a new doc, it shapes the payload and writes
 * an `event: pickup_event` frame to each matching subscriber's response.
 *
 * Strategy: pre-populate require.cache with stubs for firebase-admin,
 * firebase-admin module, lib/firebase-admin, lib/tenancy, and the shaper.
 * Then require() the bus fresh — it picks up our stubs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// ── Stub registry ───────────────────────────────────────────────────────────
const snapshotCallbacks = new Map(); // tenantId -> onNext function

function resetStubs() {
  snapshotCallbacks.clear();
  // Drop the bus from cache so it re-evaluates with our stubs.
  const busPath = require.resolve('../lib/pickup-event-bus');
  delete require.cache[busPath];
  const shaperPath = require.resolve('../lib/shape-pickup-event');
  delete require.cache[shaperPath];
}

function installStubs() {
  resetStubs();

  // Stub firebase-admin
  const fakeTimestamp = { fromMillis: (ms) => ({ _ms: ms }) };
  const fakeAdmin = {
    firestore: () => ({
      collection: (path) => {
        const tenantId = path.split('/')[1];
        return {
          where() { return this; },
          onSnapshot(onNext, onErr) {
            snapshotCallbacks.set(tenantId, { onNext, onErr });
            return () => snapshotCallbacks.delete(tenantId);
          },
        };
      },
    }),
  };
  fakeAdmin.firestore.Timestamp = fakeTimestamp;
  require.cache[require.resolve('firebase-admin')] = {
    id: require.resolve('firebase-admin'),
    filename: require.resolve('firebase-admin'),
    loaded: true,
    exports: fakeAdmin,
  };

  // Stub lib/firebase-admin
  const fbHelperPath = require.resolve('../lib/firebase-admin');
  require.cache[fbHelperPath] = {
    id: fbHelperPath, filename: fbHelperPath, loaded: true,
    exports: {
      initializeFirebase: () => {},
      getFirebaseStorage: () => ({
        bucket: () => ({
          file: () => ({ async getSignedUrl() { return ['https://stub/sig']; } }),
          async getFiles() { return [[]]; },
        }),
      }),
    },
  };

  // Stub lib/tenancy
  const tenancyPath = require.resolve('../lib/tenancy');
  require.cache[tenancyPath] = {
    id: tenancyPath, filename: tenancyPath, loaded: true,
    exports: {
      pickupEventsPath: (tid) => `tenants/${tid}/pickup_events`,
      getTenantId: () => 'binus-simprug',
    },
  };
}

// ── Mock SSE response object ────────────────────────────────────────────────
class MockRes extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.ended = false;
  }
  write(buf) { this.chunks.push(String(buf)); return true; }
  end() { this.ended = true; this.emit('close'); }
}

// Helper: simulate a Firestore added-change with a fake DocumentSnapshot
function fireAdded(tenantId, docId, data) {
  const cb = snapshotCallbacks.get(tenantId);
  if (!cb) throw new Error(`no listener for ${tenantId}`);
  const fakeSnap = {
    docChanges: () => [{
      type: 'added',
      doc: { id: docId, data: () => data },
    }],
  };
  return Promise.resolve().then(() => cb.onNext(fakeSnap));
}

// ── Tests ───────────────────────────────────────────────────────────────────
test('subscribe: first subscriber starts a Firestore listener', () => {
  installStubs();
  const bus = require('../lib/pickup-event-bus');
  const res = new MockRes();
  const unsub = bus.subscribe('binus-simprug', [], res);
  assert.ok(snapshotCallbacks.has('binus-simprug'), 'listener attached');
  const s = bus.stats();
  assert.equal(s['binus-simprug'].subscribers, 1);
  assert.equal(s['binus-simprug'].listener, true);
  unsub();
});

test('subscribe: last unsubscribe tears down the listener', () => {
  installStubs();
  const bus = require('../lib/pickup-event-bus');
  const r1 = new MockRes(), r2 = new MockRes();
  const u1 = bus.subscribe('binus-simprug', [], r1);
  const u2 = bus.subscribe('binus-simprug', [], r2);
  assert.equal(snapshotCallbacks.size, 1, 'only one listener for both subs');
  u1();
  assert.equal(snapshotCallbacks.size, 1, 'still alive while r2 subscribed');
  u2();
  assert.equal(snapshotCallbacks.size, 0, 'torn down after last unsub');
});

test('broadcast: new doc fans out as SSE pickup_event frame', async () => {
  installStubs();
  const bus = require('../lib/pickup-event-bus');
  const res = new MockRes();
  const unsub = bus.subscribe('binus-simprug', [], res);

  await fireAdded('binus-simprug', 'evt-101', {
    decision: 'ok', cardState: 'green', terminalId: 'term-a',
    chaperone: { displayName: 'Parent' }, students: [],
  });

  const pickupFrames = res.chunks.filter((c) => c.startsWith('event: pickup_event\n'));
  assert.equal(pickupFrames.length, 1, 'one SSE frame delivered');
  const dataLine = pickupFrames[0].split('\n').find((l) => l.startsWith('data: '));
  const payload = JSON.parse(dataLine.slice(6));
  assert.equal(payload.id, 'evt-101');
  assert.equal(payload.terminalId, 'term-a');
  unsub();
});

test('broadcast: terminalIds filter scopes delivery to bound release group', async () => {
  installStubs();
  const bus = require('../lib/pickup-event-bus');
  const subAll = new MockRes();
  const subA = new MockRes();
  const subB = new MockRes();
  const u1 = bus.subscribe('binus-simprug', [], subAll);
  const u2 = bus.subscribe('binus-simprug', ['term-a'], subA);
  const u3 = bus.subscribe('binus-simprug', ['term-b'], subB);

  await fireAdded('binus-simprug', 'evt-A', {
    decision: 'ok', terminalId: 'term-a', students: [],
  });

  assert.equal(subAll.chunks.filter((c) => c.includes('pickup_event')).length, 1);
  assert.equal(subA.chunks.filter((c) => c.includes('pickup_event')).length, 1);
  assert.equal(subB.chunks.filter((c) => c.includes('pickup_event')).length, 0,
    'subscriber filtered to term-b must NOT receive term-a event');
  u1(); u2(); u3();
});

test('subscribe: heartbeats keep the stream alive (manual tick)', async () => {
  installStubs();
  const bus = require('../lib/pickup-event-bus');
  const res = new MockRes();
  const unsub = bus.subscribe('binus-simprug', [], res);
  // No fake-timers here — just assert that no pickup_event frame is sent
  // unless the listener fires. Comments/heartbeats are written by setInterval.
  await new Promise((r) => setTimeout(r, 10));
  const pickup = res.chunks.filter((c) => c.startsWith('event: pickup_event'));
  assert.equal(pickup.length, 0);
  unsub();
});

test('res close event triggers unsubscribe', () => {
  installStubs();
  const bus = require('../lib/pickup-event-bus');
  const res = new MockRes();
  bus.subscribe('binus-simprug', [], res);
  assert.equal(snapshotCallbacks.size, 1);
  res.emit('close');
  assert.equal(snapshotCallbacks.size, 0, 'listener released on client close');
});
