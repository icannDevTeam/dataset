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
import { withAuth } from '../../../../lib/auth-middleware';
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
  if (!['pending', 'approved', 'rejected'].includes(status)) {
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

    // For approved records, also pull final face paths from chaperones/{id}
    const approvedFacePaths = new Map();
    if (status === 'approved') {
      const allocList = [];
      rawRecords.forEach((r) => (r.allocatedChaperones || []).forEach((a) => allocList.push(a.chaperoneId)));
      for (const chapId of allocList) {
        try {
          const cs = await db.doc(`${tenancy.chaperonesPath(tid)}/${chapId}`).get();
          if (cs.exists) {
            const fp = (cs.data() || {}).facePaths || [];
            approvedFacePaths.set(chapId, fp);
            fp.forEach((p) => allFacePaths.add(p));
          }
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

export default withAuth(handler);
