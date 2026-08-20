/**
 * GET /api/pickup/admin/notifications
 *
 * Aggregated notification feed for the dashboard bell:
 *  - security incidents (last 24h, newest 10)
 *  - pending onboarding forms (newest 5)
 *  - failed emails (last 24h, newest 5)
 *
 * Returns { ok, items: [{ id, kind, title, detail, at, href }] } sorted desc.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

const NOTIFICATIONS_CACHE_TTL_MS = 10 * 1000;
const notificationsCache = new Map();

const TYPE_LABEL = {
  spoof_attempt: 'Spoof attempt',
  liveness_failure: 'Liveness failure',
  low_confidence: 'Low-confidence match',
  unknown_face: 'Unknown face at gate',
  officer_override: 'Officer override',
};

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  return null;
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const tid = tenancy.getTenantId(req.query.tenant);
  const cacheKey = `notifications:${tid}`;
  const cached = notificationsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.status(200).json(cached.payload);
  }

  initializeFirebase();
  const db = admin.firestore();
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const items = [];

  // Security incidents (24h)
  try {
    const snap = await db.collection(tenancy.securityIncidentsPath(tid))
      .where('createdAt', '>=', since24h)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    snap.forEach((doc) => {
      const d = doc.data();
      const type = d.type || d.kind || 'incident';
      items.push({
        id: `sec-${doc.id}`,
        kind: 'security',
        title: TYPE_LABEL[type] || String(type).replace(/_/g, ' '),
        detail: [d.gate || d.terminalId || null, d.chaperoneName || null].filter(Boolean).join(' · ') || 'Security incident',
        at: toIso(d.createdAt),
        href: '/v2/security',
      });
    });
  } catch { /* non-critical */ }

  // Pending onboarding forms (no orderBy — avoids composite index; sort in JS)
  try {
    const snap = await db.collection(tenancy.pickupOnboardingPath(tid))
      .where('status', '==', 'pending')
      .limit(20)
      .get();
    const pending = [];
    snap.forEach((doc) => {
      const d = doc.data();
      pending.push({
        id: `form-${doc.id}`,
        kind: 'form',
        title: `New pickup form ${d.formNumber || ''}`.trim(),
        detail: d.guardian?.name || 'Guardian',
        at: toIso(d.submittedAt),
        href: '/v2/pickup-admin',
      });
    });
    pending.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    items.push(...pending.slice(0, 5));
  } catch { /* non-critical */ }

  // Failed emails (24h)
  try {
    const snap = await db.collection('email_queue')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(since24h)))
      .orderBy('createdAt', 'desc')
      .limit(80)
      .get();
    let n = 0;
    snap.forEach((doc) => {
      if (n >= 5) return;
      const d = doc.data();
      if (d.status !== 'failed' && d.status !== 'failed_final') return;
      n += 1;
      items.push({
        id: `email-${doc.id}`,
        kind: 'email',
        title: 'Email failed to send',
        detail: `${d.templateType || 'email'} → ${d.to || '?'}`,
        at: toIso(d.failedAt) || toIso(d.createdAt),
        href: '/v2/system-interfaces',
      });
    });
  } catch { /* non-critical */ }

  items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const payload = { ok: true, items: items.slice(0, 20) };
  notificationsCache.set(cacheKey, { payload, expiresAt: Date.now() + NOTIFICATIONS_CACHE_TTL_MS });
  return res.status(200).json(payload);
}

export default withApi(handler, { methods: ['GET'], permission: 'pickup_admin.view' });
