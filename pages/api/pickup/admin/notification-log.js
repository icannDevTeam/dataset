/**
 * GET /api/pickup/admin/notification-log
 *
 * Returns recent email dispatch records from email_queue and campaign logs.
 * Used by the PickupGuard monitoring dashboard to surface delivery health,
 * per-job errors, and campaign send history.
 *
 * Query params:
 *   limit      number   Max email_queue rows to return (default 100, max 500)
 *   status     string   Filter by status: pending|sent|failed|retrying (optional)
 *   hours      number   Look-back window in hours (default 48, max 168 = 7 days)
 *   campaigns  boolean  Include campaign log rows (default true)
 *
 * Response:
 * {
 *   ok: true,
 *   jobs: [{
 *     id, to, status, templateType, error, retryCount, maxRetries,
 *     campaignId, source, createdAt, sentAt, failedAt
 *   }],
 *   campaigns: [{
 *     campaignId, campaignName, channel, subject,
 *     recipientCount, queued, skipped, createdBy, createdAt
 *   }],
 *   summary: { pending, sent, failed, retrying, total, deliveryRate }
 * }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

function tsIso(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  return null;
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId(req.query.tenant);

  const limit    = Math.min(500, Math.max(1, parseInt(req.query.limit  || '100', 10)));
  const hours    = Math.min(168, Math.max(1, parseInt(req.query.hours  || '48',  10)));
  const statusF  = (req.query.status || '').trim().toLowerCase();
  const withCampaigns = req.query.campaigns !== 'false';

  const since = new Date(Date.now() - hours * 3600 * 1000);
  const sinceTs = admin.firestore.Timestamp.fromDate(since);

  // ── Email queue jobs ───────────────────────────────────────────────────────
  let q = db.collection('email_queue')
    .where('createdAt', '>=', sinceTs)
    .orderBy('createdAt', 'desc')
    .limit(limit);
  if (statusF && ['pending', 'sent', 'failed', 'retrying'].includes(statusF)) {
    // Firestore can't filter on two inequality fields; apply status client-side
  }

  let jobsSnap;
  try {
    jobsSnap = await q.get();
  } catch (e) {
    return res.status(500).json({ error: 'firestore_error', message: e.message });
  }

  const summary = { pending: 0, sent: 0, failed: 0, retrying: 0, total: 0 };
  const jobs = [];

  jobsSnap.forEach((doc) => {
    const d = doc.data() || {};
    const status = d.status || 'unknown';
    summary.total++;
    if (status in summary) summary[status]++;

    if (!statusF || status === statusF) {
      jobs.push({
        id: doc.id,
        to: d.to || null,
        status,
        templateType: d.templateType || null,
        error: d.error || null,
        retryCount: d.retryCount || 0,
        maxRetries: d.maxRetries || 3,
        campaignId: d.campaignId || null,
        campaignName: d.campaignName || null,
        source: d.source || null,
        createdAt: tsIso(d.createdAt),
        sentAt: tsIso(d.sentAt),
        failedAt: tsIso(d.failedAt),
        updatedAt: tsIso(d.updatedAt),
      });
    }
  });

  const delivered = summary.sent;
  const attempted = summary.sent + summary.failed;
  summary.deliveryRate = attempted > 0 ? Math.round((delivered / attempted) * 100) : null;

  // ── Campaign logs ──────────────────────────────────────────────────────────
  let campaigns = [];
  if (withCampaigns) {
    try {
      const campPath = `${tenancy.tenantDoc(tid)}/pickup_campaign_logs`;
      const campSnap = await db.collection(campPath)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      campSnap.forEach((doc) => {
        const d = doc.data() || {};
        campaigns.push({
          campaignId: d.campaignId || doc.id,
          campaignName: d.campaignName || null,
          channel: d.channel || 'email',
          subject: d.subject || null,
          recipientCount: d.recipientCount || 0,
          queued: d.queued || 0,
          skipped: d.skipped || 0,
          group: d.group || null,
          createdBy: d.createdBy || null,
          createdAt: tsIso(d.createdAt),
        });
      });
    } catch { /* non-critical — campaign logs are optional */ }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, jobs, campaigns, summary });
}

export default withApi(handler, { methods: ['GET'], permission: 'analytics.view' });
