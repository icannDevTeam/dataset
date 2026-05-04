/**
 * POST /api/pickup/tv/claim-by-code
 *
 * Public endpoint. The TV submits a short kioskCode (printed in admin UI).
 * We find the matching profile, mint a device token, and bind a fresh
 * tv_devices doc. No admin involvement needed for this path.
 *
 * Gated by tenant setting `pickup_settings.allowSelfClaim` (default false).
 * When disabled, all attempts return 403 — admins must use the pairing-code
 * flow (start-pair / claim) instead.
 *
 * Body:  { kioskCode, tenant?, userAgent? }
 * Reply: { ok, deviceToken, profileId, profileName, deviceId }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const td = require('../../../../lib/tv-devices');
const kp = require('../../../../lib/kiosk-profiles');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const code = td.normalizeKioskCode(req.body?.kioskCode);
  if (!code) return res.status(400).json({ error: 'kioskCode required' });

  // Per-IP rate limit: brute-force protection on the (small) kiosk-code space.
  const ip = clientIp(req);
  const rl = enforceRateLimit('pickup:claim-by-code', ip, { max: 6, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.body?.tenant ? String(req.body.tenant) : tenancy.getTenantId();
    const userAgent = String(req.body?.userAgent || req.headers['user-agent'] || '').slice(0, 240);

    // Tenant must opt-in to self-claim. Pairing-code flow is the safe default.
    const settingsSnap = await db.doc(tenancy.pickupSettingsDoc(tid)).get();
    const allowSelfClaim = settingsSnap.exists && settingsSnap.data()?.allowSelfClaim === true;
    if (!allowSelfClaim) {
      return res.status(403).json({
        error: 'self_claim_disabled',
        message: 'Self-claim by kiosk code is disabled for this tenant. Use the pairing-code flow.',
      });
    }

    // Find the profile with this code
    const profilesCol = db.collection(kp.kioskProfilesPath(tid));
    const match = await profilesCol.where('kioskCode', '==', code).limit(1).get();
    if (match.empty) return res.status(404).json({ error: 'no kiosk with this code' });
    const profileDoc = match.docs[0];
    const profile = kp.normalizeProfile(profileDoc.id, profileDoc.data());

    // Mint a paired device record
    const devCol = db.collection(td.tvDevicesPath(tid));
    const deviceId = td.genDeviceId();
    const deviceToken = td.genDeviceToken();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await devCol.doc(deviceId).set({
      deviceId,
      deviceLabel: `${profile.name} TV`,
      pairingCode: null,
      profileId: profile.id,
      deviceToken,
      status: 'paired',
      userAgent,
      createdAt: now,
      claimedAt: now,
      lastSeenAt: now,
      lastSeenIp: ip || null,
      claimedVia: 'kioskCode',
    });

    return res.status(201).json({
      ok: true,
      deviceId,
      deviceToken,
      profileId: profile.id,
      profileName: profile.name,
    });
  } catch (e) {
    console.error('[pickup/tv/claim-by-code]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
