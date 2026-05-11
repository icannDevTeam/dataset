/**
 * GET /api/pickup/admin/enrollment-board
 *
 * Powers the /v2/pickup-enroll page. Returns:
 *   - devices:  configured Hikvision terminals (ip, name, gradeScopes, enabled)
 *   - groups:   chaperones grouped by homeroom of their authorized students,
 *               each with per-device enrolment status pulled from the
 *               chaperone doc's `deviceEnrollResults` (written by
 *               lib/chaperone-enroll.js).
 *
 * Response shape:
 *   {
 *     ok: true,
 *     devices: [{ name, ip, section, gradeScopes, enabled }],
 *     groups: [
 *       {
 *         homeroom: '4A',
 *         grade: '4',
 *         chaperones: [
 *           {
 *             id, employeeNo, name, relation, phone,
 *             status, photoCount, studentClasses, studentGrades,
 *             authorizedStudents: [{ id, name }],
 *             enrollment: {
 *               // matched = devices whose gradeScopes intersect this chaperone
 *               matched: [{ name, ip, ok, error?, lastAttemptAt? }],
 *               // unmatched = devices not in scope (informational)
 *               unmatched: [{ name, ip }],
 *             },
 *             allEnrolled: bool,    // true if every matched device is ok
 *             needsEnroll: bool,    // photos uploaded but no matched device ok
 *           },
 *         ],
 *       },
 *     ],
 *     summary: { totalChaperones, fullyEnrolled, partiallyEnrolled,
 *                neverEnrolled, awaitingPhotos },
 *   }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import { resolveEnrollmentDevices } from '../../../../lib/chaperone-enroll';

const tenancy = require('../../../../lib/tenancy');

const SIGNED_TTL_MS = 10 * 60 * 1000;

function gradeFromHomeroom(hr) {
  if (!hr) return null;
  const m = String(hr).match(/^(\d{1,2})/);
  return m ? m[1] : null;
}

function deviceMatchesGrades(device, grades) {
  if (!device.gradeScopes || device.gradeScopes.length === 0) return true;
  if (!grades || grades.length === 0) return false;
  return device.gradeScopes.some((g) => grades.includes(String(g)));
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const tid = tenancy.getTenantId(req.query.tenant);

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();

    // Devices: include disabled ones too so the UI can show "device offline"
    // banners — we just strip the password before sending.
    const devicesFull = await resolveEnrollmentDevices(db, tid);
    const devicesPublic = devicesFull.map((d) => ({
      name: d.name,
      ip: d.ip,
      section: d.section || null,
      gradeScopes: d.gradeScopes || [],
    }));

    const snap = await db.collection(tenancy.chaperonesPath(tid)).get();
    if (snap.empty) {
      return res.status(200).json({
        ok: true,
        devices: devicesPublic,
        groups: [],
        summary: { totalChaperones: 0, fullyEnrolled: 0, partiallyEnrolled: 0, neverEnrolled: 0, awaitingPhotos: 0 },
      });
    }

    // Pre-fetch authorized students for name lookup
    const allStudentIds = new Set();
    const chaperones = [];
    const facePathsToSign = new Set();
    snap.forEach((d) => {
      const c = d.data() || {};
      // Only show approved (or approved-pending-faces) and not-suspended chaperones.
      // Pending/rejected/suspended records belong to the admin queue, not the
      // enrollment board.
      if (c.suspendedAt) return;
      if (!['approved', 'approved_pending_faces'].includes(c.status)) return;
      chaperones.push({ id: d.id, ...c });
      (c.authorizedStudentIds || []).forEach((sid) => sid && allStudentIds.add(sid));
      const first = (c.facePaths || [])[0];
      if (first) facePathsToSign.add(first);
    });
    if (chaperones.length === 0) {
      return res.status(200).json({
        ok: true,
        devices: devicesPublic,
        groups: [],
        summary: { totalChaperones: 0, fullyEnrolled: 0, partiallyEnrolled: 0, neverEnrolled: 0, awaitingPhotos: 0 },
      });
    }

    const [studentEntries, signedEntries] = await Promise.all([
      Promise.all([...allStudentIds].map(async (sid) => {
        try {
          const s = await db.doc(`${tenancy.studentsPath(tid)}/${sid}`).get();
          if (s.exists) return [sid, s.data() || {}];
          const legacy = await db.doc(`students/${sid}`).get();
          return [sid, legacy.exists ? (legacy.data() || {}) : null];
        } catch { return [sid, null]; }
      })),
      Promise.all([...facePathsToSign].map(async (p) => {
        try {
          const [u] = await bucket.file(p).getSignedUrl({
            action: 'read', expires: Date.now() + SIGNED_TTL_MS,
          });
          return [p, u];
        } catch { return [p, null]; }
      })),
    ]);
    const studentMeta = Object.fromEntries(studentEntries);
    const faceUrlByPath = new Map(signedEntries);

    // Group by homeroom
    const groupsMap = new Map(); // homeroom -> { homeroom, grade, chaperones[] }

    let fullyEnrolled = 0;
    let partiallyEnrolled = 0;
    let neverEnrolled = 0;
    let awaitingPhotos = 0;

    for (const c of chaperones) {
      const photoCount = (c.facePaths || []).length;
      const studentClasses = Array.isArray(c.studentClasses) && c.studentClasses.length
        ? c.studentClasses
        : (c.authorizedStudentIds || [])
            .map((sid) => studentMeta[sid]?.homeroom)
            .filter(Boolean);
      const studentGrades = Array.isArray(c.studentGrades) && c.studentGrades.length
        ? c.studentGrades.map(String)
        : [...new Set(studentClasses.map(gradeFromHomeroom).filter(Boolean))];

      const authorizedStudents = (c.authorizedStudentIds || []).map((sid) => ({
        id: sid,
        name: studentMeta[sid]?.name || sid,
        homeroom: studentMeta[sid]?.homeroom || null,
      }));

      // Build per-device enrollment view
      const lastResults = Array.isArray(c.deviceEnrollResults) ? c.deviceEnrollResults : [];
      const lastAttemptAt = c.deviceEnrollAttemptedAt || null;
      const resultByIp = new Map(lastResults.map((r) => [r.ip, r]));

      const matched = [];
      const unmatched = [];
      for (const d of devicesPublic) {
        if (deviceMatchesGrades(d, studentGrades)) {
          const r = resultByIp.get(d.ip);
          matched.push({
            name: d.name,
            ip: d.ip,
            ok: r ? !!r.ok : false,
            error: r && !r.ok ? (r.error || 'never attempted') : null,
            attempted: !!r,
            lastAttemptAt: r ? lastAttemptAt : null,
          });
        } else {
          unmatched.push({ name: d.name, ip: d.ip });
        }
      }

      const matchedAttempted = matched.filter((m) => m.attempted);
      const matchedOk = matched.filter((m) => m.ok);
      const allEnrolled = matched.length > 0 && matchedOk.length === matched.length;
      const noPhotos = photoCount === 0;
      const needsEnroll = !noPhotos && matchedOk.length === 0;

      if (noPhotos) awaitingPhotos += 1;
      else if (allEnrolled) fullyEnrolled += 1;
      else if (matchedOk.length > 0) partiallyEnrolled += 1;
      else neverEnrolled += 1;

      const item = {
        id: c.id,
        employeeNo: c.employeeNo || null,
        name: c.name || '—',
        relation: c.relation || null,
        phone: c.phone || null,
        email: c.email || null,
        status: c.status || null,
        photoCount,
        facePhotoUrl: faceUrlByPath.get((c.facePaths || [])[0]) || null,
        approvedAt: c.approvedAt || null,
        guardianName: c.guardianName || null,
        studentClasses,
        studentGrades,
        authorizedStudents,
        enrollment: { matched, unmatched },
        allEnrolled,
        needsEnroll,
        noPhotos,
        matchedDeviceCount: matched.length,
        enrolledDeviceCount: matchedOk.length,
        suspended: !!c.suspendedAt,
      };

      // Use first authorized student's homeroom as the group key. If none,
      // bucket under '— Unassigned'.
      const homeroom = (studentClasses[0] || '— Unassigned').toUpperCase();
      const grade = gradeFromHomeroom(homeroom) || '?';
      if (!groupsMap.has(homeroom)) {
        groupsMap.set(homeroom, { homeroom, grade, chaperones: [] });
      }
      groupsMap.get(homeroom).chaperones.push(item);
    }

    // Sort: by grade asc, homeroom asc; chaperones inside by name
    const groups = [...groupsMap.values()].sort((a, b) => {
      const ga = parseInt(a.grade, 10) || 999;
      const gb = parseInt(b.grade, 10) || 999;
      if (ga !== gb) return ga - gb;
      return a.homeroom.localeCompare(b.homeroom);
    });
    groups.forEach((g) => g.chaperones.sort((x, y) => x.name.localeCompare(y.name)));

    return res.status(200).json({
      ok: true,
      devices: devicesPublic,
      groups,
      summary: {
        totalChaperones: chaperones.length,
        fullyEnrolled,
        partiallyEnrolled,
        neverEnrolled,
        awaitingPhotos,
      },
    });
  } catch (err) {
    console.error('[pickup/admin/enrollment-board]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['GET'], permission: 'pickup_admin.view' });
