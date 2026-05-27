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
const { getRunner, runJob } = require('../../../../lib/download-runner');
const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');
const { verifyReauth } = require('../../../../lib/reauth');

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
  const runnerCfg = getRunner(cardId);
  if (!runnerCfg) {
    return res.status(404).json({ error: 'unknown_card', cardId });
  }

  const fmt = String(format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return res.status(400).json({ error: 'bad_format' });
  }

  // Sensitive ops: tighter re-auth window than sync downloads.
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

  const jobRef = await db
    .collection(`${tenancy.tenantDoc(tid)}/exportJobs`)
    .add({
      status: 'queued',
      cardId,
      format: fmt,
      from: from || null,
      to: to || null,
      filters: filters || {},
      byUid: actor?.uid || null,
      byEmail: actor?.email || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  const auditKindBase = `downloads.${cardId.replace(/-/g, '_')}`;
  try {
    await logAudit(db, {
      tenantId: tid, actor, kind: `${auditKindBase}.queued`,
      target: { type: 'export_job', id: jobRef.id, label: cardId },
      summary: `Queued ${cardId} background export`,
      metadata: { jobId: jobRef.id, format: fmt, from, to, filters },
      req,
    });
  } catch {}

  // M1: run inline. M2: enqueue on a worker tier (Cloud Tasks / PubSub).
  // We still return immediately to the client and let it poll /status —
  // the contract is identical whether inline or remote.
  runJob({ jobId: jobRef.id, cardId, format: fmt, from, to, filters, actor, tenantId: tid })
    .then(async (result) => {
      await jobRef.update({
        status: 'completed',
        rowCount: result.rowCount,
        storagePath: result.storagePath,
        contentType: result.contentType,
        filename: result.filename,
        durationMs: result.durationMs,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    })
    .catch(async (err) => {
      console.error(`[jobs/start] ${cardId} failed:`, err);
      await jobRef.update({
        status: 'failed',
        error: String(err?.message || err),
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      try {
        await logAudit(db, {
          tenantId: tid, actor, kind: `${auditKindBase}.job_failed`,
          target: { type: 'export_job', id: jobRef.id, label: cardId },
          summary: `Background export ${cardId} failed`,
          metadata: { jobId: jobRef.id, error: String(err?.message || err) },
          req,
        });
      } catch {}
    });

  return res.status(202).json({
    ok: true,
    jobId: jobRef.id,
    statusUrl: `/api/downloads/_jobs/status?jobId=${jobRef.id}`,
  });
}

export default withApi(handler, {
  methods: ['POST'],
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 10,
});
