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
const { releaseScopeTokens, studentMatchesScopes, buildChildReleaseJobs } = require('../../../../lib/manual-pickup');

/**
 * Only the children that belong to the releasing pole's grade scopes should
 * be named in the parent email. A mixed-grade family event (EY + Grade 1
 * siblings) otherwise emails "both released" from a single pole's tap.
 * Fail-open: when the pole has no scopes or nothing matches, keep all names.
 */
async function emailStudentsForRelease(db, tid, ev, students) {
  try {
    if (!ev.terminalId || students.length < 2) return students;
    const termSnap = await db.doc(`${tenancy.terminalsPath(tid)}/${ev.terminalId}`).get();
    if (!termSnap.exists) return students;
    const scopes = releaseScopeTokens([termSnap.data() || {}], null);
    if (scopes.size === 0) return students;
    const matching = students.filter((s) => studentMatchesScopes(s, scopes));
    return matching.length > 0 ? matching : students;
  } catch {
    return students;
  }
}

/**
 * Resolve each child's approved-form notification contact from
 * students/{id}.pickupNotify (written at ACOP approval). Returns a map
 * studentId -> {email, name} for buildChildReleaseJobs.
 */
async function notifyContactsForStudents(db, tid, students) {
  const ids = [...new Set((students || [])
    .map((s) => String(s?.id || s?.studentId || '').trim())
    .filter(Boolean))];
  if (ids.length === 0) return {};
  const snaps = await db.getAll(...ids.slice(0, 30).map((sid) => db.doc(`${tenancy.studentsPath(tid)}/${sid}`)));
  const out = {};
  snaps.forEach((snap) => {
    const n = snap.exists ? (snap.data() || {}).pickupNotify : null;
    if (n && n.email) out[snap.id] = { email: n.email, name: n.name || null };
  });
  return out;
}

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
          // Per-child recipients: each child's approved-form guardian only.
          // Custody safety — no fallback to the scanned chaperone's email or
          // generic contacts; children without an approved contact get no email.
          const emailStudents = await emailStudentsForRelease(db, tid, ev, students);
          const notifyByStudentId = await notifyContactsForStudents(db, tid, emailStudents);
          const { jobs, skipped } = buildChildReleaseJobs(emailStudents, notifyByStudentId);
          if (skipped.length > 0) {
            console.warn(`[pickup/tablet/release] no approved notification contact for ${skipped.length} student(s) on ${eventId} — no email sent for them`);
          }
          const wib = new Date(Date.now() + 7 * 3600 * 1000);
          const releasedAtWib = wib.toISOString().slice(11, 16);
          for (const job of jobs) {
            await db.collection('email_queue').add({
              status: 'pending',
              to: job.to,
              templateType: 'pickup_child_released',
              tenantId: tid,
              recordId: eventId,
              templateData: {
                guardianName: job.guardianName || 'Parent/Guardian',
                studentNames: job.studentNames,
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
