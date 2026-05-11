/**
 * GET /api/pickup/admin/forms-export
 *
 * Returns a flattened list of pickup_onboarding records suitable for CSV /
 * PDF export, filtered by grade / individual student / status / date range.
 *
 * Query params:
 *   ?status=pending|approved|rejected|all  (default: all)
 *   ?grade=4                                (1-12; matches first digit of homeroom)
 *   ?homeroom=4C                            (exact homeroom match)
 *   ?studentId=BIN12345                     (filter by single student)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD          (submittedAt range)
 *   ?tenant=binus-simprug
 *
 * Response:
 *   { ok, total, records:[ {id,status,submittedAt, guardian,
 *       students:[{id,name,homeroom}],
 *       chaperones:[{name,relation,phone,email,idNumber, allocatedId, faceCount}],
 *       reviewedAt, reviewedBy} ] }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');

function gradeOf(homeroom) {
  if (!homeroom) return null;
  const m = String(homeroom).match(/^(\d{1,2})/);
  return m ? parseInt(m[1], 10) : null;
}

function tsToIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  return null;
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const status = String(req.query.status || 'all');
  const grade = req.query.grade ? parseInt(req.query.grade, 10) : null;
  const homeroom = req.query.homeroom ? String(req.query.homeroom).toUpperCase() : null;
  const studentId = req.query.studentId ? String(req.query.studentId) : null;
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

  try {
    initializeFirebase();
    const db = admin.firestore();
    let q = db.collection(tenancy.pickupOnboardingPath(tid));
    if (status !== 'all') q = q.where('status', '==', status);
    const snap = await q.limit(2000).get();

    const records = [];
    snap.forEach((d) => {
      const r = { id: d.id, ...d.data() };
      const submittedIso = tsToIso(r.submittedAt);
      if (from && submittedIso && submittedIso.slice(0, 10) < from) return;
      if (to && submittedIso && submittedIso.slice(0, 10) > to) return;

      const students = (r.students || []).map((s) => ({
        id: s.id, name: s.name, homeroom: s.homeroom || null,
      }));

      // Apply student-level filters: at least one student must match
      const matchStudent = students.some((s) => {
        if (studentId && s.id !== studentId) return false;
        if (homeroom && (s.homeroom || '').toUpperCase() !== homeroom) return false;
        if (grade != null && gradeOf(s.homeroom) !== grade) return false;
        return true;
      });
      if (!matchStudent && (studentId || homeroom || grade != null)) return;

      const allocMap = new Map();
      (r.allocatedChaperones || []).forEach((a, i) => allocMap.set(i, a.chaperoneId));

      const chaperones = (r.chaperones || []).map((c, i) => ({
        name: c.name,
        relation: c.relation,
        phone: c.phone || null,
        email: c.email || null,
        idNumber: c.idNumber || null,
        authorizedStudentIds: c.authorizedStudentIds || [],
        allocatedId: allocMap.get(i) || null,
        faceCount: (c.facePaths || []).length,
      }));

      records.push({
        id: r.id,
        status: r.status,
        submittedAt: submittedIso,
        guardian: r.guardian || null,
        students,
        chaperones,
        reviewedAt: tsToIso(r.reviewedAt),
        reviewedBy: r.reviewedBy || null,
        rejectionReason: r.rejectionReason || null,
      });
    });

    records.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));

    return res.status(200).json({ ok: true, total: records.length, tenantId: tid, records });
  } catch (err) {
    console.error('[pickup/admin/forms-export]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { permission: 'pickup_admin.view' });
