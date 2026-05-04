/**
 * POST /api/pickup/onboarding/submit
 *
 * Token-gated parent-driven submission. Creates a `pickup_onboarding/{id}`
 * record with status=pending awaiting admin approval. Face photos are
 * uploaded separately via /api/pickup/onboarding/face — this endpoint
 * accepts the textual form + array of storage paths returned by the
 * face uploader.
 *
 * Body:
 *   {
 *     token,
 *     guardianName, guardianEmail, guardianPhone,
 *     students: [{ id, name, homeroom }],
 *     chaperones: [{
 *        tempId,         // client-side uuid used to attach face uploads
 *        name,
 *        relation,       // 'parent' | 'driver' | 'nanny' | 'emergency' | 'other'
 *        phone, idNumber?, email?,
 *        authorizedStudentIds: [...],   // subset of students[].id
 *        facePaths: [storage paths from /face]
 *     }],
 *     consentSignature   // typed name = guardianName
 *   }
 *
 * Returns: { ok, recordId }
 */
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';
import crypto from 'crypto';

const tenancy = require('../../../../lib/tenancy');
const { verifyPickupOnboardingToken } = require('../../../../lib/pickup-token');

const ALLOWED_RELATIONS = new Set(['parent', 'mother', 'father', 'guardian',
  'driver', 'nanny', 'grandparent', 'sibling', 'emergency', 'other']);

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || null;
}

function sanitizeChaperone(c, validStudentIds) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim();
  const phone = String(c.phone || '').trim();
  const relation = String(c.relation || 'other').trim().toLowerCase();
  if (!name || name.length < 2 || name.length > 80) return null;
  if (!phone || phone.length > 24) return null;
  if (!ALLOWED_RELATIONS.has(relation)) return null;
  const auth = Array.isArray(c.authorizedStudentIds)
    ? c.authorizedStudentIds.filter((s) => validStudentIds.has(String(s)))
    : [];
  if (auth.length === 0) return null;
  const facePaths = Array.isArray(c.facePaths)
    ? c.facePaths.filter((p) => typeof p === 'string' && p.startsWith('tenants/')).slice(0, 8)
    : [];
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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
  if (students.length === 0 || students.length > 10) {
    return res.status(400).json({ error: 'students: 1–10 required' });
  }
  if (chaperones.length === 0 || chaperones.length > 10) {
    return res.status(400).json({ error: 'chaperones: 1–10 required' });
  }

  const validStudentIds = new Set(
    students.map((s) => String(s && s.id || '').trim()).filter(Boolean),
  );
  // If token was scoped to a single student, that one must be present
  if (claims.sid && !validStudentIds.has(String(claims.sid))) {
    return res.status(400).json({ error: 'token-bound student must be in submission' });
  }

  const cleanStudents = students.map((s) => ({
    id: String(s.id || '').trim(),
    name: String(s.name || '').trim().slice(0, 120),
    homeroom: s.homeroom ? String(s.homeroom).trim().slice(0, 32) : null,
  })).filter((s) => s.id);

  const cleanChaperones = chaperones
    .map((c) => sanitizeChaperone(c, validStudentIds))
    .filter(Boolean);
  if (cleanChaperones.length === 0) {
    return res.status(400).json({ error: 'at least one valid chaperone required' });
  }
  if (cleanChaperones.some((c) => c.facePaths.length < 1)) {
    return res.status(400).json({ error: 'every chaperone needs at least 1 face photo' });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const recordId = crypto.randomBytes(12).toString('hex');
    const ref = db.doc(`${tenancy.pickupOnboardingPath(claims.tid)}/${recordId}`);
    const now = new Date().toISOString();
    await ref.set({
      tenantId: claims.tid,
      status: 'pending',
      submittedAt: now,
      submittedFromIp: clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      tokenSid: claims.sid || null,
      tokenExp: claims.exp,
      guardian: {
        name: guardianName,
        email: guardianEmail,
        phone: guardianPhone,
        signatureRef: consentSignature,
      },
      students: cleanStudents,
      chaperones: cleanChaperones,
      reviewedAt: null,
      reviewedBy: null,
      approvalNotes: null,
    });
    return res.status(200).json({ ok: true, recordId });
  } catch (err) {
    console.error('[pickup/onboarding/submit]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };
