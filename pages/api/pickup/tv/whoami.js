/**
 * GET /api/pickup/tv/whoami
 *
 * Public. The TV calls this on boot with its stored deviceToken to confirm
 * that it is still paired and to fetch the assigned kiosk profile.
 *
 * Auth: x-tv-device-token header  (or ?deviceToken=)
 * Reply (ok):       { ok, deviceId, profileId, profileName }
 * Reply (revoked):  401 { error: "revoked" }
 * Reply (unknown):  401 { error: "unknown token" }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const td = require('../../../../lib/tv-devices');
const kp = require('../../../../lib/kiosk-profiles');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const token = req.headers['x-tv-device-token'] || req.query.deviceToken;
  if (!token) return res.status(400).json({ error: 'deviceToken required' });

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
    const snap = await db.collection(td.tvDevicesPath(tid))
      .where('deviceToken', '==', String(token))
      .limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'unknown token' });

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.status !== 'paired') return res.status(401).json({ error: data.status || 'revoked' });

    let profileName = null;
    if (data.profileId) {
      const p = await db.doc(kp.kioskProfileDoc(data.profileId, tid)).get();
      profileName = p.exists ? (p.data().name || data.profileId) : null;
    }

    // Touch lastSeenAt
    doc.ref.set({
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSeenIp: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    }, { merge: true }).catch(() => {});

    return res.status(200).json({
      ok: true,
      deviceId: doc.id,
      deviceLabel: data.deviceLabel || doc.id,
      profileId: data.profileId,
      profileName,
    });
  } catch (e) {
    console.error('[pickup/tv/whoami]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
