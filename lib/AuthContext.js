/**
 * Auth Context — manages dashboard authentication state.
 * Email/password auth with server-side authorization check.
 * Logs access events on successful sign-in.
 * Includes session timeout — auto-logout after inactivity.
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  auth, onAuthStateChanged, signInWithEmail, signOut as fbSignOut,
  multiFactor, TotpMultiFactorGenerator, getMultiFactorResolver,
} from '../lib/firebase-client';
import { hasPermission } from '../lib/permissions';

const AuthContext = createContext(null);

// Session timeout: 60 minutes of inactivity
const SESSION_TIMEOUT = 60 * 60 * 1000;
// Warning shown 2 minutes before timeout
const WARNING_BEFORE = 2 * 60 * 1000;
const AUTH_HTTP_TIMEOUT_MS = 10000;

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = AUTH_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authorized, setAuthorized] = useState(false);
  const [role, setRole] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sessionWarning, setSessionWarning] = useState(false);
  // Set when signIn() hits `auth/multi-factor-auth-required` — the login
  // page shows a TOTP code prompt while this is non-null.
  const [mfaResolver, setMfaResolver] = useState(null);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);

  const timeoutRef = useRef(null);
  const warningRef = useRef(null);
  const lastActivityRef = useRef(Date.now());

  const verifyUser = useCallback(async (firebaseUser) => {
    if (!firebaseUser) {
      setUser(null);
      setAuthorized(false);
      setRole(null);
      setPermissions(null);
      setMfaEnrolled(false);
      setLoading(false);
      return;
    }

    try {
      // Force-refresh the cached user record before reading MFA enrollment —
      // onAuthStateChanged can fire with a persisted (IndexedDB) snapshot
      // that predates a factor enrolled earlier in the same browser.
      try { await firebaseUser.reload(); } catch {}
      const idToken = await firebaseUser.getIdToken();
      const { res, data } = await fetchJsonWithTimeout('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });

      if (res.ok && data.authorized) {
        // Set session cookie BEFORE updating state — prevents redirect loop
        // where login.js navigates to /v2 before middleware cookie is set
        try {
          await fetchJsonWithTimeout('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken }),
          }, AUTH_HTTP_TIMEOUT_MS);
        } catch {}

        setUser(firebaseUser);
        setAuthorized(true);
        setRole(data.role || 'viewer');
        setPermissions(data.permissions || null);
        setMustChangePassword(!!data.mustChangePassword);
        setMfaEnrolled((multiFactor(firebaseUser).enrolledFactors || []).length > 0);
        setMfaResolver(null);
        setError(null);

        // Log access in background
        fetch('/api/auth/access-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        }).catch(() => {});
      } else {
        setUser(null);
        setAuthorized(false);
        setRole(null);
        setPermissions(null);
        setMfaEnrolled(false);
        setError(data.error || 'Your email is not authorized to access this dashboard.');
        await fbSignOut();
      }
    } catch {
      setUser(null);
      setAuthorized(false);
      setRole(null);
      setPermissions(null);
      setMfaEnrolled(false);
      setError('Failed to verify authorization. Please try again.');
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        verifyUser(firebaseUser);
      } else {
        setUser(null);
        setAuthorized(false);
        setRole(null);
        setPermissions(null);
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, [verifyUser]);

  const signIn = useCallback(async (email, password) => {
    setLoading(true);
    setError(null);
    try {
      const cleanEmail = String(email || '').trim().toLowerCase();
      // Try signing in — if user doesn't exist, call setup to seed
      let firebaseUser;
      try {
        firebaseUser = await signInWithEmail(cleanEmail, password);
      } catch (err) {
        if (err.code === 'auth/multi-factor-auth-required') {
          // Password was correct — account has TOTP enrolled. Surface the
          // resolver so the login page can prompt for a 6-digit code.
          setMfaResolver(getMultiFactorResolver(auth, err));
          setLoading(false);
          return;
        }
        if (err.code === 'auth/user-disabled') {
          setError('This account is disabled. Please contact an administrator.');
          setLoading(false);
          return;
        }
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
          // Attempt auto-setup for super admin
          const { res: setupRes, data } = await fetchJsonWithTimeout('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: cleanEmail, password }),
          });
          if (setupRes.ok) {
            firebaseUser = await signInWithEmail(cleanEmail, password);
          } else {
            setError(data.error || 'Invalid credentials.');
            setLoading(false);
            return;
          }
        } else if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
          setError('Incorrect password.');
          setLoading(false);
          return;
        } else {
          throw err;
        }
      }
      await verifyUser(firebaseUser);
    } catch {
      setError('Sign-in failed. Please try again.');
      setLoading(false);
    }
  }, [verifyUser]);

  // Step 2 of MFA sign-in: user submits the 6-digit code from their
  // authenticator app; resolves the pending sign-in started above.
  const completeMfaSignIn = useCallback(async (code) => {
    if (!mfaResolver) return;
    setLoading(true);
    setError(null);
    try {
      const hint = mfaResolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID) || mfaResolver.hints[0];
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, String(code || '').trim());
      const cred = await mfaResolver.resolveSignIn(assertion);
      setMfaResolver(null);
      await verifyUser(cred.user);
    } catch (err) {
      console.error('[MFA resolveSignIn]', err.code, err.message);
      if (err.code === 'auth/invalid-verification-code') {
        setError('Invalid code. Please try again.');
      } else if (err.code === 'auth/totp-challenge-timeout' || err.code === 'auth/multi-factor-session-expired' || err.code === 'auth/code-expired') {
        // Resolver session died — restart the whole sign-in from scratch.
        setMfaResolver(null);
        setError('Verification session expired. Please sign in again.');
      } else {
        setError(`Verification failed (${err.code || 'unknown'}). Please try again.`);
      }
      setLoading(false);
    }
  }, [mfaResolver, verifyUser]);

  const cancelMfaSignIn = useCallback(() => {
    setMfaResolver(null);
    setError(null);
    setLoading(false);
  }, []);

  // Enrollment (Settings → Security): step 1 generates a TOTP secret tied
  // to the current signed-in user's session.
  const startTotpEnrollment = useCallback(async () => {
    if (!auth.currentUser) throw new Error('Not signed in.');
    console.log('[MFA enroll] starting for', auth.currentUser.email, auth.currentUser.uid);
    const session = await multiFactor(auth.currentUser).getSession();
    const secret = await TotpMultiFactorGenerator.generateSecret(session);
    const otpauthUrl = secret.generateQrCodeUrl(auth.currentUser.email, 'BINUS Attendance Dashboard');
    return { secret, secretKey: secret.secretKey, otpauthUrl };
  }, []);

  // Step 2: user enters the 6-digit code their authenticator app generated
  // from the secret above, finalizing enrollment.
  const confirmTotpEnrollment = useCallback(async (secret, code, displayName = 'Authenticator app') => {
    console.log('[MFA enroll] confirming for', auth.currentUser?.email, auth.currentUser?.uid);
    const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, String(code || '').trim());
    await multiFactor(auth.currentUser).enroll(assertion, displayName);
    await auth.currentUser.reload();
    const factorsAfter = multiFactor(auth.currentUser).enrolledFactors || [];
    console.log('[MFA enroll] done, enrolledFactors now:', factorsAfter.length, factorsAfter);
    setMfaEnrolled(factorsAfter.length > 0);
  }, []);

  const unenrollTotp = useCallback(async (factorUid) => {
    await multiFactor(auth.currentUser).unenroll(factorUid);
    setMfaEnrolled((multiFactor(auth.currentUser).enrolledFactors || []).length > 0);
  }, []);

  const signOut = useCallback(async (reason) => {
    clearTimeout(timeoutRef.current);
    clearTimeout(warningRef.current);
    setSessionWarning(false);
    await fbSignOut();
    setUser(null);
    setAuthorized(false);
    setRole(null);
    setPermissions(null);
    setMfaEnrolled(false);
    setMfaResolver(null);
    setError(reason === 'timeout' ? 'Session expired due to inactivity. Please sign in again.' : null);
    // Clear session cookie
    fetch('/api/auth/session', { method: 'DELETE' }).catch(() => {});
  }, []);

  // Reset inactivity timers
  const resetSessionTimer = useCallback(() => {
    if (!authorized) return;
    lastActivityRef.current = Date.now();
    setSessionWarning(false);

    clearTimeout(warningRef.current);
    clearTimeout(timeoutRef.current);

    warningRef.current = setTimeout(() => {
      setSessionWarning(true);
    }, SESSION_TIMEOUT - WARNING_BEFORE);

    timeoutRef.current = setTimeout(() => {
      signOut('timeout');
    }, SESSION_TIMEOUT);
  }, [authorized, signOut]);

  // Extend session — called from the warning toast
  const extendSession = useCallback(() => {
    resetSessionTimer();
  }, [resetSessionTimer]);

  // Activity listeners
  useEffect(() => {
    if (!authorized) return;

    resetSessionTimer();

    const onActivity = () => {
      // Only reset if last activity was >10s ago to avoid excessive timer resets
      if (Date.now() - lastActivityRef.current > 10_000) {
        resetSessionTimer();
      }
    };

    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(e => window.addEventListener(e, onActivity, { passive: true }));

    return () => {
      events.forEach(e => window.removeEventListener(e, onActivity));
      clearTimeout(timeoutRef.current);
      clearTimeout(warningRef.current);
    };
  }, [authorized, resetSessionTimer]);

  // Convenience helper: can('enrollment', 'edit')
  const can = useCallback((feature, action = 'view') => {
    return hasPermission(permissions, feature, action);
  }, [permissions]);

  return (
    <AuthContext.Provider value={{
      user, authorized, role, permissions, mustChangePassword, loading, error, signIn, signOut,
      sessionWarning, extendSession, can,
      mfaResolver, completeMfaSignIn, cancelMfaSignIn,
      mfaEnrolled, startTotpEnrollment, confirmTotpEnrollment, unenrollTotp,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
