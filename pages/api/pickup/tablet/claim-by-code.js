/**
 * POST /api/pickup/tablet/claim-by-code
 *
 * Public endpoint. The iPad submits the 6-char pairing code shown in the
 * admin UI for a release group. We bind the pending tablet_devices doc to
 * the iPad and mint a long-lived deviceToken.
 *
 * Body:  { pairingCode, tenant?, userAgent? }
 * Reply: { ok, deviceToken, deviceId, releaseGroupId, releaseGroupName, terminalIds }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const tab = require('../../../../lib/tablet-devices');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const code = tab.normalizePairingCode(req.body?.pairingCode);
  if (!code) return res.status(400).json({ error: 'pairingCode required' });

  const ip = clientIp(req);
  const rl = enforceRateLimit('pickup:tablet-claim', ip, { max: 10, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.body?.tenant ? String(req.body.tenant) : tenancy.getTenantId();
    const userAgent = String(req.body?.userAgent || req.headers['user-agent'] || '').slice(0, 240);

    const colRef = db.collection(tenancy.tabletDevicesPath(tid));
    const match = await colRef
      .where('pairingCode', '==', code)
      .where('status', '==', 'pending')
      .limit(1).get();
    if (match.empty) return res.status(404).json({ error: 'no pending pairing with this code' });

    const doc = match.docs[0];
    const docData = doc.data();
    const expMs = docData.pairingExpiresAt?.toMillis ? docData.pairingExpiresAt.toMillis() : null;
    if (expMs && Date.now() > expMs) {
      await doc.ref.set({
        status: 'revoked',
        revokedAt: admin.firestore.FieldValue.serverTimestamp(),
        revokedReason: 'pairing_expired',
        pairingCode: null,
      }, { merge: true });
      return res.status(410).json({ error: 'pairing_expired' });
    }

    const releaseGroupId = docData.releaseGroupId;
    if (!releaseGroupId) return res.status(409).json({ error: 'pairing not bound to a release group' });

    const groupRef = db.doc(tenancy.releaseGroupDoc(releaseGroupId, tid));
    const groupSnap = await groupRef.get();
    if (!groupSnap.exists) return res.status(404).json({ error: 'release group not found' });

    const deviceToken = tab.genDeviceToken();
    const now = admin.firestore.FieldValue.serverTimestamp();
    await doc.ref.set({
      status: 'paired',
      deviceToken,
      pairingCode: null,
      pairingExpiresAt: null,
      claimedAt: now,
      lastSeenAt: now,
      lastSeenIp: ip || null,
      userAgent,
    }, { merge: true });

    await groupRef.set({
      tabletDeviceId: doc.id,
      pairingCode: null,
      pairingExpiresAt: null,
      pendingTabletDeviceId: null,
      status: 'paired',
      claimedAt: now,
      updatedAt: now,
    }, { merge: true });

    const groupData = groupSnap.data();
    return res.status(200).json({
      ok: true,
      deviceToken,
      deviceId: doc.id,
      releaseGroupId,
      releaseGroupName: groupData.name || releaseGroupId,
      gradeLabel: groupData.gradeLabel || null,
      terminalIds: Array.isArray(groupData.terminalIds) ? groupData.terminalIds : [],
    });
  } catch (e) {
    console.error('[pickup/tablet/claim-by-code]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
