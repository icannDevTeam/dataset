/**
 * POST /api/auth/verify
 * Verifies Firebase ID token and checks if the user's email is authorized.
 * SUPER_ADMIN_EMAIL always gets owner access and cannot be removed.
 * On first-ever call with no users, auto-seeds the super admin as owner.
 */
import { initializeFirebase, getFirestoreDB } from '../../../lib/firebase-admin';
import { withAuth } from '../../../lib/auth-middleware';
import { resolvePermissions } from '../../../lib/permissions';
import admin from 'firebase-admin';

const SUPER_ADMIN = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();

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

    const cleanEmail = email.toLowerCase();
    const db = getFirestoreDB();
    const usersRef = db.collection('dashboard_users');

    // Super admin always gets owner access — auto-create if missing
    if (SUPER_ADMIN && cleanEmail === SUPER_ADMIN) {
      const superDoc = await usersRef.doc(cleanEmail).get();
      if (!superDoc.exists) {
        await usersRef.doc(cleanEmail).set({
          email: cleanEmail,
          name: decoded.name || cleanEmail.split('@')[0],
          role: 'owner',
          addedBy: 'system',
          addedAt: admin.firestore.FieldValue.serverTimestamp(),
          photoURL: decoded.picture || null,
          superAdmin: true,
        });
      } else {
        // Ensure super admin always stays owner
        await usersRef.doc(cleanEmail).update({
          role: 'owner',
          superAdmin: true,
          lastLogin: admin.firestore.FieldValue.serverTimestamp(),
          photoURL: decoded.picture || superDoc.data().photoURL || null,
          name: decoded.name || superDoc.data().name,
        });
      }
      return res.status(200).json({ authorized: true, role: 'owner', permissions: resolvePermissions('owner') });
    }

    // Check if ANY users exist — if not, seed super admin first
    // Security: only seeds if SUPER_ADMIN env var is configured and the
    // signing-in user IS the super admin (prevents unauthorized seeding)
    const snapshot = await usersRef.limit(1).get();
    if (snapshot.empty && SUPER_ADMIN) {
      // Only the super admin can trigger initial seeding
      if (cleanEmail !== SUPER_ADMIN) {
        return res.status(403).json({
          error: `System not initialized. The super admin must sign in first.`,
          authorized: false,
        });
      }
      await usersRef.doc(SUPER_ADMIN).set({
        email: SUPER_ADMIN,
        name: decoded.name || 'Super Admin',
        role: 'owner',
        addedBy: 'system',
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        superAdmin: true,
      });
      return res.status(200).json({ authorized: true, role: 'owner', permissions: resolvePermissions('owner') });
    }

    // Check if user is authorized
    const userDoc = await usersRef.doc(cleanEmail).get();
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
    await usersRef.doc(cleanEmail).update({
      lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      photoURL: decoded.picture || userData.photoURL || null,
      name: decoded.name || userData.name,
    });

    const userRole = userData.role || 'viewer';
    const permissions = resolvePermissions(userRole, userData.permissions || {});
    return res.status(200).json({ authorized: true, role: userRole, permissions });
  } catch (err) {
    console.error('[AUTH VERIFY]', err.message);
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.', authorized: false });
    }
    return res.status(500).json({ error: 'Authentication failed.', authorized: false });
  }
}

export default withAuth(handler, { public: true, methods: ['POST'] });
