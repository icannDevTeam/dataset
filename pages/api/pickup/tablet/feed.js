/**
 * GET /api/pickup/tablet/feed
 *
 * Token-authenticated feed for the iPad teacher app. Returns pickup_events
 * scoped to the bound release group's terminalIds.
 *
 * Auth:  x-tablet-device-token header (or ?deviceToken=)
 * Query: ?since=ISO  ?max=2  (active limit)
 *
 * Response:
 *   {
 *     ok, now, releaseGroup: { id, name, gradeLabel, terminalIds },
 *     active:  [...],   // status='pending', up to maxActive (default 2)
 *     held:    [...],   // status='held'
 *   }
 *
 * Card shape mirrors /api/pickup/teacher/feed for shared UI components.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { shapePickupEvent, SILENT_ON_IPAD } = require('../../../../lib/shape-pickup-event');

const WINDOW_MS = 30 * 60 * 1000;

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v?.toDate) { try { return v.toDate().toISOString(); } catch { return null; } }
  try { return new Date(v).toISOString(); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) return res.status(401).json({ error: 'deviceToken required' });

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();
    const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

    // Resolve device → release group → terminalIds
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
    const group = groupSnap.data();
    const terminalIds = Array.isArray(group.terminalIds) ? group.terminalIds : [];
    if (terminalIds.length === 0) {
      return res.status(200).json({
        ok: true,
        now: new Date().toISOString(),
        releaseGroup: { id: releaseGroupId, name: group.name, gradeLabel: group.gradeLabel, terminalIds: [] },
        active: [],
        held: [],
      });
    }

    // Touch lastSeenAt
    dev.ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});

    const sinceMs = req.query.since ? new Date(String(req.query.since)).getTime() : null;
    const cutoffMs = sinceMs && !Number.isNaN(sinceMs)
      ? Math.max(sinceMs, Date.now() - WINDOW_MS)
      : Date.now() - WINDOW_MS;

    // Firestore IN supports up to 30 values; we only ever expect 1-3 terminals per group.
    // Fetch per-terminal with single equality (no composite index needed) and
    // filter/sort recordedAt in memory.
    const perTerm = await Promise.all(
      terminalIds.slice(0, 30).map((tidx) =>
        db.collection(tenancy.pickupEventsPath(tid))
          .where('terminalId', '==', tidx)
          .limit(200).get()
      )
    );
    const recordedMs = (d) => {
      const v = d.data().recordedAt;
      if (!v) return 0;
      if (typeof v.toMillis === 'function') return v.toMillis();
      if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; }
      if (v instanceof Date) return v.getTime();
      return 0;
    };
    const allDocs = perTerm.flatMap((s) => s.docs).filter((d) => recordedMs(d) > cutoffMs);
    allDocs.sort((a, b) => recordedMs(b) - recordedMs(a));
    const snap = { docs: allDocs.slice(0, 80) };

    const maxActive = Math.max(1, Math.min(4, parseInt(req.query.max, 10) || 2));
    const active = [];
    const held = [];
    let todayReleased = 0;
    const todayStartMs = (() => {
      // Local-day start in UTC+7 (WIB)
      const now = new Date(Date.now() + 7 * 3600 * 1000);
      const ymd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return ymd - 7 * 3600 * 1000;
    })();
    // Decisions written for audit but never shown on the iPad.
    // Keeps the screen quiet for: parents at the wrong gate, randoms with
    // out-of-system Hikvision enrolments, and out-of-window scans.
    for (const doc of snap.docs) {
      const data = doc.data();
      const status = data.status || 'pending';
      if (SILENT_ON_IPAD.has(data.decision)) continue;
      if (status === 'pending' && active.length < 50) {
        active.push(doc);
      } else if (status === 'held') {
        held.push(doc);
      } else if (status === 'released') {
        const releasedAt = data.teacherRelease?.at?.toMillis ? data.teacherRelease.at.toMillis()
          : (data.recordedAt?.toMillis ? data.recordedAt.toMillis() : 0);
        if (releasedAt >= todayStartMs) todayReleased++;
      }
    }
    // active is desc-by-recordedAt; show oldest unresolved first (FIFO).
    active.reverse();
    const activeShown = active.slice(0, maxActive);

    const [activeOut, heldOut] = await Promise.all([
      Promise.all(activeShown.map((d) => shapePickupEvent(bucket, tid, d))),
      Promise.all(held.map((d) => shapePickupEvent(bucket, tid, d))),
    ]);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      ok: true,
      now: new Date().toISOString(),
      releaseGroup: {
        id: releaseGroupId,
        name: group.name,
        gradeLabel: group.gradeLabel,
        terminalIds,
      },
      active: activeOut,
      held: heldOut,
      todayReleased,
    });
  } catch (e) {
    console.error('[pickup/tablet/feed]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
