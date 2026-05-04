/**
 * Custom Firebase Auth claims management — Phase A4.
 *
 * Sets `tenantId` and `role` claims on a user so Firestore rules can scope
 * access. Idempotent: re-applies on every role/tenant change.
 *
 * The user must sign in again (or refresh their ID token) for new claims
 * to take effect — clients should call `user.getIdToken(true)` after a
 * role change is reported.
 *
 * Usage (server-side only, requires Firebase Admin):
 *   import { setUserTenantClaims } from '../../lib/tenant-claims';
 *   await setUserTenantClaims({ email: 'a@b.com', tenantId: 'binus-simprug', role: 'admin' });
 */
import admin from 'firebase-admin';
import { initializeFirebase } from './firebase-admin';
import { getTenantId } from './tenancy';

/**
 * Apply tenantId + role custom claims to a user (by email or uid).
 * Returns the updated claims object.
 */
export async function setUserTenantClaims({ uid, email, tenantId, role }) {
  initializeFirebase();
  if (!uid && !email) throw new Error('setUserTenantClaims requires uid or email');
  if (!role) throw new Error('setUserTenantClaims requires role');

  const tid = getTenantId(tenantId);
  const validRoles = ['owner', 'admin', 'viewer'];
  if (!validRoles.includes(role)) {
    throw new Error(`role must be one of ${validRoles.join(', ')}`);
  }

  let userRecord;
  if (uid) {
    userRecord = await admin.auth().getUser(uid);
  } else {
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // Create a passwordless user record so claims can be attached
        userRecord = await admin.auth().createUser({ email });
      } else {
        throw e;
      }
    }
  }

  const existingClaims = userRecord.customClaims || {};
  const newClaims = { ...existingClaims, tenantId: tid, role };
  await admin.auth().setCustomUserClaims(userRecord.uid, newClaims);
  return { uid: userRecord.uid, claims: newClaims };
}

/**
 * Remove a user from a tenant (clears claims). Does NOT delete the user.
 */
export async function clearUserTenantClaims({ uid, email }) {
  initializeFirebase();
  if (!uid && !email) throw new Error('clearUserTenantClaims requires uid or email');
  const userRecord = uid
    ? await admin.auth().getUser(uid)
    : await admin.auth().getUserByEmail(email);
  const existing = userRecord.customClaims || {};
  const { tenantId: _t, role: _r, ...rest } = existing;
  await admin.auth().setCustomUserClaims(userRecord.uid, rest);
  return { uid: userRecord.uid, claims: rest };
}

/**
 * Read tenantId + role claims from a verified ID token (server-side).
 * Returns { tenantId, role } or { tenantId: null, role: null } if absent.
 */
export function readTenantClaims(decodedToken) {
  if (!decodedToken) return { tenantId: null, role: null };
  return {
    tenantId: decodedToken.tenantId || null,
    role: decodedToken.role || null,
  };
}

/**
 * Verify a Firebase ID token and assert the caller belongs to a given tenant.
 * Throws on mismatch. Returns the decoded token augmented with tenantId/role.
 *
 * Usage in API routes:
 *   const decoded = await assertTenantAccess(req, { requireTenant: 'binus-simprug', requireRole: 'admin' });
 */
export async function assertTenantAccess(req, { requireTenant, requireRole } = {}) {
  initializeFirebase();
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    const err = new Error('Missing Authorization: Bearer <idToken>');
    err.statusCode = 401;
    throw err;
  }
  const decoded = await admin.auth().verifyIdToken(idToken);
  const { tenantId, role } = readTenantClaims(decoded);

  if (requireTenant && tenantId !== requireTenant) {
    const err = new Error(`Tenant mismatch: token=${tenantId} required=${requireTenant}`);
    err.statusCode = 403;
    throw err;
  }

  if (requireRole) {
    const required = Array.isArray(requireRole) ? requireRole : [requireRole];
    if (!required.includes(role)) {
      const err = new Error(`Role '${role}' not in [${required.join(',')}]`);
      err.statusCode = 403;
      throw err;
    }
  }

  return { ...decoded, tenantId, role };
}
