/**
 * GET /api/pickup/admin/system-health
 *
 * Lightweight health probe for the PickupGuard monitoring dashboard.
 * Checks Firestore, Resend/email config, WhatsApp config, email queue
 * stats, and recent security incident counts. All reads are either
 * lightweight aggregations or single-doc fetches.
 *
 * Response shape:
 * {
 *   ok: true,
 *   checkedAt: ISO string,
 *   services: {
 *     firestore:  { status: 'ok'|'error', latencyMs: number, error?: string },
 *     email:      { status: 'ok'|'warn'|'error', configured: bool, key: 'present'|'missing', error?: string },
 *     whatsapp:   { status: 'ok'|'warn', configured: bool, url?: string },
 *     functions:  { status: 'ok'|'warn', note: string },
 *   },
 *   emailQueue: {
 *     pending: number,
 *     sent: number,
 *     failed: number,
 *     retrying: number,
 *     recentErrors: [{ id, to, error, failedAt, templateType }],
 *   },
 *   security: {
 *     last24h: number,
 *     last1h:  number,
 *   },
 *   onboarding: {
 *     pending: number,
 *   },
 * }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId(req.query.tenant);
  const checkedAt = new Date().toISOString();

  // ── 1. Firestore probe ─────────────────────────────────────────────────────
  const firestoreResult = await (async () => {
    const t0 = Date.now();
    try {
      // Cheap read: just check the tenant settings doc exists
      await db.doc(tenancy.tenantDoc(tid)).get();
      return { status: 'ok', latencyMs: Date.now() - t0 };
    } catch (e) {
      return { status: 'error', latencyMs: Date.now() - t0, error: e.message };
    }
  })();

  // ── 2. Email (Resend) config check ─────────────────────────────────────────
  const resendKey = process.env.RESEND_API_KEY || '';
  const emailResult = (() => {
    if (!resendKey) {
      return { status: 'error', configured: false, key: 'missing', error: 'RESEND_API_KEY not set — emails will fail' };
    }
    // Key looks like re_... — basic sanity check only, no live call
    const looksValid = resendKey.startsWith('re_') && resendKey.length > 10;
    return {
      status: looksValid ? 'ok' : 'warn',
      configured: true,
      key: 'present',
      ...(looksValid ? {} : { error: 'API key format looks unexpected — verify in Resend dashboard' }),
    };
  })();

  // ── 3. WhatsApp config check ───────────────────────────────────────────────
  let whatsappResult = { status: 'warn', configured: false };
  try {
    const settingsSnap = await db.doc(tenancy.pickupIntegrationsDoc(tid)).get();
    const waUrl = settingsSnap.exists ? (settingsSnap.data()?.whatsappBroadcastUrl || '') : '';
    whatsappResult = waUrl
      ? { status: 'ok', configured: true, url: waUrl.slice(0, 60) + (waUrl.length > 60 ? '…' : '') }
      : { status: 'warn', configured: false };
  } catch { /* non-critical */ }

  // ── 4. Email queue stats ───────────────────────────────────────────────────
  const emailQueue = { pending: 0, sent: 0, failed: 0, retrying: 0, recentErrors: [] };
  try {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const queueSnap = await db.collection('email_queue')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(since24h)))
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();

    queueSnap.forEach((doc) => {
      const d = doc.data();
      const s = d.status || 'unknown';
      if (s === 'pending') emailQueue.pending++;
      else if (s === 'sent') emailQueue.sent++;
      else if (s === 'failed') {
        emailQueue.failed++;
        if (emailQueue.recentErrors.length < 20) {
          emailQueue.recentErrors.push({
            id: doc.id,
            to: d.to || null,
            error: d.error || 'unknown',
            templateType: d.templateType || null,
            failedAt: d.failedAt
              ? (typeof d.failedAt.toDate === 'function' ? d.failedAt.toDate().toISOString() : String(d.failedAt))
              : null,
            retryCount: d.retryCount || 0,
          });
        }
      } else if (s === 'retrying') emailQueue.retrying++;
    });
  } catch (e) {
    emailQueue._error = e.message;
  }

  // ── 5. Security incidents (last 24h and 1h) ────────────────────────────────
  const security = { last24h: 0, last1h: 0 };
  try {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const since1h  = new Date(Date.now() -  1 * 3600 * 1000).toISOString();
    const secSnap = await db.collection(tenancy.securityIncidentsPath(tid))
      .where('createdAt', '>=', since24h)
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();
    secSnap.forEach((doc) => {
      const at = doc.data().createdAt;
      const ts = typeof at === 'string' ? Date.parse(at) : at?.toDate?.()?.getTime();
      if (ts) {
        security.last24h++;
        if (ts >= Date.now() - 3600 * 1000) security.last1h++;
      }
    });
  } catch { /* non-critical */ }

  // ── 6. Onboarding pending count ────────────────────────────────────────────
  const onboarding = { pending: 0 };
  try {
    const pendingSnap = await db
      .collection(tenancy.pickupOnboardingPath(tid))
      .where('status', '==', 'pending')
      .select() // keys-only
      .get();
    onboarding.pending = pendingSnap.size;
  } catch { /* non-critical */ }

  return res.status(200).json({
    ok: true,
    checkedAt,
    services: {
      firestore: firestoreResult,
      email: emailResult,
      whatsapp: whatsappResult,
      functions: {
        status: 'ok',
        note: 'processEmailQueue runs on Cloud Functions — check Firebase console for invocation errors',
      },
    },
    emailQueue,
    security,
    onboarding,
  });
}

export default withApi(handler, { methods: ['GET'], permission: 'analytics.view' });
