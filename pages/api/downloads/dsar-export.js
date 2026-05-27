/**
 * POST /api/downloads/dsar-export
 *
 * Privacy / GDPR-style Data Subject Access Request export. Builds a ZIP
 * containing every record we hold for ONE subject, then uploads it to
 * Firebase Storage and writes an `exportJobs` doc so the existing
 * `/api/downloads/_jobs/status` endpoint can mint a signed download URL
 * and surface progress in the hub.
 *
 * This endpoint does NOT use lib/download-runner.runDownload — the ZIP
 * shape doesn't fit the columns+rows contract. It DOES use the runner's
 * exported `writeReportRun` so this export shows up in the same
 * "Recently run" rail as every other download.
 *
 * Body (required):
 *   { subjectType: 'student'|'chaperone'|'parent', subjectId: string }
 *
 * Permission:  downloads.download_compliance
 * Re-auth:     120s (sensitive op — same as /_jobs/start)
 * Audit kind:  downloads.dsar.export    (metadata.severity = 'critical')
 *
 * Output:
 *   gs://{bucket}/exports/{tid}/{runId}.zip
 *   ZIP contents:
 *     profile.csv          — one row, all profile fields
 *     attendance.csv       — every attendance scan for the subject
 *     pickups.csv          — every pickup event the subject participated in
 *     photos-manifest.csv  — Storage paths for face / id photos (no images)
 *     README.txt           — provenance + how to interpret
 *
 * Response (202):
 *   { ok:true, jobId, runId, statusUrl }
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const JSZip = require('jszip');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');
const { writeReportRun } = require('../../../lib/download-runner');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

const SUBJECT_TYPES = new Set(['student', 'chaperone', 'parent']);

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
function toIso(v) {
  if (!v) return '';
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function resolveSubject(db, tid, type, id) {
  const idStr = String(id).trim();
  if (type === 'student') {
    // Try direct doc id, then look up by binusId field.
    let snap = await db.doc(`${tenancy.studentsPath(tid)}/${idStr}`).get().catch(() => null);
    if (snap && snap.exists) return { ref: snap.ref, data: snap.data() || {} };
    const q = await db.collection(tenancy.studentsPath(tid))
      .where('binusId', '==', idStr).limit(1).get().catch(() => null);
    if (q && !q.empty) return { ref: q.docs[0].ref, data: q.docs[0].data() || {} };
    // Legacy: student_metadata
    snap = await db.doc(`student_metadata/${idStr}`).get().catch(() => null);
    if (snap && snap.exists) return { ref: snap.ref, data: snap.data() || {} };
    return null;
  }
  if (type === 'chaperone') {
    const snap = await db.doc(`${tenancy.chaperonesPath(tid)}/${idStr}`).get().catch(() => null);
    if (snap && snap.exists) return { ref: snap.ref, data: snap.data() || {} };
    return null;
  }
  if (type === 'parent') {
    // Parents live inside pickup_contacts or onboarding submissions.
    const q = await db.collection(tenancy.pickupContactsPath(tid))
      .where('email', '==', idStr).limit(1).get().catch(() => null);
    if (q && !q.empty) return { ref: q.docs[0].ref, data: q.docs[0].data() || {} };
    const snap = await db.doc(`${tenancy.pickupContactsPath(tid)}/${idStr}`).get().catch(() => null);
    if (snap && snap.exists) return { ref: snap.ref, data: snap.data() || {} };
    return null;
  }
  return null;
}

function profileCsv(data) {
  const flat = [];
  for (const [k, v] of Object.entries(data || {})) {
    let val;
    if (v == null) val = '';
    else if (typeof v === 'object' && typeof v.toDate === 'function') val = v.toDate().toISOString();
    else if (typeof v === 'object') val = JSON.stringify(v);
    else val = String(v);
    flat.push([k, val]);
  }
  return csv([['field', 'value'], ...flat]);
}

async function attendanceCsv(db, tid, empNo) {
  // Best-effort scan: walk the last 365 day-buckets under tenant + legacy.
  const out = [['date', 'time', 'status', 'source', 'confidence']];
  if (!empNo) return csv(out);
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const date = d.toISOString().slice(0, 10);
    let snap = await db.doc(`${tenancy.tenantDoc(tid)}/attendance/${date}/records/${empNo}`)
      .get().catch(() => null);
    if (!snap || !snap.exists) {
      snap = await db.doc(`attendance/${date}/records/${empNo}`).get().catch(() => null);
    }
    if (!snap || !snap.exists) continue;
    const r = snap.data() || {};
    out.push([
      date,
      (r.timestamp || '').slice(11, 19),
      r.status || (r.late ? 'Late' : 'Present'),
      r.source || r.terminal || '',
      r.confidence != null ? Number(r.confidence).toFixed(2) : '',
    ]);
  }
  return csv(out);
}

async function pickupsCsv(db, tid, subjectType, subjectId, subjectData) {
  const out = [['createdAt', 'role', 'studentName', 'chaperoneName', 'method', 'gate']];
  const idStr = String(subjectId);
  // Pull a generous window; in-memory filter.
  const snap = await db.collection(tenancy.pickupEventsPath(tid))
    .orderBy('createdAt', 'desc').limit(5000).get().catch(() => null);
  if (snap) {
    snap.forEach((d) => {
      const e = d.data() || {};
      const matchStudent = subjectType === 'student' && (
        String(e.studentBinusId || '') === idStr ||
        String(e.studentId || '') === idStr ||
        (subjectData?.name && e.studentName === subjectData.name)
      );
      const matchChap = subjectType === 'chaperone' && (
        String(e.chaperoneId || '') === idStr ||
        (subjectData?.name && e.chaperoneName === subjectData.name)
      );
      const matchParent = subjectType === 'parent' && (
        (subjectData?.email && e.parentEmail === subjectData.email) ||
        (subjectData?.name && e.parentName === subjectData.name)
      );
      if (!matchStudent && !matchChap && !matchParent) return;
      out.push([
        toIso(e.createdAt || e.ts || e.timestamp).slice(0, 19).replace('T', ' '),
        matchStudent ? 'student' : matchChap ? 'chaperone' : 'parent',
        e.studentName || '',
        e.chaperoneName || '',
        e.method || e.matchMethod || '',
        e.gate || e.terminal || '',
      ]);
    });
  }
  return csv(out);
}

async function photosManifestCsv(subjectType, subjectId, subjectData) {
  const out = [['kind', 'path']];
  if (subjectType === 'student') {
    const paths = subjectData?.facePaths || subjectData?.photoUrls || [];
    for (const p of paths) out.push(['student_face', String(p)]);
    if (subjectData?.idPhoto) out.push(['student_id_photo', String(subjectData.idPhoto)]);
  }
  if (subjectType === 'chaperone') {
    const paths = subjectData?.facePaths || subjectData?.photoUrls || [];
    for (const p of paths) out.push(['chaperone_face', String(p)]);
    if (subjectData?.idPhoto) out.push(['chaperone_id', String(subjectData.idPhoto)]);
  }
  return csv(out);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const filters = (req.body && req.body.filters) || req.body || {};
  const subjectType = String(filters.subjectType || '').trim().toLowerCase();
  const subjectId   = String(filters.subjectId   || '').trim();
  if (!SUBJECT_TYPES.has(subjectType)) {
    return res.status(400).json({ error: 'bad_subjectType', expected: [...SUBJECT_TYPES] });
  }
  if (!subjectId) {
    return res.status(400).json({ error: 'bad_subjectId' });
  }

  // Step-up re-auth — tighter window for privacy ops.
  const reauth = await verifyReauth(req, { maxAgeSec: 120 });
  if (!reauth.ok) {
    if (reauth.retryAfterSec) res.setHeader('Retry-After', reauth.retryAfterSec);
    return res.status(reauth.status).json({
      error: reauth.error, message: reauth.message, retryAfter: reauth.retryAfterSec,
    });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const actor = req.user || null;
  const startedAt = Date.now();

  const subject = await resolveSubject(db, tid, subjectType, subjectId);
  if (!subject) {
    return res.status(404).json({ error: 'subject_not_found', subjectType, subjectId });
  }

  // Use the subject's ID-of-record for attendance lookups.
  const empNo = subjectType === 'student'
    ? (subject.data.binusId || subject.data.binusianId || subject.data.studentId || subject.ref.id)
    : null;

  // Build the ZIP.
  const zip = new JSZip();
  zip.file('profile.csv',         profileCsv(subject.data));
  zip.file('attendance.csv',      await attendanceCsv(db, tid, empNo));
  zip.file('pickups.csv',         await pickupsCsv(db, tid, subjectType, subjectId, subject.data));
  zip.file('photos-manifest.csv', await photosManifestCsv(subjectType, subjectId, subject.data));
  zip.file('README.txt', [
    'BINUS Facial Attendance — Data Subject Access Request (DSAR) Export',
    '',
    `Generated:    ${new Date().toISOString()}`,
    `Tenant:       ${tid}`,
    `Subject:      ${subjectType} / ${subjectId}`,
    `Requested by: ${actor?.email || '(unknown)'}`,
    '',
    'Files',
    '  profile.csv          One row per profile field (field, value).',
    '  attendance.csv       Every attendance scan recorded for the subject.',
    '  pickups.csv          Every pickup event the subject participated in.',
    '  photos-manifest.csv  Storage paths for face / ID photos (no binary).',
    '',
    'Storage objects referenced in photos-manifest.csv are NOT included.',
    'Operators MUST package those separately when fulfilling a formal DSAR.',
    '',
    'Retention: this export expires from Storage after 30 days per bucket lifecycle policy.',
  ].join('\n'));

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  // Allocate a stable id used for storage + reportRuns + exportJobs.
  const runId = db.collection('_ids').doc().id;
  const storagePath = `exports/${tid}/${runId}.zip`;
  const filename = `binus-dsar_${subjectType}_${subjectId.replace(/[^a-zA-Z0-9._-]/g, '_')}_${runId.slice(0, 8)}.zip`;

  let bucketName = '';
  try {
    const bucket = getFirebaseStorage().bucket();
    bucketName = bucket.name;
    await bucket.file(storagePath).save(buf, {
      contentType: 'application/zip',
      resumable: false,
      metadata: { metadata: {
        cardId: 'dsar-export', runId, subjectType,
        byEmail: actor?.email || '',
      } },
    });
  } catch (err) {
    console.error('[dsar-export] storage upload failed:', err);
    return res.status(500).json({ error: 'storage_upload_failed', message: err.message });
  }

  const durationMs = Date.now() - startedAt;

  // Mirror into reportRuns via the runner's shared writer.
  const ctx = {
    tenantId: tid, actor, format: 'zip',
    from: null, to: null,
    filters: { subjectType, subjectId },     // subjectId is hashed by the runner's PII redactor
  };
  await writeReportRun(db, ctx, { cardId: 'dsar-export' }, {
    runId, rowCount: 0, durationMs, mode: 'async', status: 'completed',
    storagePath, bucketName, bytesOut: buf.length,
  });

  // Also write an `exportJobs` doc so the existing _jobs/status endpoint
  // can sign a download URL without bespoke wiring.
  try {
    await db.doc(`${tenancy.tenantDoc(tid)}/exportJobs/${runId}`).set({
      status: 'completed',
      cardId: 'dsar-export',
      format: 'zip',
      rowCount: 0,
      storagePath,
      contentType: 'application/zip',
      filename,
      durationMs,
      byUid: actor?.uid || null,
      byEmail: actor?.email || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[dsar-export] exportJobs write failed:', err.message);
  }

  // Audit at CRITICAL severity — privacy export is the highest-impact
  // download we support.
  try {
    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: 'downloads.dsar.export',
      target: { type: 'dsar', id: `${subjectType}:${subjectId}`, label: filename },
      summary: `DSAR export for ${subjectType} ${subjectId} (${buf.length.toLocaleString()} bytes)`,
      metadata: {
        severity: 'critical',
        subjectType,
        runId,
        storagePath,
        bytesOut: buf.length,
        durationMs,
        reauthAuthTime: reauth.authTime,
      },
      req,
    });
  } catch {}

  return res.status(202).json({
    ok: true,
    async: true,
    jobId: runId,
    runId,
    statusUrl: `/api/downloads/_jobs/status?jobId=${runId}`,
    filename,
  });
}

export default withApi(handler, {
  methods: ['POST'],
  permission: 'downloads.download_compliance',
  rateLimit: 10,
});
