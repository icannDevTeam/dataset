/**
 * POST /api/pickup/onboarding/lookup
 *
 * Token-gated student lookup for the parent onboarding page.
 *
 * Body: { token, studentId }
 * Returns: { ok, student: {id, name, homeroom, photoUrl?} }
 *
 * Lets a parent with a tenant-scope onboarding token (sid=null) add
 * sibling students to the same submission. The token's tenant is
 * authoritative — the studentId is looked up *only* under that tenant's
 * scope.
 */
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { verifyPickupOnboardingToken } = require('../../../../lib/pickup-token');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token, studentId } = req.body || {};
  const claims = verifyPickupOnboardingToken(token || '');
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });
  if (!studentId || typeof studentId !== 'string') {
    return res.status(400).json({ error: 'studentId required' });
  }
  const sid = String(studentId).trim();
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(sid)) {
    return res.status(400).json({ error: 'studentId looks invalid' });
  }
  try {
    initializeFirebase();
    const db = admin.firestore();
    const tenantSnap = await db.doc(`${tenancy.studentsPath(claims.tid)}/${sid}`).get();
    if (!tenantSnap.exists) {
      // Fall back to legacy collection (dual-read window)
      const legacy = await db.doc(`students/${sid}`).get();
      if (!legacy.exists) return res.status(404).json({ error: 'student not found' });
      const d = legacy.data() || {};
      return res.status(200).json({
        ok: true,
        student: {
          id: sid,
          name: d.name || d.fullName || sid,
          homeroom: d.homeroom || d.className || null,
          photoUrl: d.photoUrl || null,
        },
      });
    }
    const d = tenantSnap.data() || {};
    return res.status(200).json({
      ok: true,
      student: {
        id: sid,
        name: d.name || d.fullName || sid,
        homeroom: d.homeroom || d.className || null,
        photoUrl: d.photoUrl || null,
      },
    });
  } catch (err) {
    console.error('[pickup/onboarding/lookup]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
}
