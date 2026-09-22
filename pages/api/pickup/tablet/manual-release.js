import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { auditLogPath } = require('../../../../lib/audit-log');
const {
  buildManualEvent,
  compactStudent,
  manualEventId,
  manualEventMatchesIntent,
  studentMatchesScopes,
  validateRelationship,
} = require('../../../../lib/manual-pickup');
const { resolveTabletReleaseContext } = require('../../../../lib/tablet-release-context');
const { enforceRateLimit } = require('../../../../lib/rate-limit');

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const FORBIDDEN_COLLECTOR_FIELDS = ['collectorName', 'name', 'phone', 'idNumber', 'notes', 'note'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (process.env.MANUAL_PICKUP_ENABLED !== 'true') return res.status(404).json({ error: 'not_found' });
  const token = req.headers['x-tablet-device-token'] || req.body?.deviceToken;
  if (!token) return res.status(401).json({ error: 'deviceToken required' });

  const studentId = String(req.body?.studentId || '').trim();
  const requestId = String(req.body?.requestId || '').trim();
  const relationship = validateRelationship(req.body?.relationship);
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  if (!REQUEST_ID_RE.test(requestId)) return res.status(400).json({ error: 'invalid requestId' });
  if (!relationship) return res.status(400).json({ error: 'relationship must be Mother, Father, or Guardian' });
  if (FORBIDDEN_COLLECTOR_FIELDS.some((field) => req.body?.[field] != null)) {
    return res.status(400).json({ error: 'collector PII is not accepted' });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tenantId = tenancy.getTenantId(req.body?.tenant);
    const context = await resolveTabletReleaseContext(db, tenantId, token);
    if (context.error) return res.status(context.status).json({ error: context.error });
    if (!context.inWindow) return res.status(409).json({ error: 'release window is closed' });

    const limited = enforceRateLimit(
      'pickup:tablet-manual-release', `${tenantId}:${context.device.id}`, { max: 60, windowMs: 60_000 }
    );
    if (!limited.allowed) {
      res.setHeader('Retry-After', limited.retryAfter);
      return res.status(429).json({ error: 'rate_limited', retryAfter: limited.retryAfter });
    }

    let studentSnap = await db.doc(`${tenancy.studentsPath(tenantId)}/${studentId}`).get();
    if (!studentSnap.exists) {
      studentSnap = await db.doc(`${tenancy.studentMetadataPath(tenantId)}/${studentId}`).get();
    }
    if (!studentSnap.exists) return res.status(404).json({ error: 'student not found' });
    const student = compactStudent(studentSnap.id, studentSnap.data() || {});
    if (!student.name || !studentMatchesScopes(student, context.scopeTokens)) {
      return res.status(403).json({ error: 'student not eligible for this release group' });
    }

    const eventId = manualEventId(context.device.id, requestId);
    const eventRef = db.doc(`${tenancy.pickupEventsPath(tenantId)}/${eventId}`);
    const auditRef = db.doc(`${auditLogPath(tenantId)}/${eventId}`);
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const event = buildManualEvent({
      eventId, tenantId, context, student, relationship, timestamp,
    });
    const audit = {
      at: new Date().toISOString(),
      actor: { email: null, name: context.device.deviceLabel || context.device.id, role: 'tablet' },
      ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
        || req.headers['x-real-ip'] || req.socket?.remoteAddress || null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200) || null,
      kind: 'pickup.manual_release',
      target: { type: 'student', id: student.id, label: student.name },
      before: null,
      after: { relationship, releaseGroupId: context.releaseGroup.id, eventId },
      summary: `${student.name} manually released to ${relationship}`,
      metadata: {
        eventId,
        tabletId: context.device.id,
        tabletLabel: context.device.deviceLabel || null,
        releaseGroupId: context.releaseGroup.id,
        releaseGroupName: context.releaseGroup.name || null,
      },
    };

    let duplicate = false;
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(eventRef);
      const existingAudit = await transaction.get(auditRef);
      if (existing.exists) {
        if (!manualEventMatchesIntent(existing.data(), { context, student, relationship })) {
          const conflict = new Error('requestId already used for a different release');
          conflict.status = 409;
          throw conflict;
        }
        duplicate = true;
      } else {
        transaction.create(eventRef, event);
      }
      if (!existingAudit.exists) transaction.set(auditRef, audit);
    });

    const persisted = await eventRef.get();
    const releasedAtValue = persisted.data()?.teacherRelease?.at || persisted.data()?.recordedAt;
    const releasedAt = releasedAtValue?.toDate?.()?.toISOString?.() || audit.at;

    return res.status(duplicate ? 200 : 201).json({
      ok: true,
      duplicate,
      eventId,
      releasedAt,
    });
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: 'idempotency_conflict' });
    console.error('[pickup/tablet/manual-release]', error.message);
    return res.status(500).json({ error: 'internal' });
  }
}