/**
 * GET /api/downloads/runs/list
 *
 * Lightweight history listing for the Downloads Hub "Recently run" rail
 * and the (TODO) full history tab. Reads from `tenants/{tid}/reportRuns`
 * (see lib/download-runner.js `writeReportRun`).
 *
 * Query params
 *   cardId?    — filter to one card (e.g. 'attendance')
 *   mineOnly   — 'true' (default) limits results to the caller's own runs
 *   limit      — page size, default 20, max 100
 *   cursor     — Firestore doc id of the last item from the previous page
 *
 * Response
 *   {
 *     ok: true,
 *     runs: [
 *       { id, cardId, format, from, to, rowCount, createdAt,
 *         byEmail, mode, status, storageAvailable, durationMs }
 *     ],
 *     nextCursor: string|null
 *   }
 *
 * Signed download URLs are NEVER returned here — call /runs/:id/download
 * for that (re-checks ownership / compliance role, audits the redownload).
 *
 * Firestore composite index required: collection reportRuns (byUid ASC, createdAt DESC)
 * And for cardId filter: (cardId ASC, byUid ASC, createdAt DESC)
 *
 * Firestore rules needed: tenants/{tid}/reportRuns/{runId} — read where
 *   request.auth.uid == resource.data.byUid OR custom claim contains 'download_compliance'
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

const DOWNLOAD_KEYS = [
  'downloads.download_operational',
  'downloads.download_directory',
  'downloads.download_security',
  'downloads.download_compliance',
];

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const actor = req.user || {};
  const myId = actor.uid || actor.email || null;

  const cardId    = typeof req.query.cardId === 'string' ? req.query.cardId : '';
  const mineOnly  = String(req.query.mineOnly ?? 'true').toLowerCase() !== 'false';
  const cursor    = typeof req.query.cursor === 'string' ? req.query.cursor : '';
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;
  if (limit > 100) limit = 100;

  let q = db.collection(tenancy.reportRunsPath(tid));
  if (cardId)   q = q.where('cardId', '==', cardId);
  if (mineOnly && myId) q = q.where('byUid', '==', myId);
  q = q.orderBy('createdAt', 'desc').limit(limit);

  if (cursor) {
    try {
      const cur = await db.collection(tenancy.reportRunsPath(tid)).doc(cursor).get();
      if (cur.exists) q = q.startAfter(cur);
    } catch {}
  }

  let snap;
  try {
    snap = await q.get();
  } catch (err) {
    // Firestore will throw FAILED_PRECONDITION if the composite index
    // hasn't been created yet — surface a helpful hint so the operator
    // can click the link Firestore prints in the message.
    console.error('[runs/list] query failed:', err.message);
    return res.status(500).json({
      error: 'query_failed',
      message: err.message,
      hint: 'Create the composite index Firestore suggests, then retry.',
    });
  }

  const runs = snap.docs.map((d) => {
    const r = d.data() || {};
    const ts = r.createdAt?.toMillis?.() || null;
    return {
      id: d.id,
      cardId: r.cardId || null,
      format: r.format || null,
      from: r.from || null,
      to: r.to || null,
      rowCount: r.rowCount || 0,
      bytesOut: r.bytesOut || 0,
      createdAt: ts,
      byEmail: r.byEmail || null,
      byName: r.byName || null,
      mode: r.mode || 'sync',
      status: r.status || 'completed',
      storageAvailable: !!r.storagePath,
      durationMs: r.durationMs || 0,
    };
  });

  const nextCursor = snap.docs.length === limit
    ? snap.docs[snap.docs.length - 1].id
    : null;

  return res.status(200).json({ ok: true, runs, nextCursor });
}

export default withApi(handler, {
  methods: ['GET'],
  // `withApi` only supports a single permission key OR anyPermission list.
  // The 4 download keys grant access to different card sets, so we accept
  // ANY of them at the route layer; individual card filtering is the
  // hub's responsibility (cards the user can't run won't appear in their
  // history because /downloads/{card} would have rejected them).
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 120,
});
