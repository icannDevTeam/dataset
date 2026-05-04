/**
 * POST /api/pickup/tv/start-pair
 *
 * Public endpoint called by the TV when it has no device token yet.
 * Creates a pending tv_devices doc with a 6-char display code that the
 * admin will type into the dashboard to claim.
 *
 * Pairing codes auto-expire after PAIRING_TTL_MS to limit brute-force
 * surface (poll-pair will report 'expired' and mark the doc revoked).
 *
 * Body:  { tenant?, userAgent? }
 * Reply: { ok, deviceId, pairingCode, expiresAt, ttlSeconds }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const td = require('../../../../lib/tv-devices');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PAIRING_TTL_SEC = PAIRING_TTL_MS / 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  // Per-IP rate limit: a TV needs ~1 start-pair per session, so 6/min is generous.
  const ip = clientIp(req);
  const rl = enforceRateLimit('pickup:start-pair', ip, { max: 6, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.body?.tenant ? String(req.body.tenant) : tenancy.getTenantId();
    const userAgent = String(req.body?.userAgent || req.headers['user-agent'] || '').slice(0, 240);

    // Find an unused pairing code among still-pending devices.
    const colRef = db.collection(td.tvDevicesPath(tid));
    let pairingCode = null;
    for (let i = 0; i < 6; i++) {
      const candidate = td.genPairingCode();
      const dup = await colRef
        .where('pairingCode', '==', candidate)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      if (dup.empty) { pairingCode = candidate; break; }
    }
    if (!pairingCode) return res.status(503).json({ error: 'could not allocate pairing code' });

    const deviceId = td.genDeviceId();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + PAIRING_TTL_MS);
    await colRef.doc(deviceId).set({
      deviceId,
      deviceLabel: `TV ${deviceId.slice(-4).toUpperCase()}`,
      pairingCode,
      pairingExpiresAt: expiresAt,
      profileId: null,
      deviceToken: null,
      status: 'pending',
      userAgent,
      createdAt: now,
      claimedAt: null,
      lastSeenAt: now,
      lastSeenIp: ip || null,
    });

    return res.status(201).json({
      ok: true,
      deviceId,
      pairingCode,
      expiresAt: expiresAt.toMillis(),
      ttlSeconds: PAIRING_TTL_SEC,
    });
  } catch (e) {
    console.error('[pickup/tv/start-pair]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
