/**
 * POST /api/auth/setup
 * One-time setup: creates the super admin Firebase Auth user + dashboard_users doc.
 * Only works when no dashboard_users exist yet AND email matches SUPER_ADMIN_EMAIL.
 */
import { initializeFirebase, getFirestoreDB } from '../../../lib/firebase-admin';
import { withAuth } from '../../../lib/auth-middleware';
import admin from 'firebase-admin';

const SUPER_ADMIN = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
const SUPER_ADMIN_PASS = process.env.SUPER_ADMIN_PASSWORD || '';

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  const cleanEmail = email.toLowerCase().trim();

  // Only the super admin can be auto-seeded
  if (!SUPER_ADMIN || cleanEmail !== SUPER_ADMIN) {
    return res.status(403).json({ error: 'Invalid credentials.' });
  }

  // Verify the password matches the server-side secret
  if (password !== SUPER_ADMIN_PASS) {
    return res.status(403).json({ error: 'Invalid credentials.' });
  }

  try {
    initializeFirebase();
    const db = getFirestoreDB();

    // Check if users already exist — if so, don't re-seed
    const usersRef = db.collection('dashboard_users');
    const existing = await usersRef.doc(cleanEmail).get();

    // Create Firebase Auth user if it doesn't exist
    let authUser;
    try {
      authUser = await admin.auth().getUserByEmail(cleanEmail);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        authUser = await admin.auth().createUser({
          email: cleanEmail,
          password: password,
          displayName: 'Super Admin',
        });
      } else {
        throw err;
      }
    }

    // Seed dashboard_users doc if not present
    if (!existing.exists) {
      await usersRef.doc(cleanEmail).set({
        email: cleanEmail,
        name: 'Super Admin',
        role: 'owner',
        addedBy: 'system',
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        superAdmin: true,
        photoURL: null,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[AUTH SETUP]', err.message);
    return res.status(500).json({ error: 'Setup failed. Please try again.' });
  }
}

export default withAuth(handler, { public: true, methods: ['POST'] });
