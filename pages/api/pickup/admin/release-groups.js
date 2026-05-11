/**
 * Admin endpoint for release groups (binds N terminals + 1 tablet device).
 *
 *   GET    /api/pickup/admin/release-groups                    → list groups
 *   POST   /api/pickup/admin/release-groups                    → create
 *            body: { name, gradeLabel?, terminalIds:[...] }
 *   PUT    /api/pickup/admin/release-groups?id=<groupId>       → patch
 *            body: { name?, gradeLabel?, terminalIds?, tabletDeviceId? }
 *   POST   /api/pickup/admin/release-groups?action=start-pair&id=<groupId>
 *            → mints a pending tablet_devices doc for this group, returns
 *              the 6-char pairing code that the iPad will type in.
 *   POST   /api/pickup/admin/release-groups?action=unpair&id=<groupId>
 *            → revokes the currently bound tablet device.
 *   DELETE /api/pickup/admin/release-groups?id=<groupId>       → delete group
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const tab = require('../../../../lib/tablet-devices');

const PAIRING_TTL_MS = 10 * 60 * 1000;

function tsIso(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') return ts;
  if (ts.toDate) return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

function publicGroup(id, data) {
  if (!data) return null;
  return {
    id,
    name: data.name || id,
    gradeLabel: data.gradeLabel || null,
    terminalIds: Array.isArray(data.terminalIds) ? data.terminalIds : [],
    tabletDeviceId: data.tabletDeviceId || null,
    pairingCode: data.pairingCode || null,
    pairingExpiresAt: tsIso(data.pairingExpiresAt),
    status: data.status || (data.tabletDeviceId ? 'paired' : 'unbound'),
    createdAt: tsIso(data.createdAt),
    updatedAt: tsIso(data.updatedAt),
    claimedAt: tsIso(data.claimedAt),
  };
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const colRef = db.collection(tenancy.releaseGroupsPath(tid));
  const tabletColRef = db.collection(tenancy.tabletDevicesPath(tid));

  try {
    if (req.method === 'GET') {
      const snap = await colRef.orderBy('name').get();
      const groups = snap.docs.map((d) => publicGroup(d.id, d.data()));
      return res.status(200).json({ ok: true, groups });
    }

    // ── POST: action routing ────────────────────────────────────────
    if (req.method === 'POST' && req.query.action === 'start-pair') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const groupRef = colRef.doc(id);
      const groupSnap = await groupRef.get();
      if (!groupSnap.exists) return res.status(404).json({ error: 'group not found' });

      // Allocate a pairing code that isn't already pending.
      let pairingCode = null;
      for (let i = 0; i < 6; i++) {
        const candidate = tab.genPairingCode();
        const dup = await tabletColRef
          .where('pairingCode', '==', candidate)
          .where('status', '==', 'pending')
          .limit(1).get();
        if (dup.empty) { pairingCode = candidate; break; }
      }
      if (!pairingCode) return res.status(503).json({ error: 'could not allocate pairing code' });

      const deviceId = tab.genDeviceId();
      const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + PAIRING_TTL_MS);
      const now = admin.firestore.FieldValue.serverTimestamp();
      await tabletColRef.doc(deviceId).set({
        deviceId,
        deviceLabel: `${groupSnap.data().name || id} iPad`,
        pairingCode,
        pairingExpiresAt: expiresAt,
        releaseGroupId: id,
        deviceToken: null,
        status: 'pending',
        createdAt: now,
        lastSeenAt: now,
      });

      // Stamp the pending pairing on the group so admin UI can render the code.
      await groupRef.set({
        pairingCode,
        pairingExpiresAt: expiresAt,
        pendingTabletDeviceId: deviceId,
        updatedAt: now,
      }, { merge: true });

      return res.status(201).json({
        ok: true,
        deviceId,
        pairingCode,
        expiresAt: expiresAt.toMillis(),
      });
    }

    if (req.method === 'POST' && req.query.action === 'unpair') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const groupRef = colRef.doc(id);
      const groupSnap = await groupRef.get();
      if (!groupSnap.exists) return res.status(404).json({ error: 'group not found' });
      const tabletId = groupSnap.data().tabletDeviceId;
      if (tabletId) {
        await tabletColRef.doc(tabletId).set({
          status: 'revoked',
          deviceToken: null,
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      await groupRef.set({
        tabletDeviceId: null,
        pairingCode: null,
        pairingExpiresAt: null,
        pendingTabletDeviceId: null,
        status: 'unbound',
        claimedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      const terminalIds = Array.isArray(req.body?.terminalIds) ? req.body.terminalIds.map(String) : [];
      if (terminalIds.length === 0) return res.status(400).json({ error: 'at-least-one-terminal-required', message: 'A release group must contain at least one terminal — otherwise it can never receive scan events.' });
      const gradeLabel = req.body?.gradeLabel ? String(req.body.gradeLabel).trim() : null;

      const docRef = await colRef.add({
        name,
        gradeLabel,
        terminalIds,
        tabletDeviceId: null,
        status: 'unbound',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Reverse-link: stamp releaseGroupId on every terminal in the list.
      const batch = db.batch();
      for (const tid2 of terminalIds) {
        batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
          releaseGroupId: docRef.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit().catch(() => {});

      const created = (await docRef.get()).data();
      return res.status(201).json({ ok: true, group: publicGroup(docRef.id, created) });
    }

    if (req.method === 'PUT') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'group not found' });

      const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
      if (req.body?.gradeLabel !== undefined) {
        patch.gradeLabel = req.body.gradeLabel ? String(req.body.gradeLabel).trim() : null;
      }
      let oldTerminalIds = Array.isArray(snap.data().terminalIds) ? snap.data().terminalIds : [];
      let newTerminalIds = oldTerminalIds;
      if (req.body?.terminalIds !== undefined) {
        newTerminalIds = Array.isArray(req.body.terminalIds) ? req.body.terminalIds.map(String) : [];
        patch.terminalIds = newTerminalIds;
      }
      await ref.set(patch, { merge: true });

      // Sync reverse links on terminals if list changed.
      if (req.body?.terminalIds !== undefined) {
        const removed = oldTerminalIds.filter((x) => !newTerminalIds.includes(x));
        const added = newTerminalIds.filter((x) => !oldTerminalIds.includes(x));
        const batch = db.batch();
        for (const tid2 of removed) {
          batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
            releaseGroupId: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        for (const tid2 of added) {
          batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
            releaseGroupId: id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        await batch.commit().catch(() => {});
      }

      const updated = (await ref.get()).data();
      return res.status(200).json({ ok: true, group: publicGroup(id, updated) });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      const snap = await ref.get();
      if (snap.exists) {
        // Unlink terminals.
        const terminalIds = Array.isArray(snap.data().terminalIds) ? snap.data().terminalIds : [];
        const batch = db.batch();
        for (const tid2 of terminalIds) {
          batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
            releaseGroupId: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        // Revoke any bound tablet.
        const tabletId = snap.data().tabletDeviceId;
        if (tabletId) {
          batch.set(db.doc(tenancy.tabletDeviceDoc(tabletId, tid)), {
            status: 'revoked',
            deviceToken: null,
            revokedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        await batch.commit().catch(() => {});
      }
      await ref.delete();
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[pickup/admin/release-groups]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  // GET = view; mutations require manage_groups.
  anyPermission: ['pickup_admin.view', 'pickup_admin.manage_groups'],
});
