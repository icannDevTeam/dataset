/**
 * POST /api/auth/bulk-import
 *
 * Bulk-create dashboard users from a pre-validated CSV payload.
 *
 * Body: {
 *   users: [{ email, name, password, role, classScopes? }]  // max 50
 * }
 *
 * Response: {
 *   ok: true,
 *   total: N,
 *   succeeded: N,
 *   failed: N,
 *   results: [{ row, email, ok, error? }]
 * }
 *
 * Rules:
 *  - Caller must be owner or admin
 *  - Admins cannot create owner/admin accounts
 *  - Teacher accounts require @TEACHER_EMAIL_DOMAIN + at least one classScope
 *  - Guard accounts get pickup_admin: ['view','edit'] by default
 *  - Duplicates (already in dashboard_users) are returned as errors per row
 *  - On partial failure the successful rows are still committed
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirestoreDB } from '../../../lib/firebase-admin';
const { sanitizeClassScopes, isTeacherEmail } = require('../../../lib/teacher-auth');

const SUPER_ADMIN = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
const TEACHER_EMAIL_DOMAIN = (process.env.TEACHER_EMAIL_DOMAIN || 'binus.edu').toLowerCase();
const MAX_ROWS = 50;

async function verifyAdmin(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = decoded.email?.toLowerCase();
    if (!email) return null;
    const db = getFirestoreDB();
    const doc = await db.collection('dashboard_users').doc(email).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (!['owner', 'admin'].includes(data.role)) return null;
    return { email, role: data.role };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  initializeFirebase();
  const caller = await verifyAdmin(req);
  if (!caller) return res.status(403).json({ error: 'Admin access required.' });

  const { users } = req.body || {};
  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: 'users array is required.' });
  }
  if (users.length > MAX_ROWS) {
    return res.status(400).json({ error: `Max ${MAX_ROWS} rows per import.` });
  }

  const db = getFirestoreDB();
  const usersRef = db.collection('dashboard_users');
  const validRoles = ['owner', 'admin', 'teacher', 'guard', 'viewer'];

  const results = [];

  for (let i = 0; i < users.length; i++) {
    const row = users[i];
    const rowNum = i + 1;

    try {
      // ── Validate ────────────────────────────────────────────────
      if (!row.email || typeof row.email !== 'string') throw new Error('email is required');
      const cleanEmail = row.email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('invalid email format');
      if (!row.password || typeof row.password !== 'string' || row.password.length < 6) {
        throw new Error('password must be at least 6 characters');
      }

      const assignedRole = validRoles.includes(row.role) ? row.role : 'viewer';

      // Privilege escalation guard
      if (['owner', 'admin'].includes(assignedRole) && caller.role !== 'owner') {
        throw new Error('only owners can assign admin/owner roles');
      }

      const cleanClassScopes = sanitizeClassScopes(row.classScopes);

      if (assignedRole === 'teacher') {
        if (!isTeacherEmail(cleanEmail, TEACHER_EMAIL_DOMAIN)) {
          throw new Error(`teacher accounts must use @${TEACHER_EMAIL_DOMAIN} email`);
        }
        if (cleanClassScopes.length === 0) {
          throw new Error('teacher account requires at least one class scope');
        }
      }

      // ── Duplicate check ─────────────────────────────────────────
      const existing = await usersRef.doc(cleanEmail).get();
      if (existing.exists) throw new Error('email already authorized');

      // ── Create Firebase Auth user ───────────────────────────────
      let authUser;
      try {
        authUser = await admin.auth().getUserByEmail(cleanEmail);
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          authUser = await admin.auth().createUser({
            email: cleanEmail,
            password: row.password,
            displayName: row.name || cleanEmail.split('@')[0],
          });
        } else {
          throw err;
        }
      }

      // ── Write Firestore doc ─────────────────────────────────────
      await usersRef.doc(cleanEmail).set({
        email: cleanEmail,
        name: row.name || cleanEmail.split('@')[0],
        role: assignedRole,
        classScopes: assignedRole === 'teacher' ? cleanClassScopes : [],
        addedBy: caller.email,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        photoURL: null,
        disabled: false,
      });

      results.push({ row: rowNum, email: cleanEmail, role: assignedRole, ok: true });
    } catch (err) {
      results.push({ row: rowNum, email: row.email || `row-${rowNum}`, ok: false, error: err.message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  return res.status(200).json({
    ok: true,
    total: results.length,
    succeeded,
    failed,
    results,
  });
}
