/**
 * GET /api/pickup/admin/officer-overrides-list
 *
 * Returns two lists for the /v2/officer-overrides admin page:
 *   - pending: non-OK pickup_events from the last 10 minutes that have an
 *     overrideCode and have NOT been approved yet — the live "needs help"
 *     queue gate officers see on the TV.
 *   - history: recent officer_override security_incidents (last `days`).
 *
 * Query: ?days=7  (history window, default 7, max 30)
 */
import admin from 'firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

const PENDING_WINDOW_MS = 10 * 60 * 1000;
const MAX_DAYS = 30;

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v?.toDate) {
    try { return v.toDate().toISOString(); } catch { return null; }
  }
  try { return new Date(v).toISOString(); } catch { return null; }
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const days = Math.max(1, Math.min(MAX_DAYS, parseInt(req.query.days || '7', 10)));
  const tid = tenancy.getTenantId(req.query.tenant);

  initializeFirebase();
  const db = admin.firestore();

  // ── pending (non-OK, code present, no override yet, last 10 min) ─────
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - PENDING_WINDOW_MS);
  let pending = [];
  try {
    const snap = await db.collection(tenancy.pickupEventsPath(tid))
      .where('recordedAt', '>', cutoff)
      .orderBy('recordedAt', 'desc')
      .limit(50)
      .get();
    snap.forEach((d) => {
      const e = d.data();
      if (!e.overrideCode) return;
      if (e.officerOverride) return;
      if (e.decision === 'ok') return;
      pending.push({
        id: d.id,
        eventId: e.eventId || d.id,
        decision: e.decision,
        cardState: e.cardState,
        gate: e.gate,
        chaperoneName: e.chaperone?.name || null,
        photoUrl: e.chaperone?.photoUrl || null,
        students: (e.students || []).map((s) => s.name).filter(Boolean),
        overrideCode: e.overrideCode,
        recordedAt: typeof e.recordedAt === 'string'
          ? e.recordedAt
          : (e.recordedAt?.toDate?.()?.toISOString?.() || null),
      });
    });
  } catch (e) {
    pending = [];
  }

  // ── history (officer_override incidents, last N days) ────────────────
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  let history = [];
  try {
    const snap = await db.collection(tenancy.securityIncidentsPath(tid))
      .where('kind', '==', 'officer_override')
      .where('createdAt', '>=', sinceIso)
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();
    snap.forEach((d) => {
      const i = d.data();
      history.push({
        id: d.id,
        eventId: i.eventId,
        gate: i.gate,
        chaperoneName: i.chaperoneName || null,
        employeeNo: i.employeeNo || null,
        override: i.override || null,
        createdAt: i.createdAt,
      });
    });
  } catch (e) {
    // Index may be missing — fall back to scanning recent incidents
    try {
      const snap = await db.collection(tenancy.securityIncidentsPath(tid))
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get();
      snap.forEach((d) => {
        const i = d.data();
        if (i.kind !== 'officer_override') return;
        if (i.createdAt && i.createdAt < sinceIso) return;
        history.push({
          id: d.id,
          eventId: i.eventId,
          gate: i.gate,
          chaperoneName: i.chaperoneName || null,
          employeeNo: i.employeeNo || null,
          override: i.override || null,
          createdAt: i.createdAt,
        });
      });
    } catch {}
  }

  // ── flagged releases (red card released by teacher/officer, last N days) ─
  let flaggedReleases = [];
  try {
    const sinceTs = admin.firestore.Timestamp.fromMillis(sinceMs);
    const snap = await db.collection(tenancy.pickupEventsPath(tid))
      .where('recordedAt', '>=', sinceTs)
      .orderBy('recordedAt', 'desc')
      .limit(500)
      .get();

    snap.forEach((d) => {
      const e = d.data() || {};
      const cardState = String(e.cardState || '').toLowerCase();
      if (cardState !== 'red') return;

      const teacherRel = e.teacherRelease || null;
      const officerRel = e.officerOverride || null;
      if (!teacherRel && !officerRel) return;

      const releasedAt = toIso(teacherRel?.at) || toIso(officerRel?.at) || toIso(e.recordedAt);
      flaggedReleases.push({
        id: d.id,
        eventId: e.eventId || d.id,
        gate: e.gate || null,
        chaperoneName: e.chaperone?.name || null,
        students: (e.students || []).map((s) => s.name).filter(Boolean),
        releasedBy: teacherRel?.by || officerRel?.by || null,
        releaseSource: teacherRel ? 'teacher' : 'officer',
        flagged: true,
        captureStoragePath: teacherRel?.captureStoragePath || null,
        reviewedAt: toIso(e.reviewedAt),
        releasedAt,
        recordedAt: toIso(e.recordedAt),
      });
    });
  } catch {
    flaggedReleases = [];
  }

  flaggedReleases.sort((a, b) => String(b.releasedAt || '').localeCompare(String(a.releasedAt || '')));

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    ok: true,
    tenant: tid,
    pending,
    history,
    flaggedReleases,
    days,
    counts: {
      pending: pending.length,
      history: history.length,
      flaggedReleases: flaggedReleases.length,
    },
  });
}

export default withAuth(handler, { methods: ['GET'] });
