/**
 * Admin endpoint for the TV-pairing fleet.
 *
 *   GET    /api/pickup/admin/tv-devices                       → list all devices
 *   GET    /api/pickup/admin/tv-devices?status=pending        → only pending pairings
 *   POST   /api/pickup/admin/tv-devices?action=claim          → admin claims a pairing code
 *            body: { pairingCode, profileId, deviceLabel? }
 *   PUT    /api/pickup/admin/tv-devices?id=<deviceId>         → reassign profile / rename
 *            body: { profileId?, deviceLabel? }
 *   DELETE /api/pickup/admin/tv-devices?id=<deviceId>         → revoke (soft delete)
 *   DELETE /api/pickup/admin/tv-devices?id=<deviceId>&hard=1  → hard delete
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
const tenancy = require('../../../../lib/tenancy');
const td = require('../../../../lib/tv-devices');
const kp = require('../../../../lib/kiosk-profiles');

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const colRef = db.collection(td.tvDevicesPath(tid));

  try {
    if (req.method === 'GET') {
      const status = req.query.status ? String(req.query.status) : null;
      let q = colRef.orderBy('createdAt', 'desc').limit(100);
      const snap = await q.get();
      const devices = snap.docs
        .map((d) => td.publicDevice(d.id, d.data()))
        .filter((d) => !status || d.status === status);
      return res.status(200).json({ ok: true, devices });
    }

    if (req.method === 'POST' && req.query.action === 'claim') {
      const code = td.normalizePairingCode(req.body?.pairingCode);
      const profileId = req.body?.profileId ? String(req.body.profileId) : null;
      const deviceLabel = String(req.body?.deviceLabel || '').trim().slice(0, 80) || null;
      if (!code || !profileId) return res.status(400).json({ error: 'pairingCode and profileId required' });

      const profile = await db.doc(kp.kioskProfileDoc(profileId, tid)).get();
      if (!profile.exists) return res.status(404).json({ error: 'profile not found' });

      const match = await colRef.where('pairingCode', '==', code).where('status', '==', 'pending').limit(1).get();
      if (match.empty) return res.status(404).json({ error: 'no pending device with this code' });

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
        return res.status(410).json({ error: 'pairing_expired', message: 'Pairing code has expired — ask the TV to generate a new one.' });
      }
      const deviceToken = td.genDeviceToken();
      const patch = {
        status: 'paired',
        deviceToken,
        profileId,
        pairingCode: null,
        pairingExpiresAt: null,
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        claimedVia: 'pairingCode',
      };
      if (deviceLabel) patch.deviceLabel = deviceLabel;
      await doc.ref.set(patch, { merge: true });
      const updated = (await doc.ref.get()).data();
      return res.status(200).json({ ok: true, device: td.publicDevice(doc.id, updated), profileName: profile.data().name });
    }

    if (req.method === 'PUT') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'device not found' });

      const patch = {};
      if (req.body?.profileId !== undefined) {
        const pid = String(req.body.profileId);
        const profile = await db.doc(kp.kioskProfileDoc(pid, tid)).get();
        if (!profile.exists) return res.status(404).json({ error: 'profile not found' });
        patch.profileId = pid;
      }
      if (req.body?.deviceLabel !== undefined) {
        patch.deviceLabel = String(req.body.deviceLabel).trim().slice(0, 80) || snap.data().deviceLabel;
      }
      patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(patch, { merge: true });
      const updated = (await ref.get()).data();
      return res.status(200).json({ ok: true, device: td.publicDevice(id, updated) });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      if (req.query.hard === '1') {
        await ref.delete();
      } else {
        await ref.set({
          status: 'revoked',
          deviceToken: null,
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[pickup/admin/tv-devices]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withAuth(handler, { methods: ['GET', 'POST', 'PUT', 'DELETE'] });
