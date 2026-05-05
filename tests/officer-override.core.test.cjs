/**
 * Integration tests for officer-override-core.cjs
 *
 * Tests the full authorization + Firestore interaction logic with a
 * mock Firestore client. No real Firebase or HTTP server needed.
 *
 * Scenarios covered:
 *   1. No session cookie  → 401
 *   2. Unknown user       → 403
 *   3. Viewer role        → 403
 *   4. Disabled account   → 403
 *   5. Code not found     → 404
 *   6. Code expired       → 404
 *   7. Admin approves     → 200, audit written
 *   8. Teacher, matching class  → 200, byRole=teacher, classScopes stamped
 *   9. Teacher, no class scope  → 403
 *  10. Teacher, wrong class     → 403
 *  11. Already overridden       → 409
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { runOfficerOverride } = require('../lib/officer-override-core.cjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = 1_746_000_000_000; // fixed clock so tests are deterministic

/**
 * Build a minimal mock Firestore client.
 *
 * @param {object} opts
 * @param {object|null}  opts.user          - dashboard_users doc data (null = not found)
 * @param {Array}        opts.eventDocs     - docs returned by the pickup_events query
 * @param {Array}        opts.written       - filled in by set/add calls for assertions
 */
function mockDb({ user = null, eventDocs = [], written = [] } = {}) {
  return {
    collection(path) {
      return {
        doc(id) {
          return {
            async get() {
              if (path === 'dashboard_users') {
                return user
                  ? { exists: true, data: () => user }
                  : { exists: false, data: () => null };
              }
              return { exists: false, data: () => null };
            },
          };
        },
        where() { return this; },
        limit() { return this; },
        async get() {
          // pickup_events query
          return { docs: eventDocs };
        },
        async add(data) {
          written.push({ collection: path, op: 'add', data });
        },
      };
    },
  };
}

/**
 * Build a minimal mock event doc.
 *
 * @param {object} opts
 * @param {string}  opts.code         - overrideCode value
 * @param {number}  opts.ageMs        - how old the event is relative to NOW (default = 1 min old)
 * @param {Array}   [opts.students]   - array of { homeroom } objects
 * @param {object}  [opts.override]   - existing officerOverride (for 409 test)
 */
function mockEventDoc({ code, ageMs = 60_000, students = [], override = undefined } = {}) {
  const written = [];
  const eventData = {
    overrideCode: code,
    recordedAt: { toMillis: () => NOW - ageMs },
    students,
    chaperone: { name: 'Mrs. Tanaka' },
    gate: 'Gate A',
    eventId: 'EVT001',
    employeeNo: 'CHAP001',
    decision: 'pending',
    ...(override ? { officerOverride: override } : {}),
  };

  return {
    id: 'doc-001',
    data: () => eventData,
    ref: {
      async set(upd, opts) {
        written.push({ op: 'set', update: upd, opts });
      },
    },
    _written: written, // exposed for assertions
  };
}

const BASE = {
  tid: 'test-tenant',
  pickupEventsPath: (tid) => `tenants/${tid}/pickup_events`,
  securityIncidentsPath: (tid) => `tenants/${tid}/security_incidents`,
  teacherDomain: 'binus.edu',
  nowMs: NOW,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

test('1. no session → 401', async () => {
  const result = await runOfficerOverride({
    ...BASE,
    session: null,
    code: '123456',
    db: mockDb(),
  });
  assert.equal(result.statusCode, 401);
  assert.match(result.body.error, /login required/);
});

test('2. unknown user → 403', async () => {
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'ghost@binus.edu' },
    code: '123456',
    db: mockDb({ user: null }),
  });
  assert.equal(result.statusCode, 403);
  assert.match(result.body.error, /not authorized/);
});

test('3. viewer role → 403', async () => {
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'viewer@binus.edu' },
    code: '123456',
    db: mockDb({ user: { role: 'viewer', disabled: false } }),
  });
  assert.equal(result.statusCode, 403);
  assert.match(result.body.error, /insufficient role/);
});

