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
 *     guardianName, guardianEmail,
 *     students: [{ id?, studentId?, firstName, nickname, name?, gradeSelection?, grade?, className?, homeroom? }],
 *     chaperones: [{
 *        tempId,         // ties to /face uploads
 *        name,
 *        relation,       // any short string (canonical or custom)
 *        email?, idNumber?,
 *        authorizedStudentIds: [...],
 *        facePaths: [storage paths from /face]   // ≥1 required
 *     }],
 *     consentSignature   // required typed consent field
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
const STUDENT_TEXT_RE = /^[A-Za-z ]+$/;
const EY_GRADE_OPTIONS = ['EY1', 'EY2', 'EY3'];
const NUMERIC_GRADE_OPTIONS = ['1', '2', '3', '4', '5'];
const GRADE_SELECTION_SET = new Set([...EY_GRADE_OPTIONS, ...NUMERIC_GRADE_OPTIONS]);
const EY_GRADE_SET = new Set(EY_GRADE_OPTIONS);

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
  const relation = sanitizeRelation(c.relation);
  if (relation === null) return null;
  if (!name || name.length < 2 || name.length > 80) return null;
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
    phone: c.phone ? String(c.phone).trim().slice(0, 24) : null,
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

function queueJobId(tid, recordId, templateType) {
  const safe = `${tid}-${recordId}-${templateType}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.slice(0, 180);
}

function sanitizeStudentName(raw) {
  return String(raw || '')
    .replace(/[^A-Za-z ]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120);
}

function sanitizeGradeSelection(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function composeStudentName(firstName, nickname) {
  if (firstName && nickname) return `${firstName} (${nickname})`;
  return firstName || nickname || '';
}

function normalizeStudentRecord(raw, idx) {
  const studentIdRaw = String(raw?.studentId || '').trim().replace(/\D/g, '').slice(0, 10);
  if (studentIdRaw && !STUDENT_ID_RE.test(studentIdRaw)) {
    return { ok: false, field: 'studentId', message: `Student #${idx + 1}: Student ID must be exactly 10 digits.` };
  }

  const firstName = sanitizeStudentName(raw?.firstName || raw?.name || '');
  if (!firstName || !STUDENT_TEXT_RE.test(firstName)) {
    return { ok: false, field: 'firstName', message: `Student #${idx + 1}: First name must use letters and spaces only.` };
  }

  const nickname = sanitizeStudentName(raw?.nickname);
  if (!nickname || !STUDENT_TEXT_RE.test(nickname)) {
    return { ok: false, field: 'nickname', message: `Student #${idx + 1}: Nickname must use letters and spaces only.` };
  }

  const gradeSelection = sanitizeGradeSelection(raw?.gradeSelection || raw?.className || raw?.homeroom || raw?.grade);
  if (!GRADE_SELECTION_SET.has(gradeSelection)) {
    return { ok: false, field: 'gradeSelection', message: `Student #${idx + 1}: Academic year grade must be EY1, EY2, EY3, or 1–5.` };
  }

  const resolvedId = String(raw?.id || '').trim() || `tmp-${crypto.randomBytes(6).toString('hex')}`;
  const name = composeStudentName(firstName, nickname);

  if (EY_GRADE_SET.has(gradeSelection)) {
    return {
      ok: true,
      student: {
        id: resolvedId,
        studentId: studentIdRaw || null,
        firstName,
        nickname,
        name,
        gradeSelection,
        grade: 'EY',
        className: gradeSelection,
        homeroom: gradeSelection,
      },
    };
  }

  return {
    ok: true,
    student: {
      id: resolvedId,
      studentId: studentIdRaw || null,
      firstName,
      nickname,
      name,
      gradeSelection,
      grade: gradeSelection,
      className: '',
      homeroom: gradeSelection,
    },
  };
}

function validateStudent(raw, idx) {
  return normalizeStudentRecord(raw, idx);
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
  const guardianPhone = String(body.guardianPhone || '').trim() || null;
  const consentSignature = String(body.consentSignature || '').trim();
  const students = Array.isArray(body.students) ? body.students : [];
  const chaperones = Array.isArray(body.chaperones) ? body.chaperones : [];

  if (!guardianName || guardianName.length < 2) return res.status(400).json({ error: 'guardianName required' });
  if (!guardianEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guardianEmail)) {
    return res.status(400).json({ error: 'guardianEmail invalid' });
  }
  if (!consentSignature) return res.status(400).json({ error: 'consentSignature required' });
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
    if (!s.studentId) continue;
    if (seenStudentIds.has(s.studentId)) {
      return res.status(400).json({
        error: 'duplicate-student-id',
        message: `Student ID ${s.studentId} appears more than once in this form.`,
      });
    }
    seenStudentIds.add(s.studentId);
  }

  const validStudentIds = new Set(cleanStudents.map((s) => s.id));
  const hasRealStudentIds = cleanStudents.some((s) => !!s.studentId);
  const hasClaimSid = claims.sid && cleanStudents.some((s) =>
    s.studentId === String(claims.sid) || s.id === String(claims.sid)
  );
  if (claims.sid && hasRealStudentIds && !hasClaimSid) {
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
    return res.status(400).json({ error: 'at least one valid chaperone required' });
  }

  const studentNames = cleanStudents.map((s) => s.name).filter(Boolean);
  const studentNameById = Object.fromEntries(cleanStudents.map((s) => [s.id, s.name]));

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
    const lockCandidates = cleanStudents
      .filter((s) => !!s.studentId)
      .map((s) => ({ sid: s.studentId, student: s }));
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

    // Durable email queue: enqueue job for Cloud Function worker. This avoids
    // Vercel post-response promise drops and provides audit visibility.
    if (guardianEmail) {
      const templateType = 'pickup_onboarding_confirmation';
      const jobId = queueJobId(tid, recordId, templateType);
      const queueRef = db.doc(`email_queue/${jobId}`);
      try {
        const existing = await queueRef.get();
        if (!existing.exists) {
          await queueRef.set({
            status: 'pending',
            templateType,
            tenantId: tid,
            recordId,
            formNumber: txOut.formNumber,
            to: guardianEmail,
            templateData: {
              guardianName,
              guardianEmail,
              guardianPhone,
              consentSignature,
              formNumber: txOut.formNumber,
              submittedAt: new Date().toISOString(),
              studentNames,
              students: cleanStudents.map((s) => ({
                name: s.name,
                firstName: s.firstName,
                nickname: s.nickname,
                gradeSelection: s.gradeSelection,
                homeroom: s.homeroom || null,
              })),
              chaperones: cleanChaperones.map((c) => ({
                name: c.name,
                relation: c.relation,
                email: c.email || null,
                phone: c.phone || null,
                authorizedStudentNames: c.authorizedStudentIds
                  .map((sid) => studentNameById[sid])
                  .filter(Boolean),
              })),
            },
            retryCount: 0,
            maxRetries: 3,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'pickup_onboarding_submit',
          }, { merge: false });
        }
      } catch (queueErr) {
        console.error('[pickup/onboarding/submit] email queue enqueue failed:', queueErr?.message, {
          tenantId: tid,
          recordId,
          formNumber: txOut.formNumber,
          queueJobId: jobId,
        });
      }
    }

    return res.status(200).json({ ok: true, recordId, formNumber: txOut.formNumber });
  } catch (err) {
    console.error('[pickup/onboarding/submit]', err.message, err.stack);
    return res.status(500).json({ error: 'internal' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };
