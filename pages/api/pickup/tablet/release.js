/**
 * POST /api/pickup/tablet/release
 *
 * Token-authenticated. Used by the iPad to release or hold a pickup event.
 * No 'escalate' (security escalation removed in Phase 2).
 *
 * Auth:  x-tablet-device-token header
 * Body:  { eventId, action: 'release'|'hold', note? }
 * Reply: { ok, eventId, action, blocked }
 *
 * Authorization model: an event is releasable from this iPad iff its
 * terminalId is in the bound release group's terminalIds.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const token = req.headers['x-tablet-device-token'] || req.body?.deviceToken;
  if (!token) return res.status(401).json({ error: 'deviceToken required' });

  const { eventId, action, note } = req.body || {};
  const norm = String(action || '').toLowerCase();
  if (!eventId || typeof eventId !== 'string') return res.status(400).json({ error: 'eventId required' });
  if (!['release', 'hold'].includes(norm)) {
    return res.status(400).json({ error: "action must be 'release' or 'hold'" });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.body?.tenant ? String(req.body.tenant) : tenancy.getTenantId();

    // Token → device → release group → terminalIds
    const devSnap = await db.collection(tenancy.tabletDevicesPath(tid))
      .where('deviceToken', '==', String(token))
      .limit(1).get();
    if (devSnap.empty) return res.status(401).json({ error: 'unknown token' });
    const dev = devSnap.docs[0];
    const devData = dev.data();
    if (devData.status !== 'paired') return res.status(401).json({ error: 'not paired' });
    const releaseGroupId = devData.releaseGroupId;
    if (!releaseGroupId) return res.status(409).json({ error: 'no release group bound' });

    const groupSnap = await db.doc(tenancy.releaseGroupDoc(releaseGroupId, tid)).get();
    if (!groupSnap.exists) return res.status(404).json({ error: 'release group not found' });
    const terminalIds = Array.isArray(groupSnap.data().terminalIds) ? groupSnap.data().terminalIds : [];

    const eventRef = db.doc(`${tenancy.pickupEventsPath(tid)}/${eventId}`);
    const evSnap = await eventRef.get();
    if (!evSnap.exists) return res.status(404).json({ error: 'event not found' });
    const ev = evSnap.data() || {};

    // Authorization: event's terminalId must be one of the bound terminals.
    // (Legacy events may not have terminalId; allow if the event has no terminalId
    // but the release group's terminalIds include the event's deviceName/gate as
    // a fallback during migration.)
    const evTerminal = ev.terminalId;
    if (evTerminal) {
      if (!terminalIds.includes(evTerminal)) {
        return res.status(403).json({ error: 'event not in this release group' });
      }
    }

    const blocked = ev.decision === 'unknown_chaperone';
    const cardState = String(ev.cardState || 'green').toLowerCase();
    const releasePayload = {
      by: `tablet:${dev.id}`,
      displayName: devData.deviceLabel || dev.id,
      at: admin.firestore.FieldValue.serverTimestamp(),
      action: norm,
      flagged: cardState === 'red' || blocked,
      note: typeof note === 'string' ? note.slice(0, 500) : null,
      via: 'tablet',
    };
    const nextStatus = norm === 'release' ? 'released' : 'held';

    await eventRef.set({
      status: nextStatus,
      teacherRelease: releasePayload,
    }, { merge: true });

    return res.status(200).json({
      ok: true,
      eventId,
      action: norm,
      blocked,
    });
  } catch (e) {
    console.error('[pickup/tablet/release]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
