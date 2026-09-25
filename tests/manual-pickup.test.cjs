const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildManualEvent,
  compactStudent,
  manualEventId,
  manualEventMatchesIntent,
  normalizeSearchText,
  openReleaseScopeTokens,
  releaseScopeTokens,
  searchStudents,
  studentMatchesScopes,
  validateRelationship,
} = require('../lib/manual-pickup');

test('scope matching is fail-closed and supports shared Grade 1', () => {
  const poleOne = releaseScopeTokens([{ gradeScopes: ['EY1', 'EY2', 'EY3', '1'] }], {});
  const poleTwo = releaseScopeTokens([{ gradeScopes: ['1', '2'] }], {});
  const gradeOne = { homeroom: '1A' };

  assert.equal(studentMatchesScopes(gradeOne, poleOne), true);
  assert.equal(studentMatchesScopes(gradeOne, poleTwo), true);
  assert.equal(studentMatchesScopes({ homeroom: '4C' }, poleTwo), false);
  assert.equal(studentMatchesScopes({ name: 'Unknown Grade' }, poleTwo), false);
  assert.equal(studentMatchesScopes(gradeOne, new Set()), false);
});

test('EY students match specific and broad EY scope tokens', () => {
  const specific = releaseScopeTokens([{ gradeScopes: ['EY2'] }], {});
  const broad = releaseScopeTokens([{ gradeScopes: ['EY'] }], {});
  assert.equal(studentMatchesScopes({ homeroom: 'EY2A' }, specific), true);
  assert.equal(studentMatchesScopes({ homeroom: 'EY2A' }, broad), true);
});

test('closed terminals do not contribute manual-release grade scope', () => {
  const terminals = [
    { gradeScopes: ['1'] },
    { gradeScopes: ['4'] },
  ];
  const scopes = openReleaseScopeTokens(terminals, [{ open: true }, { open: false }], {});
  assert.equal(studentMatchesScopes({ homeroom: '1A' }, scopes), true);
  assert.equal(studentMatchesScopes({ homeroom: '4C' }, scopes), false);
});

test('search starts at two normalized characters and returns all ranked matches', () => {
  const students = [
    compactStudent('a', { binusId: '1002', name: 'José Tan', homeroom: '1A' }),
    compactStudent('b', { binusId: '1001', name: 'Joanna Lim', homeroom: '1B' }),
    compactStudent('c', { binusId: '2010', name: 'Anjo Putra', homeroom: '2A' }),
  ];
  assert.deepEqual(searchStudents(students, 'j'), []);
  assert.deepEqual(searchStudents(students, '  JÓ  ').map((s) => s.name), [
    'Joanna Lim',
    'José Tan',
    'Anjo Putra',
  ]);
  assert.equal(normalizeSearchText('  JÓ--Tan '), 'jo tan');
});

test('manual relationship stores relationship only', () => {
  assert.equal(validateRelationship('Mother'), 'Mother');
  assert.equal(validateRelationship('Father'), 'Father');
  assert.equal(validateRelationship('Guardian'), 'Guardian');
  assert.equal(validateRelationship('Driver'), null);
  assert.equal(validateRelationship('mother'), null);
});

test('manual event id is deterministic for safe retries', () => {
  const first = manualEventId('tablet-1', 'request-123');
  assert.equal(first, manualEventId('tablet-1', 'request-123'));
  assert.notEqual(first, manualEventId('tablet-1', 'request-124'));
  assert.match(first, /^manual-[a-f0-9]{32}$/);
});

test('production-sized local search returns every match within the latency budget', () => {
  const students = Array.from({ length: 5000 }, (_, index) => compactStudent(`doc-${index}`, {
    binusId: String(1000000000 + index),
    name: index % 10 === 0 ? `Alexander Student ${index}` : `Student ${index}`,
    homeroom: `${(index % 5) + 1}A`,
  }));
  const started = performance.now();
  const results = searchStudents(students, 'al');
  const elapsed = performance.now() - started;
  assert.equal(results.length, 500);
  assert.ok(elapsed < 50, `expected local search under 50ms, got ${elapsed.toFixed(2)}ms`);
});

test('manual event contains relationship but no collector identity PII', () => {
  const timestamp = { serverTimestamp: true };
  const event = buildManualEvent({
    eventId: 'manual-abc',
    tenantId: 'school',
    context: {
      device: { id: 'tablet-1', deviceLabel: 'Pole 2 iPad' },
      releaseGroup: { id: 'pole-2', name: 'Pole 2' },
    },
    student: compactStudent('student-1', { binusId: '1234567890', name: 'Test Student', homeroom: '1A' }),
    relationship: 'Mother',
    timestamp,
  });
  assert.equal(event.method, 'manual');
  assert.equal(event.status, 'released');
  assert.deepEqual(event.chaperone, { relation: 'Mother', registered: false });
  assert.equal(event.teacherRelease.displayName, 'Pole 2 iPad');
  assert.equal(event.recordedAt, timestamp);
  assert.equal('name' in event.chaperone, false);
  assert.equal(JSON.stringify(event).includes('collectorName'), false);
  assert.equal(JSON.stringify(event).includes('phone'), false);
  assert.equal(JSON.stringify(event).includes('idNumber'), false);
  assert.equal(manualEventMatchesIntent(event, {
    context: { releaseGroup: { id: 'pole-2' } },
    student: { id: 'student-1' },
    relationship: 'Mother',
  }), true);
  assert.equal(manualEventMatchesIntent(event, {
    context: { releaseGroup: { id: 'pole-2' } },
    student: { id: 'different-student' },
    relationship: 'Mother',
  }), false);
});

test('manual release email job uses guardian details and the release email template', () => {
  const { buildManualReleaseEmailJob } = require('../lib/manual-pickup');
  const job = buildManualReleaseEmailJob({
    tenantId: 'school',
    eventId: 'manual-123',
    guardianEmail: 'parent@example.com',
    guardianName: 'Jane Parent',
    chaperoneName: 'Jane',
    relationship: 'Mother',
    studentNames: ['Alice', 'Bob'],
    gate: 'Pole 1',
    releasedAtWib: '15:00',
    source: 'tablet-manual-release',
  });

  assert.equal(job.to, 'parent@example.com');
  assert.equal(job.templateType, 'pickup_child_released');
  assert.equal(job.source, 'tablet-manual-release');
  assert.deepEqual(job.templateData.studentNames, ['Alice', 'Bob']);
  assert.equal(job.templateData.guardianName, 'Jane Parent');
  assert.equal(job.templateData.gate, 'Pole 1');
});