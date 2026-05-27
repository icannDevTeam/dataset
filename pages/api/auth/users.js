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
const { sanitizeClassScopes, isTeacherEmail } = require('../../../lib/teacher-auth');
const { logAudit } = require('../../../lib/audit-log');
const { invalidateUser } = require('../../../lib/api-auth');
const { generateOtp } = require('../../../lib/otp');
const { sendEmail } = require('../../../lib/email');
const { renderInviteEmail } = require('../../../lib/email-templates');

const SUPER_ADMIN = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
const TEACHER_EMAIL_DOMAIN = (process.env.TEACHER_EMAIL_DOMAIN || 'binus.edu').toLowerCase();

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
    const userRef = db.collection('dashboard_users').doc(email);
    const userDoc = await userRef.get();

    // ── Bootstrap: if no owner exists yet, the very first authenticated
    // caller is auto-promoted. Idempotent — no-op once any owner is present.
    if (SUPER_ADMIN && email === SUPER_ADMIN) {
      // Super admin (env-configured) is always allowed and self-heals their doc.
      if (!userDoc.exists || userDoc.data()?.role !== 'owner') {
        await userRef.set({
          email,
          name: decoded.name || userDoc.data()?.name || '',
          role: 'owner',
          superAdmin: true,
          bootstrap: !userDoc.exists,
          addedAt: userDoc.exists ? (userDoc.data()?.addedAt || admin.firestore.FieldValue.serverTimestamp())
                                  : admin.firestore.FieldValue.serverTimestamp(),
          promotedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        try {
          await logAudit(db, {
            actor: { email },
            kind: 'auth.bootstrap_owner',
            target: { type: 'user', id: email, label: email },
            summary: `Super admin auto-promoted to owner via env SUPER_ADMIN_EMAIL`,
            req,
          });
        } catch {}
        invalidateUser(email);
        return { email, role: 'owner', name: decoded.name };
      }
    } else if (!userDoc.exists) {
      // No record. Promote IF the system has zero owners yet.
      const ownersSnap = await db.collection('dashboard_users').where('role', '==', 'owner').limit(1).get();
      if (ownersSnap.empty) {
        await userRef.set({
          email,
          name: decoded.name || '',
          role: 'owner',
          bootstrap: true,
          addedAt: admin.firestore.FieldValue.serverTimestamp(),
          promotedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        try {
          await logAudit(db, {
            actor: { email },
            kind: 'auth.bootstrap_owner',
            target: { type: 'user', id: email, label: email },
            summary: `First authenticated user auto-promoted to owner (bootstrap)`,
            req,
          });
        } catch {}
        invalidateUser(email);
        return { email, role: 'owner', name: decoded.name };
      }
      return null;
    }

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
          classScopes: Array.isArray(d.classScopes) ? d.classScopes : [],
          disabled: d.disabled || false,
          superAdmin: d.superAdmin || (SUPER_ADMIN && doc.id === SUPER_ADMIN) || false,
          mustChangePassword: !!d.mustChangePassword,
          lastOtpIssuedAt: d.lastOtpIssuedAt?.toDate?.()?.toISOString() || null,
          lastOtpIssuedBy: d.lastOtpIssuedBy || null,
        };
      });
      return res.status(200).json({ users });
    } catch (err) {
      console.error('[USERS GET]', err.message);
      return res.status(500).json({ error: 'Failed to fetch users' });
    }
  }

  if (req.method === 'POST') {
    const { email, role, name, password, classScopes, sendInviteEmail } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email is required.' });
    }
    // Default behavior: email-invite mode unless caller explicitly opts out
    // by passing sendInviteEmail:false (used by manual-password creation).
    const wantsInvite = sendInviteEmail !== false && !password;

    if (!wantsInvite) {
      if (!password || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      }
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    const validRoles = ['owner', 'admin', 'teacher', 'guard', 'viewer'];
    const assignedRole = validRoles.includes(role) ? role : 'viewer';
    const cleanClassScopes = sanitizeClassScopes(classScopes);

    // Only owners can create other owners/admins
    if (['owner', 'admin'].includes(assignedRole) && caller.role !== 'owner') {
      return res.status(403).json({ error: 'Only owners can assign admin/owner roles.' });
    }

    // Teacher account policy
    if (assignedRole === 'teacher') {
      if (!isTeacherEmail(cleanEmail, TEACHER_EMAIL_DOMAIN)) {
        return res.status(400).json({ error: `Teacher accounts must use @${TEACHER_EMAIL_DOMAIN} email.` });
      }
      if (cleanClassScopes.length === 0) {
        return res.status(400).json({ error: 'Teacher account requires at least one class scope.' });
      }
    }

    try {
      const existing = await usersRef.doc(cleanEmail).get();
      if (existing.exists) {
        return res.status(409).json({ error: 'This email is already authorized.' });
      }

      // Mint a one-time password if we're in invite mode.
      const finalPassword = wantsInvite ? generateOtp(12) : password;

      // Create or update Firebase Auth user. Track whether we created it
      // so we can roll back cleanly if the invite email fails.
      let authUser;
      let createdAuthUser = false;
      try {
        authUser = await admin.auth().getUserByEmail(cleanEmail);
        if (wantsInvite) {
          // Existing auth account but no Firestore entry — reset its password
          // to the new OTP so the invite email is actionable. Also re-enable
          // the account in case it was previously disabled by a DELETE.
          await admin.auth().updateUser(authUser.uid, {
            password: finalPassword,
            disabled: false,
          });
        }
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          authUser = await admin.auth().createUser({
            email: cleanEmail,
            password: finalPassword,
            displayName: name || cleanEmail.split('@')[0],
          });
          createdAuthUser = true;
        } else {
          throw err;
        }
      }

      // Send the invite email FIRST. If the send fails, roll back so we
      // don't leave a brand-new account whose password no one knows.
      if (wantsInvite) {
        const loginUrl = process.env.INVITE_LOGIN_URL
          || (req.headers?.origin ? `${req.headers.origin}/login` : 'https://binus-simprug-pickup.vercel.app/login');
        const tpl = renderInviteEmail({
          name: name || cleanEmail.split('@')[0],
          email: cleanEmail,
          otp: finalPassword,
          loginUrl,
          role: assignedRole,
          invitedBy: caller.name || caller.email,
        });
        const sendResult = await sendEmail({
          to: cleanEmail,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        });
        if (!sendResult.ok) {
          // Roll back: only delete the auth user if WE created it just now.
          if (createdAuthUser) {
            try { await admin.auth().deleteUser(authUser.uid); } catch {}
          }
          console.error('[USERS POST] invite email failed:', sendResult.error);
          return res.status(502).json({
            error: 'invite_email_failed',
            message: `Could not deliver invite email: ${sendResult.error}. Account not created.`,
          });
        }
      }

      await usersRef.doc(cleanEmail).set({
        email: cleanEmail,
        name: name || cleanEmail.split('@')[0],
        role: assignedRole,
        classScopes: assignedRole === 'teacher' ? cleanClassScopes : [],
        addedBy: caller.email,
        addedAt: admin.firestore.FieldValue.serverTimestamp(),
        photoURL: null,
        disabled: false,
        // Force a password change on first login when admin used the
        // email-invite path. Manual-password mode trusts the admin.
        mustChangePassword: !!wantsInvite,
        lastOtpIssuedAt: wantsInvite ? admin.firestore.FieldValue.serverTimestamp() : null,
        lastOtpIssuedBy: wantsInvite ? caller.email : null,
      });

      await logAudit(db, {
        actor: caller, req,
        kind: 'user.invite',
        target: { type: 'user', id: cleanEmail, label: name || cleanEmail },
        after: { role: assignedRole, classScopes: assignedRole === 'teacher' ? cleanClassScopes : [], invited: !!wantsInvite },
        summary: wantsInvite
          ? `Invited ${cleanEmail} as ${assignedRole} (OTP emailed)`
          : `Invited ${cleanEmail} as ${assignedRole} (manual password)`,
      });
      return res.status(201).json({
        ok: true,
        email: cleanEmail,
        role: assignedRole,
        classScopes: assignedRole === 'teacher' ? cleanClassScopes : [],
        invited: !!wantsInvite,
      });
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

      await logAudit(db, {
        actor: caller, req,
        kind: 'user.delete',
        target: { type: 'user', id: cleanEmail, label: doc.data()?.name || cleanEmail },
        before: { role: targetRole },
        summary: `Deleted user ${cleanEmail}`,
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[USERS DELETE]', err.message);
      return res.status(500).json({ error: 'Failed to remove user' });
    }
  }

  // PATCH — Update user role, permissions, suspend, or revoke
  if (req.method === 'PATCH') {
    const { email, role: newRole, permissions: newPermissions, action: patchAction, classScopes } = req.body;
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
        update.tokenValidAfter = admin.firestore.FieldValue.serverTimestamp();
        try {
          const authUser = await admin.auth().getUserByEmail(cleanEmail);
          await admin.auth().updateUser(authUser.uid, { disabled: true });
          await admin.auth().revokeRefreshTokens(authUser.uid);
        } catch {}
        await usersRef.doc(cleanEmail).update(update);
        invalidateUser(cleanEmail);
        await logAudit(db, { actor: caller, req, kind: 'user.suspend',
          target: { type: 'user', id: cleanEmail, label: doc.data()?.name || cleanEmail },
          summary: `Suspended ${cleanEmail}` });
        return res.status(200).json({ ok: true, email: cleanEmail, disabled: true });
      }

      if (patchAction === 'unsuspend') {
        update.disabled = false;
        try {
          const authUser = await admin.auth().getUserByEmail(cleanEmail);
          await admin.auth().updateUser(authUser.uid, { disabled: false });
        } catch {}
        await usersRef.doc(cleanEmail).update(update);
        invalidateUser(cleanEmail);
        await logAudit(db, { actor: caller, req, kind: 'user.unsuspend',
          target: { type: 'user', id: cleanEmail, label: doc.data()?.name || cleanEmail },
          summary: `Re-activated ${cleanEmail}` });
        return res.status(200).json({ ok: true, email: cleanEmail, disabled: false });
      }

      // Handle password reset
      if (patchAction === 'reset-password') {
        const { newPassword } = req.body;
        if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
          return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        }
        try {
          const authUser = await admin.auth().getUserByEmail(cleanEmail);
          await admin.auth().updateUser(authUser.uid, { password: newPassword });
          await admin.auth().revokeRefreshTokens(authUser.uid);
        } catch (err) {
          return res.status(500).json({ error: 'Failed to reset password.' });
        }
        await usersRef.doc(cleanEmail).update({
          tokenValidAfter: admin.firestore.FieldValue.serverTimestamp(),
        });
        invalidateUser(cleanEmail);
        return res.status(200).json({ ok: true, email: cleanEmail });
      }

      // Handle revoke — strip all custom permissions, reset to viewer
      if (patchAction === 'revoke') {
        await usersRef.doc(cleanEmail).update({
          role: 'viewer',
          permissions: {},
          classScopes: [],
          tokenValidAfter: admin.firestore.FieldValue.serverTimestamp(),
        });
        invalidateUser(cleanEmail);
        await logAudit(db, { actor: caller, req, kind: 'user.revoke',
          target: { type: 'user', id: cleanEmail, label: doc.data()?.name || cleanEmail },
          before: { role: doc.data()?.role, classScopes: doc.data()?.classScopes || [] },
          after: { role: 'viewer', classScopes: [] },
          summary: `Reset ${cleanEmail} to viewer (revoked all permissions)` });
        return res.status(200).json({ ok: true, email: cleanEmail, role: 'viewer', permissions: resolvePermissions('viewer') });
      }

      if (newRole && ['owner', 'admin', 'teacher', 'viewer'].includes(newRole)) {
        update.role = newRole;
      }
      if (newPermissions && typeof newPermissions === 'object') {
        update.permissions = newPermissions;
      }

      // ── Owner-only enforcement for sensitive_user_access (M0 Track D) ──
      // Granting or revoking any sensitive_user_access.* action is an
      // OWNER-ONLY capability. Block here BEFORE the update is committed.
      const beforeSensitive = doc.data().permissions?.sensitive_user_access || {};
      const afterSensitive  = update.permissions?.sensitive_user_access || null;
      const sensitiveDiff = [];
      if (afterSensitive && typeof afterSensitive === 'object') {
        const SENSITIVE_ACTIONS = ['view_rbac', 'edit_rbac', 'reset_user_password', 'view_user_directory', 'manage_custom_claims'];
        SENSITIVE_ACTIONS.forEach((a) => {
          const wasGranted = !!beforeSensitive[a];
          const nowGranted = !!afterSensitive[a];
          if (wasGranted !== nowGranted) sensitiveDiff.push({ action: a, before: wasGranted, after: nowGranted });
        });
      }
      if (sensitiveDiff.length > 0 && (caller.role || '').toLowerCase() !== 'owner' && !caller.superAdmin) {
        return res.status(403).json({ error: 'Only Owners can grant or revoke sensitive_user_access permissions.' });
      }

      if (classScopes !== undefined) {
        update.classScopes = sanitizeClassScopes(classScopes);
      }

      const effectiveRole = update.role || doc.data().role || 'viewer';
      const effectiveEmail = cleanEmail;
      const effectiveClassScopes = update.classScopes !== undefined
        ? update.classScopes
        : (Array.isArray(doc.data().classScopes) ? doc.data().classScopes : []);

      if (effectiveRole === 'teacher') {
        if (!isTeacherEmail(effectiveEmail, TEACHER_EMAIL_DOMAIN)) {
          return res.status(400).json({ error: `Teacher accounts must use @${TEACHER_EMAIL_DOMAIN} email.` });
        }
        if (!effectiveClassScopes || effectiveClassScopes.length === 0) {
          return res.status(400).json({ error: 'Teacher account requires at least one class scope.' });
        }
      } else if (update.classScopes === undefined) {
        // Ensure non-teacher users don't keep stale class scopes when role changes away from teacher
        if (update.role && update.role !== 'teacher') {
          update.classScopes = [];
        }
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }

      const beforeData = doc.data() || {};
      // Any role / permission / class-scope change must invalidate active
      // sessions for that user so the new policy is enforced immediately.
      const sensitiveChange = update.role !== undefined
        || update.permissions !== undefined
        || update.classScopes !== undefined;
      if (sensitiveChange) {
        update.tokenValidAfter = admin.firestore.FieldValue.serverTimestamp();
      }
      await usersRef.doc(cleanEmail).update(update);
      if (sensitiveChange) invalidateUser(cleanEmail);

      const updatedRole = update.role || doc.data().role || 'viewer';
      const updatedOverrides = update.permissions !== undefined ? update.permissions : (doc.data().permissions || {});
      const resolved = resolvePermissions(updatedRole, updatedOverrides);

      // Audit: role change vs. permission edit
      const isRoleChange = update.role && update.role !== beforeData.role;
      await logAudit(db, {
        actor: caller, req,
        kind: isRoleChange ? 'user.role_change' : 'user.permissions',
        target: { type: 'user', id: cleanEmail, label: beforeData.name || cleanEmail },
        before: {
          role: beforeData.role,
          permissions: beforeData.permissions || {},
          classScopes: beforeData.classScopes || [],
        },
        after: {
          role: updatedRole,
          permissions: update.permissions !== undefined ? update.permissions : (beforeData.permissions || {}),
          classScopes: update.classScopes !== undefined ? update.classScopes : (beforeData.classScopes || []),
        },
        summary: isRoleChange
          ? `Changed ${cleanEmail} role: ${beforeData.role} → ${updatedRole}`
          : `Updated permissions for ${cleanEmail}`,
      });

      // High-severity audit: emit one rbac.sensitive_grant per changed
      // sensitive_user_access action so SIEM/alerting can fire on each.
      if (sensitiveDiff.length > 0) {
        for (const diff of sensitiveDiff) {
          try {
            await logAudit(db, {
              actor: caller, req,
              kind: 'rbac.sensitive_grant',
              target: { type: 'user', id: cleanEmail, label: beforeData.name || cleanEmail },
              before: { granted: diff.before },
              after: { granted: diff.after },
              summary: `${diff.after ? 'Granted' : 'Revoked'} sensitive_user_access.${diff.action} for ${cleanEmail}`,
              metadata: { feature: 'sensitive_user_access', action: diff.action, severity: 'high' },
            });
          } catch (auditErr) {
            console.error('[USERS PATCH] sensitive audit log failed', auditErr?.message);
          }
        }
      }
      const updatedClassScopes = update.classScopes !== undefined
        ? update.classScopes
        : (Array.isArray(doc.data().classScopes) ? doc.data().classScopes : []);

      return res.status(200).json({ ok: true, email: cleanEmail, role: updatedRole, permissions: resolved, classScopes: updatedClassScopes });
    } catch (err) {
      console.error('[USERS PATCH]', err.message);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAuth(handler);
