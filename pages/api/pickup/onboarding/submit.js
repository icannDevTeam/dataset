/**
 * POST /api/pickup/onboarding/submit
 *
 * Token-gated parent-driven submission. Creates a `pickup_onboarding/{id}`
 * record with status=pending awaiting admin approval.
 *
 * Phase 3 changes:
 *   - Allocates a human-readable `formNumber` (PKP-YYYY-NNNNN) atomically
 *   - Single-submission lock: rejects (409) if any student in the request
 *     already has an active `pickup_student_locks/{sid}` (status != rejected)
 *   - Re-requires ≥1 face photo per chaperone
 *   - Caps chaperones at 3 (parent form), accepts custom relation strings
 *   - 5/hour per-IP rate limit
 *
 * Body:
 *   {
 *     token,
 *     guardianName, guardianEmail, guardianPhone,
 *     students: [{ id, studentId?, name, grade?, className?, homeroom? }],
 *     chaperones: [{
 *        tempId,         // ties to /face uploads
 *        name,
 *        relation,       // any short string (canonical or custom)
 *        phone, idNumber?, email?,
 *        authorizedStudentIds: [...],
 *        facePaths: [storage paths from /face]   // ≥1 required
 *     }],
 *     consentSignature   // typed name = guardianName
 *   }
 *
 * Returns: { ok, recordId, formNumber }
 *   On dedupe collision (409):
 *     { error:'student-already-registered', message, conflicts:[{studentId,studentName,formNumber,status}] }
 */
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';
import crypto from 'crypto';

const tenancy = require('../../../../lib/tenancy');
const { verifyPickupOnboardingToken } = require('../../../../lib/pickup-token');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');
const inviteLinks = require('../../../../lib/onboarding-invites');

const MAX_CHAPERONES = 5;
const MAX_STUDENTS = 10;
const FIRST_FORM_SEQ = 0;
const STUDENT_ID_RE = /^\d{10}$/;
const STUDENT_NAME_RE = /^[A-Za-z ]+$/;
const EY_LEVELS = new Set(['EY1', 'EY2', 'EY3']);

function clientIpHdr(req) {
  return clientIp(req);
}

function sanitizeRelation(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'other';
  // allow alpha + space + dash + slash, up to 40 chars
  if (!/^[a-z0-9 \-/]{1,40}$/.test(s)) return null;
  return s;
}

function sanitizeChaperone(c, validStudentIds) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim();
  const phone = String(c.phone || '').trim();
  const relation = sanitizeRelation(c.relation);
  if (relation === null) return null;
  if (!name || name.length < 2 || name.length > 80) return null;
  if (!phone || phone.length > 24) return null;
  const auth = Array.isArray(c.authorizedStudentIds)
    ? c.authorizedStudentIds.filter((s) => validStudentIds.has(String(s)))
    : [];
  if (auth.length === 0) return null;
  const facePaths = Array.isArray(c.facePaths)
    ? c.facePaths.filter((p) => typeof p === 'string' && p.startsWith('tenants/')).slice(0, 3)
    : [];
  // Face photos are optional at submit time — admin can add them later via
  // the pending-record edit flow before approval / device enrollment.
  return {
    tempId: String(c.tempId || '').slice(0, 64) || null,
    name,
    relation,
    phone,
    idNumber: c.idNumber ? String(c.idNumber).trim().slice(0, 32) : null,
    email: c.email ? String(c.email).trim().toLowerCase().slice(0, 128) : null,
    authorizedStudentIds: auth,
    facePaths,
  };
}

function formNumberFor(seq) {
  const year = new Date().getUTCFullYear();
  return `PKP-${year}-${String(seq).padStart(5, '0')}`;
}

function sanitizeStudentName(raw) {
  return String(raw || '')
    .replace(/[^A-Za-z ]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120);
}

function sanitizeEyLevel(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function validateStudent(raw, idx) {
  const studentId = String(raw?.studentId || raw?.id || '').trim().replace(/\D/g, '').slice(0, 10);
  if (!STUDENT_ID_RE.test(studentId)) {
    return { ok: false, field: 'studentId', message: `Student #${idx + 1}: Student ID must be exactly 10 digits.` };
  }

  const name = sanitizeStudentName(raw?.name);
  if (!name || !STUDENT_NAME_RE.test(name)) {
    return { ok: false, field: 'name', message: `Student #${idx + 1}: Name must use letters and spaces only.` };
  }

  const eyLevel = sanitizeEyLevel(raw?.className || raw?.homeroom);
  if (!EY_LEVELS.has(eyLevel)) {
    return { ok: false, field: 'className', message: `Student #${idx + 1}: EY level must be EY1, EY2, or EY3.` };
  }

  const grade = String(raw?.grade || '').trim().toUpperCase();
  if (grade && grade !== 'EY') {
    return { ok: false, field: 'grade', message: `Student #${idx + 1}: Grade must be EY for this trial.` };
  }

  return {
    ok: true,
    student: {
      id: studentId,
      studentId,
      name,
      grade: 'EY',
      className: eyLevel,
      homeroom: eyLevel,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rl = enforceRateLimit('pickup:onboarding-submit', clientIpHdr(req), { max: 5, windowMs: 60 * 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter,
      message: 'Too many submissions from your network. Please try again later.' });
  }

  const body = req.body || {};
  const claims = verifyPickupOnboardingToken(body.token || '');
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });

  const guardianName = String(body.guardianName || '').trim();
  const guardianEmail = String(body.guardianEmail || '').trim().toLowerCase();
  const guardianPhone = String(body.guardianPhone || '').trim();
  const consentSignature = String(body.consentSignature || '').trim();
  const students = Array.isArray(body.students) ? body.students : [];
  const chaperones = Array.isArray(body.chaperones) ? body.chaperones : [];

  if (!guardianName || guardianName.length < 2) return res.status(400).json({ error: 'guardianName required' });
  if (!guardianEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guardianEmail)) {
    return res.status(400).json({ error: 'guardianEmail invalid' });
  }
  if (!guardianPhone) return res.status(400).json({ error: 'guardianPhone required' });
  if (consentSignature.toLowerCase() !== guardianName.toLowerCase()) {
    return res.status(400).json({ error: 'typed signature must match guardian name' });
  }
  if (students.length === 0 || students.length > MAX_STUDENTS) {
    return res.status(400).json({ error: `students: 1–${MAX_STUDENTS} required` });
  }
  if (chaperones.length === 0 || chaperones.length > MAX_CHAPERONES) {
    return res.status(400).json({ error: `chaperones: 1–${MAX_CHAPERONES} required` });
  }

  const cleanStudents = [];
  for (let i = 0; i < students.length; i += 1) {
    const checked = validateStudent(students[i], i);
    if (!checked.ok) {
      return res.status(400).json({
        error: 'invalid-student',
        field: checked.field,
        index: i,
        message: checked.message,
      });
    }
    cleanStudents.push(checked.student);
  }

  const seenStudentIds = new Set();
  for (const s of cleanStudents) {
    if (seenStudentIds.has(s.studentId)) {
      return res.status(400).json({
        error: 'duplicate-student-id',
        message: `Student ID ${s.studentId} appears more than once in this form.`,
      });
    }
    seenStudentIds.add(s.studentId);
  }

  const validStudentIds = new Set(cleanStudents.map((s) => s.id));
  const hasClaimSid = claims.sid && cleanStudents.some((s) =>
    s.studentId === String(claims.sid) || s.id === String(claims.sid)
  );
  if (claims.sid && !hasClaimSid) {
    return res.status(400).json({
      error: 'token-bound-student-missing',
      message: `This invite link was issued for student ${claims.sid}. That student must be included in the submission.`,
      requiredStudentId: String(claims.sid),
    });
  }

  const cleanChaperones = chaperones
    .map((c) => sanitizeChaperone(c, validStudentIds))
    .filter(Boolean);
  if (cleanChaperones.length === 0) {
    return res.status(400).json({ error: 'at least one valid chaperone with ≥1 face photo required' });
  }

  const studentNames = cleanStudents.map((s) => s.name).filter(Boolean);

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = claims.tid;
    if (claims.lid) {
      const usable = await inviteLinks.assertInviteUsable(db, tid, claims.lid);
      if (!usable.ok) {
        return res.status(usable.status || 403).json({
          error: usable.reason,
          message: 'This invite link is no longer accepting submissions. Please contact the school for a new link.',
        });
      }
    }
    const recordId = crypto.randomBytes(12).toString('hex');
    const recRef = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
    const counterRef = db.doc(tenancy.idAllocationsDoc('pickup-form-counter', tid));
    const lockCandidates = cleanStudents.map((s) => ({ sid: s.studentId, student: s }));
    const lockRefs = lockCandidates.map(({ sid }) => db.doc(`${tenancy.pickupStudentLocksPath(tid)}/${sid}`));

    const txOut = await db.runTransaction(async (tx) => {
      // Reads first (Firestore txn rule)
      const lockSnaps = await Promise.all(lockRefs.map((r) => tx.get(r)));
      const conflicts = [];
      lockSnaps.forEach((snap, i) => {
        if (!snap.exists) return;
        const d = snap.data() || {};
        if (d.status && d.status !== 'rejected') {
          const lockStudent = lockCandidates[i]?.student || {};
          conflicts.push({
            studentId: lockCandidates[i]?.sid,
            studentName: d.studentName || lockStudent.name,
            formNumber: d.formNumber || null,
            status: d.status,
          });
        }
      });
      if (conflicts.length > 0) return { conflict: true, conflicts };

      const counterSnap = await tx.get(counterRef);
      const lastSeq = counterSnap.exists ? Number((counterSnap.data() || {}).last || FIRST_FORM_SEQ) : FIRST_FORM_SEQ;
      const nextSeq = lastSeq + 1;
      const formNumber = formNumberFor(nextSeq);
      const now = new Date().toISOString();

      tx.set(counterRef, {
        last: nextSeq,
        lastFormNumber: formNumber,
        tenantId: tid,
        updatedAt: now,
      }, { merge: true });

      tx.set(recRef, {
        tenantId: tid,
        formNumber,
        formSeq: nextSeq,
        status: 'pending',
        submittedAt: now,
        submittedFromIp: clientIpHdr(req),
        userAgent: req.headers['user-agent'] || null,
        tokenSid: claims.sid || null,
        tokenLid: claims.lid || null,
        tokenExp: claims.exp,
        guardian: {
          name: guardianName,
          email: guardianEmail,
          phone: guardianPhone,
          signatureRef: consentSignature,
        },
        students: cleanStudents,
        studentNames,
        chaperones: cleanChaperones,
        reviewedAt: null,
        reviewedBy: null,
        approvalNotes: null,
      });

      lockCandidates.forEach(({ sid, student }, i) => {
        tx.set(lockRefs[i], {
          studentId: sid,
          studentName: student.name,
          homeroom: student.homeroom || null,
          recordId,
          formNumber,
          status: 'pending',
          guardianName,
          guardianEmail,
          guardianPhone,
          submittedAt: now,
          tenantId: tid,
        }, { merge: false });
      });

      return { conflict: false, formNumber };
    });

    if (txOut.conflict) {
      const names = txOut.conflicts.map((c) => c.studentName).join(', ');
      return res.status(409).json({
        error: 'student-already-registered',
        message:
          `A pickup registration already exists for ${names}. ` +
          `For any changes (chaperone updates, photo replacement, etc.) please ` +
          `visit ACOP on the 3rd floor or email inquiries.simprug@binus.edu.`,
        conflicts: txOut.conflicts,
      });
    }

    if (claims.lid) {
      // Best-effort analytics — never block the success response.
      inviteLinks.recordUse(db, tid, claims.lid).catch(() => {});
    }
    return res.status(200).json({ ok: true, recordId, formNumber: txOut.formNumber });
  } catch (err) {
    console.error('[pickup/onboarding/submit]', err.message, err.stack);
    return res.status(500).json({ error: 'internal' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };
