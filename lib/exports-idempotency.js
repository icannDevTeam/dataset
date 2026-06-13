import { db } from './firebase-admin';
import crypto from 'crypto';

/**
 * Generate a stable hash for an export request to enable deduplication.
 * Same inputs always produce the same hash.
 */
export function hashExportRequest(ctx) {
  const { cardId, format, from, to, filters } = ctx;
  const combined = `${cardId}|${format}|${from}|${to}|${JSON.stringify(filters || {})}`;
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 12);
}

/**
 * Query for an existing export job with the given idempotency key
 * within the dedup window (defaults to 1 minute).
 */
export async function queryJobByIdempotencyKey(tenantId, idempotencyKey, windowMs = 60000) {
  const nowMs = Date.now();
  const windowStart = nowMs - windowMs;

  const snap = await db
    .collection('exportJobs')
    .where('tenantId', '==', tenantId)
    .where('idempotencyKey', '==', idempotencyKey)
    .where('createdAt', '>=', new Date(windowStart))
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();

  // Return the job if it's not failed (failed jobs can be resubmitted)
  if (data.status !== 'failed') {
    return { id: doc.id, ...data };
  }

  return null; // Expired or failed; allow new submission
}

/**
 * Create a new export job with idempotency key and return its ID.
 */
export async function createNewExportJob(ctx) {
  const {
    tenantId,
    cardId,
    format,
    from,
    to,
    filters,
    actor,
    idempotencyKey,
  } = ctx;

  const jobData = {
    tenantId,
    cardId,
    format,
    from,
    to,
    filters,
    actor,
    idempotencyKey,
    status: 'queued', // queued | running | completed | failed
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastError: null,
    rowCount: 0,
    filename: null,
    storagePath: null,
    contentType: null,
    notificationSent: false,
  };

  const ref = await db.collection('exportJobs').add(jobData);
  return ref.id;
}

/**
 * Wrapper to get or create an export job (dedup-aware).
 */
export async function getOrCreateExportJob(ctx) {
  const deduplicateWindowMinutes =
    parseInt(process.env.EXPORT_DEDUP_WINDOW_MIN || '1', 10) * 60 * 1000;

  const idempotencyKey = hashExportRequest(ctx);
  const existing = await queryJobByIdempotencyKey(
    ctx.tenantId,
    idempotencyKey,
    deduplicateWindowMinutes
  );

  if (existing) {
    return existing.id; // Return existing job ID
  }

  // Create new job
  return createNewExportJob({ ...ctx, idempotencyKey });
}