test('4. disabled account → 403', async () => {
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'admin@binus.edu' },
    code: '123456',
    db: mockDb({ user: { role: 'admin', disabled: true } }),
  });
  assert.equal(result.statusCode, 403);
  assert.match(result.body.error, /disabled/);
});

test('5. code not found → 404', async () => {
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'admin@binus.edu' },
    code: '999999',
    db: mockDb({
      user: { role: 'admin', disabled: false },
      eventDocs: [], // empty — no matching event
    }),
  });
  assert.equal(result.statusCode, 404);
});

test('6. code too old (expired window) → 404', async () => {
  const expiredDoc = mockEventDoc({
    code: '123456',
    ageMs: 11 * 60 * 1000, // 11 minutes old, window is 10 min
  });
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'admin@binus.edu' },
    code: '123456',
    db: mockDb({
      user: { role: 'admin', disabled: false },
      eventDocs: [expiredDoc],
    }),
  });
  assert.equal(result.statusCode, 404);
});

test('7. admin approves → 200, override written with audit', async () => {
  const written = [];
  const evDoc = mockEventDoc({ code: '123456', students: [{ homeroom: '4C' }] });
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'admin@school.org' },
    code: '123456',
    officer: 'Pak Budi',
    db: mockDb({
      user: { role: 'admin', disabled: false, name: 'Admin Budi' },
      eventDocs: [evDoc],
      written,
    }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.eventId, 'EVT001');
  assert.equal(result.body.chaperone, 'Mrs. Tanaka');

  // Firestore set was called on the event doc
  assert.equal(evDoc._written.length, 1);
  assert.equal(evDoc._written[0].update.officerOverride.decision, 'approved');
  assert.equal(evDoc._written[0].update.officerOverride.byRole, 'admin');
  assert.equal(evDoc._written[0].update.officerOverride.byEmail, 'admin@school.org');
  assert.equal(evDoc._written[0].update.officerOverride.by, 'Pak Budi');
});

test('8. teacher with matching class → 200, classScopes stamped in override', async () => {
  const evDoc = mockEventDoc({ code: '654321', students: [{ homeroom: '4C' }] });
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'ms.diana@binus.edu' },
    code: '654321',
    db: mockDb({
      user: { role: 'teacher', disabled: false, name: 'Ms. Diana', classScopes: ['4C'] },
      eventDocs: [evDoc],
    }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body._override.byRole, 'teacher');
  assert.deepEqual(result.body._override.classScopes, ['4C']);
  assert.equal(result.body._override.by, 'Ms. Diana');
});

test('9. teacher with no class scope assigned → 403', async () => {
  const evDoc = mockEventDoc({ code: '111111', students: [{ homeroom: '4C' }] });
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'ms.diana@binus.edu' },
    code: '111111',
    db: mockDb({
      user: { role: 'teacher', disabled: false, classScopes: [] },
      eventDocs: [evDoc],
    }),
  });
  assert.equal(result.statusCode, 403);
  assert.match(result.body.error, /no class scope/);
});

test('10. teacher with wrong class → 403', async () => {
  const evDoc = mockEventDoc({ code: '222222', students: [{ homeroom: '4C' }] });
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'mr.robot@binus.edu' },
    code: '222222',
    db: mockDb({
      user: { role: 'teacher', disabled: false, classScopes: ['6B'] },
      eventDocs: [evDoc],
    }),
  });
  assert.equal(result.statusCode, 403);
  assert.match(result.body.error, /not in your assigned class/);
});

test('11. event already overridden → 409', async () => {
  const evDoc = mockEventDoc({
    code: '333333',
    students: [{ homeroom: '4C' }],
    override: { by: 'Pak Rudi', decision: 'approved' },
  });
  const result = await runOfficerOverride({
    ...BASE,
    session: { email: 'admin@school.org' },
    code: '333333',
    db: mockDb({
      user: { role: 'admin', disabled: false },
      eventDocs: [evDoc],
    }),
  });
  assert.equal(result.statusCode, 409);
  assert.match(result.body.error, /already overridden/);
  assert.equal(result.body.by, 'Pak Rudi');
});
