const crypto = require('crypto');
const { gradeTokensFromHomeroom } = require('./shape-pickup-event');
const { normalizeSearchText, searchStudents } = require('./manual-pickup-search');

const MANUAL_RELATIONSHIPS = new Set(['Mother', 'Father', 'Guardian']);

function normalizeScopeToken(value) {
  return String(value || '').trim().toUpperCase().replace(/^GRADE\s*/, '');
}

function releaseScopeTokens(terminals, releaseGroup) {
  const terminalTokens = new Set();
  for (const terminal of terminals || []) {
    const scopes = Array.isArray(terminal?.gradeScopes) ? terminal.gradeScopes : [];
    for (const scope of scopes) {
      const token = normalizeScopeToken(scope);
      if (token) terminalTokens.add(token);
    }
  }
  if (terminalTokens.size > 0) return terminalTokens;

  const fallback = normalizeScopeToken(releaseGroup?.gradeLabel);
  return fallback ? new Set([fallback]) : new Set();
}

function openReleaseScopeTokens(terminals, gateStates, releaseGroup) {
  const openTerminals = (terminals || []).filter((terminal, index) => gateStates?.[index]?.open === true);
  if (openTerminals.length === 0) return new Set();
  return releaseScopeTokens(openTerminals, releaseGroup);
}

function studentGradeTokens(student) {
  const values = [
    student?.homeroom,
    student?.className,
    student?.class,
    student?.gradeSelection,
    student?.grade,
    student?.level,
  ];
  const tokens = new Set();
  for (const value of values) {
    gradeTokensFromHomeroom(value).forEach((token) => tokens.add(normalizeScopeToken(token)));
    const direct = normalizeScopeToken(value);
    if (/^(?:\d{1,2}|EY\d*)$/.test(direct)) tokens.add(direct);
  }
  return tokens;
}

function studentMatchesScopes(student, scopeTokens) {
  if (!(scopeTokens instanceof Set) || scopeTokens.size === 0) return false;
  const tokens = studentGradeTokens(student);
  if (tokens.size === 0) return false;
  return [...tokens].some((token) => scopeTokens.has(token));
}

function compactStudent(id, data = {}) {
  const homeroom = String(data.homeroom || data.class || data.className || '').trim().toUpperCase();
  const studentId = String(data.binusId || data.binusianId || data.studentId || id || '').trim();
  const name = String(data.name || data.fullName || data.studentName || '').trim();
  const grade = [...studentGradeTokens({ ...data, homeroom })][0] || null;
  const searchId = normalizeSearchText(studentId || id);
  const searchName = normalizeSearchText(name);
  const searchHomeroom = normalizeSearchText(homeroom);
  const searchTokens = searchName.split(' ').filter(Boolean);
  const searchKey = [searchId, searchName, searchHomeroom].filter(Boolean).join(' ');
  return {
    id: String(id || studentId), studentId, name, homeroom, grade,
    searchKey, searchId, searchName, searchHomeroom, searchTokens,
  };
}

function validateRelationship(value) {
  const normalized = String(value || '').trim();
  return MANUAL_RELATIONSHIPS.has(normalized) ? normalized : null;
}

function manualEventId(deviceId, requestId) {
  const input = `${String(deviceId || '').trim()}|${String(requestId || '').trim()}`;
  return `manual-${crypto.createHash('sha256').update(input).digest('hex').slice(0, 32)}`;
}

function buildManualEvent({ eventId, tenantId, context, student, relationship, timestamp }) {
  return {
    eventId,
    tenantId,
    method: 'manual',
    source: 'tablet_manual',
    status: 'released',
    decision: 'manual_release',
    cardState: 'green',
    releaseGroupId: context.releaseGroup.id,
    releaseGroupName: context.releaseGroup.name || context.releaseGroup.id,
    gate: context.releaseGroup.name || context.releaseGroup.id,
    students: [{
      id: student.id,
      binusId: student.studentId,
      name: student.name,
      homeroom: student.homeroom,
    }],
    chaperone: { relation: relationship, registered: false },
    recordedAt: timestamp,
    teacherRelease: {
      by: `tablet:${context.device.id}`,
      displayName: context.device.deviceLabel || context.device.id,
      at: timestamp,
      action: 'release',
      flagged: false,
      note: null,
      via: 'manual',
    },
  };
}

function manualEventMatchesIntent(event, { context, student, relationship }) {
  const recordedStudent = Array.isArray(event?.students) ? event.students[0] : null;
  return event?.method === 'manual'
    && event?.releaseGroupId === context?.releaseGroup?.id
    && recordedStudent?.id === student?.id
    && event?.chaperone?.relation === relationship;
}

function buildManualReleaseEmailJob({
  tenantId,
  eventId,
  guardianEmail,
  guardianName,
  chaperoneName,
  relationship,
  studentNames,
  gate,
  releasedAtWib,
  source = 'tablet-manual-release',
}) {
  return {
    status: 'pending',
    to: String(guardianEmail || '').trim(),
    templateType: 'pickup_child_released',
    tenantId,
    recordId: eventId,
    templateData: {
      guardianName: guardianName || 'Parent/Guardian',
      studentNames: Array.isArray(studentNames) ? studentNames.filter(Boolean) : [],
      chaperoneName: chaperoneName || '',
      chaperoneRelation: relationship || '',
      gate: gate || '',
      releasedAtWib: releasedAtWib || '',
    },
    retryCount: 0,
    maxRetries: 3,
    source,
  };
}

module.exports = {
  MANUAL_RELATIONSHIPS,
  buildManualEvent,
  buildManualReleaseEmailJob,
  compactStudent,
  manualEventId,
  manualEventMatchesIntent,
  normalizeSearchText,
  openReleaseScopeTokens,
  releaseScopeTokens,
  searchStudents,
  studentGradeTokens,
  studentMatchesScopes,
  validateRelationship,
};