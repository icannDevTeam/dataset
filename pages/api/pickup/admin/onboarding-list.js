/**
 * GET /api/pickup/admin/onboarding-list
 *
 * Admin-only. Returns pickup_onboarding records for review, enriched
 * with signed Storage URLs for chaperone face thumbnails and student
 * photoUrl from the tenant students collection (BINUS-sourced).
 *
 * Query: ?status=pending|approved|rejected (default: pending), ?limit=50
 *
 * Response shape:
 *   { ok, tenantId, status, records: [{
 *       id, status, submittedAt, guardian, students:[{id,name,homeroom,photoUrl?}],
 *       chaperones:[{...,faceUrls:[signedUrl,...]}],
 *       reviewedAt, reviewedBy, approvalNotes, rejectionReason,
 *       allocatedChaperones?
 *   }] }
 */
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../../lib/tenancy');

const URL_TTL_MS = 30 * 60 * 1000;

async function signPath(bucket, path) {
  if (!path) return null;
  try {
    const [url] = await bucket.file(path).getSignedUrl({
      action: 'read',
      expires: Date.now() + URL_TTL_MS,
    });
    return url;
  } catch {
    return null;
  }
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const status = String(req.query.status || 'pending');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  if (!['pending', 'approved', 'rejected', 'archived', 'changes_requested'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();
    const snap = await db.collection(tenancy.pickupOnboardingPath(tid))
      .where('status', '==', status)
      .limit(limit)
      .get();

    const studentIds = new Set();
    const allFacePaths = new Set();
    const rawRecords = [];
    snap.forEach((d) => {
      const data = { id: d.id, ...d.data() };
      rawRecords.push(data);
      (data.students || []).forEach((s) => s && s.id && studentIds.add(s.id));
      (data.chaperones || []).forEach((c) => {
        (c.facePaths || []).forEach((p) => allFacePaths.add(p));
      });
    });

    // For approved records, also pull final face paths from chaperones/{id}.
    // MUST be a single batched getAll — with 300+ approved chaperones the old
    // one-await-per-doc loop exceeded the serverless timeout and the Approved
    // tab rendered empty (pilot incident 2026-07-21).
    const approvedFacePaths = new Map();
    if (status === 'approved') {
      const allocIds = [...new Set(
        rawRecords.flatMap((r) => (r.allocatedChaperones || []).map((a) => a && a.chaperoneId)).filter(Boolean)
      )];
      for (let i = 0; i < allocIds.length; i += 100) {
        const chunk = allocIds.slice(i, i + 100);
        try {
          const snaps = await db.getAll(...chunk.map((id) => db.doc(`${tenancy.chaperonesPath(tid)}/${id}`)));
          snaps.forEach((cs) => {
            if (!cs.exists) return;
            const fp = (cs.data() || {}).facePaths || [];
            approvedFacePaths.set(cs.id, fp);
            fp.forEach((p) => allFacePaths.add(p));
          });
        } catch {}
      }
    }

    const [studentDocs, signedEntries] = await Promise.all([
      Promise.all([...studentIds].map(async (sid) => {
        try {
          const s = await db.doc(`${tenancy.studentsPath(tid)}/${sid}`).get();
          if (s.exists) return [sid, s.data() || {}];
          // Legacy fallback (dual-read window)
          const legacy = await db.doc(`students/${sid}`).get();
          return [sid, legacy.exists ? (legacy.data() || {}) : null];
        } catch { return [sid, null]; }
      })),
      Promise.all([...allFacePaths].map(async (p) => [p, await signPath(bucket, p)])),
    ]);
    const studentMap = new Map(studentDocs);
    const urlMap = new Map(signedEntries);

    const records = rawRecords.map((r) => {
      const students = (r.students || []).map((s) => {
        const doc = studentMap.get(s.id);
        return {
          ...s,
          photoUrl: doc?.photoUrl || null,
          dbName: doc?.name || null,
          dbHomeroom: doc?.homeroom || null,
        };
      });
      const chaperones = (r.chaperones || []).map((c, idx) => {
        let paths = c.facePaths || [];
        if (status === 'approved' && Array.isArray(r.allocatedChaperones) && r.allocatedChaperones[idx]) {
          const finalPaths = approvedFacePaths.get(r.allocatedChaperones[idx].chaperoneId);
          if (finalPaths && finalPaths.length) paths = finalPaths;
        }
        return {
          ...c,
          faceUrls: paths.map((p) => urlMap.get(p)).filter(Boolean),
        };
      });
      return { ...r, students, chaperones };
    });

    // Sort newest-first in memory (avoids needing a composite Firestore index)
    records.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

    return res.status(200).json({ ok: true, tenantId: tid, status, records });
  } catch (err) {
    console.error('[pickup/admin/onboarding-list]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { permission: 'pickup_admin.view' });
