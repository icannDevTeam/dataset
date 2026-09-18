const test = require('node:test');
const assert = require('node:assert/strict');

const { effectiveGateStatus } = require('../lib/terminal-gate');

const fridayDuringPickup = new Date('2026-09-11T06:30:00.000Z');
const terminal = {
  windowOpen: '13:40',
  windowClose: '16:00',
  weeklyWindowByDay: {
    fri: { start: '09:00', end: '16:00', closedAllDay: false },
  },
};

test('manual open preserves the effective Friday schedule metadata', () => {
  const status = effectiveGateStatus(
    { ...terminal, gateOverride: 'open' },
    null,
    fridayDuringPickup,
  );

  assert.equal(status.open, true);
  assert.equal(status.reason, 'manual-open');
  assert.equal(status.manualOverride, 'open');
  assert.deepEqual(status.scheduled, {
    configured: true,
    opensAt: '09:00',
    closesAt: '16:00',
    open: true,
  });
});

test('manual close preserves the effective Friday schedule metadata', () => {
  const status = effectiveGateStatus(
    { ...terminal, gateOverride: 'closed' },
    null,
    fridayDuringPickup,
  );

  assert.equal(status.open, false);
  assert.equal(status.reason, 'manual-closed');
  assert.equal(status.manualOverride, 'closed');
  assert.equal(status.scheduled.opensAt, '09:00');
  assert.equal(status.scheduled.closesAt, '16:00');
  assert.equal(status.scheduled.open, true);
});