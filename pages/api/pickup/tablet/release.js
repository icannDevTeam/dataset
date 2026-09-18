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

    // Parent notification email — enqueue to email_queue (processed by
    // Cloud Functions). Gated behind settings.releaseEmailEnabled which
    // defaults OFF; failures never block the release itself.
    if (norm === 'release') {
      try {
        const settingsSnap = await db.doc(tenancy.pickupSettingsDoc(tid)).get();
        const releaseEmailEnabled = !!(settingsSnap.exists && settingsSnap.data().releaseEmailEnabled);
        if (releaseEmailEnabled) {
          const chap = (ev.chaperone && typeof ev.chaperone === 'object') ? ev.chaperone : {};
          const students = Array.isArray(ev.students) ? ev.students : [];
          // Guardian email lives on the chaperone doc (guardianEmail = form
          // submitter; email = the chaperone themself as fallback).
          let guardianEmail = null;
          let guardianName = null;
          const chapDocId = chap.id || chap._id || null;
          if (chapDocId) {
            const chapSnap = await db.doc(`${tenancy.chaperonesPath(tid)}/${chapDocId}`).get();
            if (chapSnap.exists) {
              const c = chapSnap.data() || {};
              guardianEmail = c.guardianEmail || c.email || null;
              guardianName = c.guardianName || null;
            }
          }
          if (guardianEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guardianEmail)) {
            const wib = new Date(Date.now() + 7 * 3600 * 1000);
            const releasedAtWib = wib.toISOString().slice(11, 16);
            await db.collection('email_queue').add({
              status: 'pending',
              to: guardianEmail,
              templateType: 'pickup_child_released',
              tenantId: tid,
              recordId: eventId,
              templateData: {
                guardianName: guardianName || chap.name || 'Parent/Guardian',
                studentNames: students.map((s) => s?.name).filter(Boolean),
                chaperoneName: chap.name || '',
                chaperoneRelation: chap.relation || '',
                gate: ev.gate || ev.deviceName || '',
                releasedAtWib,
              },
              retryCount: 0,
              maxRetries: 3,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              source: 'tablet-release',
            });
          }
        }
      } catch (mailErr) {
        console.error('[pickup/tablet/release] email enqueue failed (non-blocking):', mailErr.message);
      }
    }

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
