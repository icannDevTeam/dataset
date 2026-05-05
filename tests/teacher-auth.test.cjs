const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeClassScopes,
  isTeacherEmail,
  classesIntersect,
} = require('../lib/teacher-auth');

test('sanitizeClassScopes uppercases, trims, deduplicates, and drops empties', () => {
  const scopes = [' 4c ', '4C', '', null, '6b', ' 6B '];
  assert.deepEqual(sanitizeClassScopes(scopes), ['4C', '6B']);
});

test('isTeacherEmail enforces exact configured domain', () => {
  assert.equal(isTeacherEmail('teacher@binus.edu', 'binus.edu'), true);
  assert.equal(isTeacherEmail('teacher@school.com', 'binus.edu'), false);
  assert.equal(isTeacherEmail('teacher@sub.binus.edu', 'binus.edu'), false);
});

test('classesIntersect matches classes case-insensitively', () => {
  assert.equal(classesIntersect(['4C', '6B'], ['4c']), true);
  assert.equal(classesIntersect(['4C', '6B'], ['7A']), false);
});
