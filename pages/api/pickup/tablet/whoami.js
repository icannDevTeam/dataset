/**
 * GET /api/pickup/tablet/whoami
 *
 * Public. The iPad calls this on boot with its stored deviceToken to confirm
 * it is still paired and to fetch the current release group + terminal list.
 *
 * Auth: x-tablet-device-token header  (or ?deviceToken=)
 * Reply (ok): { ok, deviceId, deviceLabel, releaseGroupId, releaseGroupName,
 *               gradeLabel, terminalIds, terminals: [{id,name,gateLabel,gateOverride}] }
 * Reply (revoked): 401
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) return res.status(400).json({ error: 'deviceToken required' });

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
    const snap = await db.collection(tenancy.tabletDevicesPath(tid))
      .where('deviceToken', '==', String(token))
      .limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'unknown token' });

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.status !== 'paired') return res.status(401).json({ error: data.status || 'revoked' });

    const releaseGroupId = data.releaseGroupId;
    let groupData = null;
    if (releaseGroupId) {
      const g = await db.doc(tenancy.releaseGroupDoc(releaseGroupId, tid)).get();
      groupData = g.exists ? g.data() : null;
    }
    const terminalIds = Array.isArray(groupData?.terminalIds) ? groupData.terminalIds : [];
    const terminals = [];
    for (const tid2 of terminalIds) {
      const t = await db.doc(tenancy.terminalDoc(tid2, tid)).get();
      if (t.exists) {
        const td = t.data();
        terminals.push({
          id: t.id,
          name: td.name || t.id,
          gateLabel: td.gateLabel || null,
          gateOverride: td.gateOverride || null,
          enabled: td.enabled !== false,
        });
      }
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
      releaseGroupId,
      releaseGroupName: groupData?.name || releaseGroupId,
      gradeLabel: groupData?.gradeLabel || null,
      terminalIds,
      terminals,
    });
  } catch (e) {
    console.error('[pickup/tablet/whoami]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
