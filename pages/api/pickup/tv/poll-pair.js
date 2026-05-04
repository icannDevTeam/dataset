/**
 * GET /api/pickup/tv/poll-pair?deviceId=...
 *
 * Public endpoint. The TV polls every ~2s while waiting to be paired.
 * Once admin claims, returns the device token + assigned profile so the
 * TV can persist it and load the kiosk view.
 *
 * Reply (pending): { ok, status: "pending" }
 * Reply (paired):  { ok, status: "paired", deviceToken, profileId, profileName }
 * Reply (revoked): { ok, status: "revoked" }
 * Reply (expired): { ok, status: "expired" }   // pairing TTL elapsed
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const td = require('../../../../lib/tv-devices');
const kp = require('../../../../lib/kiosk-profiles');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const deviceId = req.query.deviceId ? String(req.query.deviceId) : null;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  // Per-IP rate limit: TV polls ~30/min normally; allow burst headroom but
  // block scrapers trying to brute-force deviceIds.
  const ip = clientIp(req);
  const rl = enforceRateLimit('pickup:poll-pair', ip, { max: 90, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
    const ref = db.doc(td.tvDeviceDoc(deviceId, tid));
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'unknown device' });
    const data = snap.data();

    // Touch lastSeenAt
    ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});

    if (data.status === 'pending') {
      // Enforce pairing TTL — close the brute-force window.
      const expMs = data.pairingExpiresAt?.toMillis ? data.pairingExpiresAt.toMillis() : null;
      if (expMs && Date.now() > expMs) {
        ref.set({
          status: 'revoked',
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
          revokedReason: 'pairing_expired',
          pairingCode: null,
        }, { merge: true }).catch(() => {});
        return res.status(200).json({ ok: true, status: 'expired' });
      }
      return res.status(200).json({ ok: true, status: 'pending' });
    }
    if (data.status === 'revoked') {
      return res.status(200).json({ ok: true, status: 'revoked' });
    }
    if (data.status === 'paired') {
      let profileName = null;
      if (data.profileId) {
        const p = await db.doc(kp.kioskProfileDoc(data.profileId, tid)).get();
        profileName = p.exists ? (p.data().name || data.profileId) : null;
      }
      return res.status(200).json({
        ok: true,
        status: 'paired',
        deviceToken: data.deviceToken,
        profileId: data.profileId,
        profileName,
      });
    }
    return res.status(200).json({ ok: true, status: 'unknown' });
  } catch (e) {
    console.error('[pickup/tv/poll-pair]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
