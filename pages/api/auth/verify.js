/**
 * POST /api/auth/verify
 * Verifies Firebase ID token and checks if the user's email is authorized.
 * On first-ever call with no users in Firestore, auto-seeds the caller as owner.
 */
import { initializeFirebase, getFirestoreDB } from '../../../lib/firebase-admin';
import { withAuth } from '../../../lib/auth-middleware';
import admin from 'firebase-admin';

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { idToken } = req.body;
  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'Missing idToken' });
  }

  try {
    initializeFirebase();
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = decoded.email;

    if (!email) {
      return res.status(403).json({ error: 'No email associated with this account.', authorized: false });
    }

    const db = getFirestoreDB();
    const usersRef = db.collection('dashboard_users');

    // Check if ANY users exist — if not, auto-seed the first sign-in as owner
    const snapshot = await usersRef.limit(1).get();
    if (snapshot.empty) {
      await usersRef.doc(email.toLowerCase()).set({
        email: email.toLowerCase(),
        name: decoded.name || email.split('@')[0],
        role: 'owner',
        addedBy: 'system',
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        photoURL: decoded.picture || null,
      });
      return res.status(200).json({ authorized: true, role: 'owner', firstUser: true });
    }

    // Check if user is authorized
    const userDoc = await usersRef.doc(email.toLowerCase()).get();
    if (!userDoc.exists) {
      return res.status(403).json({
        error: `${email} is not authorized. Ask an admin to add your email.`,
        authorized: false,
      });
    }

    const userData = userDoc.data();
    if (userData.disabled) {
      return res.status(403).json({ error: 'Your account has been disabled.', authorized: false });
    }

    // Update last login
    await usersRef.doc(email.toLowerCase()).update({
      lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      photoURL: decoded.picture || userData.photoURL || null,
      name: decoded.name || userData.name,
    });

    return res.status(200).json({ authorized: true, role: userData.role || 'viewer' });
  } catch (err) {
    console.error('[AUTH VERIFY]', err.message);
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.', authorized: false });
    }
    return res.status(500).json({ error: 'Authentication failed.', authorized: false });
  }
}

export default withAuth(handler, { public: true, methods: ['POST'] });
