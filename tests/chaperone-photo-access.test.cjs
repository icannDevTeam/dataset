const test = require('node:test');
const assert = require('node:assert/strict');
const { allowChaperoneAction } = require('../lib/chaperone-photo-access.js');

test('approved form chaperone add-face is allowed', () => {
  assert.equal(allowChaperoneAction('chaperone', 'add-face', 'approved'), true);
});

test('approved form chaperone delete-face is allowed', () => {
  assert.equal(allowChaperoneAction('chaperone', 'delete-face', 'approved'), true);
});

test('approved form chaperone update remains blocked', () => {
  assert.equal(allowChaperoneAction('chaperone', 'update', 'approved'), false);
});

test('pending form chaperone add-face is still allowed', () => {
  assert.equal(allowChaperoneAction('chaperone', 'add-face', 'pending'), true);
});
