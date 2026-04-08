/**
 * /api/auth/users — Manage authorized dashboard users
 * 
 * GET    - List all authorized users
 * POST   - Add a new authorized email { email, role, name }
 * DELETE - Remove an authorized email { email }
 * 
 * All operations require a valid Firebase ID token from an owner/admin user.
 */
import { initializeFirebase, getFirestoreDB } from '../../../lib/firebase-admin';
import { withAuth } from '../../../lib/auth-middleware';
import { resolvePermissions } from '../../../lib/permissions';
import admin from 'firebase-admin';

const SUPER_ADMIN = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();

async function verifyAdmin(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const idToken = authHeader.slice(7);
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = decoded.email?.toLowerCase();
    if (!email) return null;

    const db = getFirestoreDB();
    const userDoc = await db.collection('dashboard_users').doc(email).get();
    if (!userDoc.exists) return null;

    const userData = userDoc.data();
    if (!['owner', 'admin'].includes(userData.role)) return null;

    return { email, role: userData.role, name: decoded.name };
  } catch {
    return null;
  }
}

async function handler(req, res) {
  initializeFirebase();
  const db = getFirestoreDB();

  const caller = await verifyAdmin(req);
  if (!caller) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const usersRef = db.collection('dashboard_users');

  if (req.method === 'GET') {
    try {
      const snapshot = await usersRef.orderBy('addedAt', 'desc').get();

      // Fetch last access log per user for IP info
      const ipMap = {};
      try {
        const logsSnap = await db.collection('access_logs').orderBy('timestamp', 'desc').limit(200).get();
        for (const doc of logsSnap.docs) {
          const d = doc.data();
          if (d.email && !ipMap[d.email]) {
            ipMap[d.email] = d.ip || null;
          }
        }
      } catch {}

      const users = snapshot.docs.map((doc) => {
        const d = doc.data();
        const userRole = d.role || 'viewer';
        return {
          email: doc.id,
          name: d.name || '',
          role: userRole,
          permissions: resolvePermissions(userRole, d.permissions || {}),
          customPermissions: d.permissions || {},
          photoURL: d.photoURL || null,
          addedBy: d.addedBy || 'unknown',
          addedAt: d.addedAt?.toDate?.()?.toISOString() || null,
          lastLogin: d.lastLogin?.toDate?.()?.toISOString() || null,
          lastIP: ipMap[doc.id] || null,
          disabled: d.disabled || false,
          superAdmin: d.superAdmin || (SUPER_ADMIN && doc.id === SUPER_ADMIN) || false,
        };
      });
      return res.status(200).json({ users });
    } catch (err) {
      console.error('[USERS GET]', err.message);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }
  }

  if (req.method === 'POST') {
    const { email, role, name, password } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    const validRoles = ['owner', 'admin', 'viewer'];
    const assignedRole = validRoles.includes(role) ? role : 'viewer';

    // Only owners can create other owners/admins
    if (['owner', 'admin'].includes(assignedRole) && caller.role !== 'owner') {
      return res.status(403).json({ error: 'Only owners can assign admin/owner roles.' });
    }

    try {
      const existing = await usersRef.doc(cleanEmail).get();
      if (existing.exists) {
        return res.status(409).json({ error: 'This email is already authorized.' });
      }

      // Create Firebase Auth user
      let authUser;
      try {
        authUser = await admin.auth().getUserByEmail(cleanEmail);
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          authUser = await admin.auth().createUser({
            email: cleanEmail,
            password: password,
            displayName: name || cleanEmail.split('@')[0],
          });
        } else {
          throw err;
        }
      }

      await usersRef.doc(cleanEmail).set({
        email: cleanEmail,
        name: name || cleanEmail.split('@')[0],
        role: assignedRole,
        addedBy: caller.email,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        photoURL: null,
        disabled: false,
      });

      return res.status(201).json({ ok: true, email: cleanEmail, role: assignedRole });
    } catch (err) {
      console.error('[USERS POST]', err.message);
      return res.status(500).json({ error: 'Failed to add user' });
    }
  }

  if (req.method === 'DELETE') {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Can't remove yourself
    if (cleanEmail === caller.email) {
      return res.status(400).json({ error: 'You cannot remove yourself.' });
    }

    // Can't remove the super admin
    if (SUPER_ADMIN && cleanEmail === SUPER_ADMIN) {
      return res.status(403).json({ error: 'The super admin cannot be removed.' });
    }

    try {
      const doc = await usersRef.doc(cleanEmail).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'User not found.' });
      }

      // Only owners can remove admins/owners
      const targetRole = doc.data().role;
      if (['owner', 'admin'].includes(targetRole) && caller.role !== 'owner') {
        return res.status(403).json({ error: 'Only owners can remove admin/owner users.' });
      }

      await usersRef.doc(cleanEmail).delete();

      // Disable Firebase Auth user so they can't sign in again
      try {
        const authUser = await admin.auth().getUserByEmail(cleanEmail);
        await admin.auth().updateUser(authUser.uid, { disabled: true });
      } catch {}

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[USERS DELETE]', err.message);
      return res.status(500).json({ error: 'Failed to remove user' });
    }
  }

  // PATCH — Update user role, permissions, suspend, or revoke
  if (req.method === 'PATCH') {
    const { email, role: newRole, permissions: newPermissions, action: patchAction } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Can't modify the super admin (they always have full owner perms)
    if (SUPER_ADMIN && cleanEmail === SUPER_ADMIN) {
      return res.status(403).json({ error: 'Super admin permissions cannot be modified.' });
    }

    // Owners can edit anyone; admins can only edit viewers
    if (caller.role !== 'owner') {
      const doc = await usersRef.doc(cleanEmail).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'User not found.' });
      }
      const targetRole = doc.data().role;
      if (caller.role !== 'admin' || targetRole !== 'viewer') {
        return res.status(403).json({ error: 'You can only update viewer permissions.' });
      }
    }

    try {
      const doc = await usersRef.doc(cleanEmail).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'User not found.' });
      }

      const update = {};

      // Handle suspend / unsuspend
      if (patchAction === 'suspend') {
        update.disabled = true;
        try {
          const authUser = await admin.auth().getUserByEmail(cleanEmail);
          await admin.auth().updateUser(authUser.uid, { disabled: true });
        } catch {}
        await usersRef.doc(cleanEmail).update(update);
        return res.status(200).json({ ok: true, email: cleanEmail, disabled: true });
      }

      if (patchAction === 'unsuspend') {
        update.disabled = false;
        try {
          const authUser = await admin.auth().getUserByEmail(cleanEmail);
          await admin.auth().updateUser(authUser.uid, { disabled: false });
        } catch {}
        await usersRef.doc(cleanEmail).update(update);
        return res.status(200).json({ ok: true, email: cleanEmail, disabled: false });
      }

      // Handle revoke — strip all custom permissions, reset to viewer
      if (patchAction === 'revoke') {
        await usersRef.doc(cleanEmail).update({ role: 'viewer', permissions: {} });
        return res.status(200).json({ ok: true, email: cleanEmail, role: 'viewer', permissions: resolvePermissions('viewer') });
      }

      if (newRole && ['owner', 'admin', 'viewer'].includes(newRole)) {
        update.role = newRole;
      }
      if (newPermissions && typeof newPermissions === 'object') {
        update.permissions = newPermissions;
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      await usersRef.doc(cleanEmail).update(update);

      const updatedRole = update.role || doc.data().role || 'viewer';
      const updatedOverrides = update.permissions !== undefined ? update.permissions : (doc.data().permissions || {});
      const resolved = resolvePermissions(updatedRole, updatedOverrides);

      return res.status(200).json({ ok: true, email: cleanEmail, role: updatedRole, permissions: resolved });
    } catch (err) {
      console.error('[USERS PATCH]', err.message);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAuth(handler);
