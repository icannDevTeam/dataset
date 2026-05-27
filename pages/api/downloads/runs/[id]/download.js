/**
 * GET /api/downloads/runs/[id]/download
 *
 * Re-download the artifact for a previously-run report.
 *
 * Auth model
 *   - Caller must hold at least one of the four `downloads.*` permissions
 *     (route-level guard via withApi).
 *   - Owner of the run (byUid === caller) may always re-download.
 *   - `download_compliance` may re-download anyone's run (audit recovery).
 *
 * Behaviour
 *   - 404 if the run doc doesn't exist.
 *   - 410 `no_artifact` if the run completed in sync mode but the Storage
 *     tee never landed (storagePath missing).
 *   - 302 redirect to a 24h signed URL when the artifact is available.
 *   - Logs `downloads.run.redownload` to the audit trail.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../../lib/firebase-admin';
import { withApi } from '../../../../../lib/api-auth';
const tenancy = require('../../../../../lib/tenancy');
const { logAudit } = require('../../../../../lib/audit-log');

const DOWNLOAD_KEYS = [
  'downloads.download_operational',
  'downloads.download_directory',
  'downloads.download_security',
  'downloads.download_compliance',
];

const SIGNED_URL_TTL_MS = 24 * 60 * 60 * 1000;

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const actor = req.user || {};
  const myId = actor.uid || actor.email || null;

  const runId = String(req.query.id || '').trim();
  if (!runId) return res.status(400).json({ error: 'bad_id' });

  const ref = db.collection(tenancy.reportRunsPath(tid)).doc(runId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'not_found' });
  const run = snap.data() || {};

  // Permission union check inside the handler — withApi.anyPermission
  // already verified the user holds at least one download key, but we
  // need to specifically allow `download_compliance` to bypass owner.
  const isOwner = run.byUid && myId && run.byUid === myId;
  const isCompliance = actor.superAdmin
    || (actor.permissions && actor.permissions['downloads.download_compliance'] === true);
  if (!isOwner && !isCompliance) {
    return res.status(403).json({ error: 'forbidden_not_owner' });
  }

  if (!run.storagePath) {
    return res.status(410).json({
      error: 'no_artifact',
      message: run.mode === 'sync'
        ? 'Sync downloads are not persisted; re-run the report.'
        : 'Artifact missing — re-run the report.',
    });
  }

  let signedUrl;
  try {
    const bucket = getFirebaseStorage().bucket();
    const [url] = await bucket.file(run.storagePath).getSignedUrl({
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    signedUrl = url;
  } catch (err) {
    console.error('[runs/download] signed-url failed:', err.message);
    return res.status(500).json({ error: 'signed_url_failed', message: err.message });
  }

  try {
    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: 'downloads.run.redownload',
      target: { type: 'report_run', id: runId, label: run.cardId || '' },
      summary: `Re-downloaded ${run.cardId} run (${run.mode})`,
      metadata: {
        cardId: run.cardId, format: run.format, from: run.from, to: run.to,
        rowCount: run.rowCount, mode: run.mode, viaCompliance: !isOwner,
      },
      req,
    });
  } catch {}

  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, signedUrl);
}

export default withApi(handler, {
  methods: ['GET'],
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 60,
});
