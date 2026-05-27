/**
 * POST /api/downloads/runs/[id]/share
 *
 * Mints a fresh 24h signed URL for a previously-completed run so the
 * caller can hand it to a recipient via any side channel (chat,
 * ticketing system, etc.). NO email transport — the user copies the
 * URL themselves.
 *
 * Body: { sharedWith?: string } — free-text recipient note, capped 200
 * chars, written into the audit row but never validated as an email.
 *
 * Auth:
 *   - Caller must hold any of the four `downloads.*` keys AND
 *     `downloads.manage_presets` (share is a sharing action).
 *   - Run owner OR `download_compliance` may share.
 *
 * Audit: `downloads.run.shared` with metadata { runId, sharedWith?, expiresAt }.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../../lib/firebase-admin';
import { withApi } from '../../../../../lib/api-auth';
const tenancy = require('../../../../../lib/tenancy');
const { logAudit } = require('../../../../../lib/audit-log');

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

const DOWNLOAD_KEYS = [
  'downloads.download_operational',
  'downloads.download_directory',
  'downloads.download_security',
  'downloads.download_compliance',
];

const SIGNED_URL_TTL_MS = 24 * 60 * 60 * 1000;

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const actor = req.user || {};
  const myId = actor.uid || actor.email || null;

  const canManage = actor.superAdmin
    || (actor.permissions && actor.permissions['downloads.manage_presets'] === true);
  if (!canManage) return res.status(403).json({ error: 'forbidden_manage_presets' });

  const runId = String(req.query.id || '').trim();
  if (!runId) return res.status(400).json({ error: 'bad_id' });

  const ref = db.collection(tenancy.reportRunsPath(tid)).doc(runId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'not_found' });
  const run = snap.data() || {};

  const isOwner = run.byUid && myId && run.byUid === myId;
  const isCompliance = actor.superAdmin
    || (actor.permissions && actor.permissions['downloads.download_compliance'] === true);
  if (!isOwner && !isCompliance) {
    return res.status(403).json({ error: 'forbidden_not_owner' });
  }

  if (!run.storagePath) {
    return res.status(410).json({ error: 'no_artifact', message: 'Run has no persisted artifact.' });
  }

  const sharedWith = String(req.body?.sharedWith || '').slice(0, 200);
  const expiresAt = Date.now() + SIGNED_URL_TTL_MS;

  let signedUrl;
  try {
    const bucket = getFirebaseStorage().bucket();
    const [url] = await bucket.file(run.storagePath).getSignedUrl({
      action: 'read',
      expires: expiresAt,
    });
    signedUrl = url;
  } catch (err) {
    console.error('[runs/share] signed-url failed:', err.message);
    return res.status(500).json({ error: 'signed_url_failed', message: err.message });
  }

  try {
    await logAudit(db, {
      tenantId: tid, actor,
      kind: 'downloads.run.shared',
      target: { type: 'report_run', id: runId, label: run.cardId || '' },
      summary: `Shared ${run.cardId} run via 24h link${sharedWith ? ` with ${sharedWith}` : ''}`,
      metadata: {
        cardId: run.cardId, runId, sharedWith: sharedWith || null,
        expiresAt: new Date(expiresAt).toISOString(),
        viaCompliance: !isOwner,
      },
      req,
    });
  } catch {}

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    url: signedUrl,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

export default withApi(handler, {
  methods: ['POST'],
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 10,
});
