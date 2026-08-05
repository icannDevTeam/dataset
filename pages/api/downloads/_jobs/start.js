/**
 * POST /api/downloads/_jobs/start
 *
 * Queue a background export job. Body: { cardId, format, from, to, filters }.
 *
 *   - Verifies the cardId exists in the runner registry.
 *   - Re-auth: 120s (tighter than sync; queuing burns server resources).
 *   - Writes `tenants/{tid}/exportJobs/{jobId}` with status:'queued'.
 *   - M1: runs the job inline immediately after queuing — M2 will move
 *     this to a worker tier (Cloud Tasks / Pub/Sub). The status doc
 *     contract is the same either way so the polling endpoint and the
 *     hub UI don't need to change.
 *   - Audits `downloads.<card>.queued` then `downloads.<card>.job_completed`
 *     (or `downloads.<card>.job_failed`).
 *
 * Response:
 *   { ok:true, jobId, statusUrl }  (always — completion polled separately)
 *   { error:'unknown_card', cardId } on bad cardId
 *
 * Permission: anyPermission on the four download keys. The job execution
 * itself still enforces the card's row cap via the runner.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { getOrCreateExportJob } from '../../../../lib/exports-idempotency';
import { enqueueExportJob } from '../../../../lib/cloud-tasks-client';
const { getRunner, writeReportRun } = require('../../../../lib/download-runner');
const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

const MUST_HAVE_CARD_IDS = new Set([
  'attendance',
  'pickup-events',
  'students-roster',
  'class-directory',
  'security-incidents',
  'audit-log',
]);

export const config = { api: { bodyParser: { sizeLimit: '128kb' } } };

const DOWNLOAD_KEYS = [
  'downloads.download_operational',
  'downloads.download_directory',
  'downloads.download_security',
  'downloads.download_compliance',
];

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { cardId, format, from, to, filters } = req.body || {};
  if (!cardId || typeof cardId !== 'string') {
    return res.status(400).json({ error: 'bad_cardId' });
  }
  if (!MUST_HAVE_CARD_IDS.has(cardId)) {
    return res.status(403).json({ error: 'export_not_allowed', cardId });
  }
  const runnerCfg = getRunner(cardId);
  if (!runnerCfg) {
    return res.status(404).json({ error: 'unknown_card', cardId });
  }

  const fmt = String(format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return res.status(400).json({ error: 'bad_format' });
  }

  // Sensitive ops: tighter re-auth window than sync downloads.
  const { verifyReauth } = require('../../../../lib/reauth');
  const reauth = await verifyReauth(req, { maxAgeSec: 120 });
  if (!reauth.ok) {
    if (reauth.retryAfterSec) res.setHeader('Retry-After', reauth.retryAfterSec);
    return res.status(reauth.status).json({
      error: reauth.error, message: reauth.message, retryAfter: reauth.retryAfterSec,
    });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const actor = req.user || null;

  // Use idempotency layer to prevent duplicate jobs within dedup window
  const jobId = await getOrCreateExportJob({
    tenantId: tid,
    cardId,
    format: fmt,
    from: from || null,
    to: to || null,
    filters: filters || {},
    actor,
  });

  const jobRef = db.collection(`${tenancy.tenantDoc(tid)}/exportJobs`).doc(jobId);
  const jobDoc = await jobRef.get();
  const jobData = jobDoc.data();

  const auditKindBase = `downloads.${cardId.replace(/-/g, '_')}`;
  try {
    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: `${auditKindBase}.queued`,
      target: { type: 'export_job', id: jobId, label: cardId },
      summary: `Queued ${cardId} background export`,
      metadata: { jobId, format: fmt, from, to, filters },
      req,
    });
  } catch {}

  // M2: Enqueue to Cloud Tasks for background processing
  try {
    await enqueueExportJob(jobId, {
      jobId,
      cardId,
      format: fmt,
      from,
      to,
      filters,
      actor,
      tenantId: tid,
    });

    console.log(`[jobs/start] Enqueued ${cardId} export job ${jobId} to Cloud Tasks`);
  } catch (err) {
    console.error(`[jobs/start] Failed to enqueue job ${jobId}:`, err);
    // Mark job as failed if enqueue fails
    await jobRef.update({
      status: 'failed',
      lastError: `Failed to enqueue: ${err.message}`,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  return res.status(202).json({
    ok: true,
    jobId,
    statusUrl: `/api/downloads/_jobs/status?jobId=${jobId}`,
  });
}

export default withApi(handler, {
  methods: ['POST'],
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 10,
});
