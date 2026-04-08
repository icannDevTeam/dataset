/**
 * Auth Context — manages dashboard authentication state.
 * Email/password auth with server-side authorization check.
 * Logs access events on successful sign-in.
 * Includes session timeout — auto-logout after inactivity.
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { auth, onAuthStateChanged, signInWithEmail, signOut as fbSignOut } from '../lib/firebase-client';
import { hasPermission } from '../lib/permissions';

const AuthContext = createContext(null);

// Session timeout: 30 minutes of inactivity
const SESSION_TIMEOUT = 30 * 60 * 1000;
// Warning shown 2 minutes before timeout
const WARNING_BEFORE = 2 * 60 * 1000;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authorized, setAuthorized] = useState(false);
  const [role, setRole] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sessionWarning, setSessionWarning] = useState(false);

  const timeoutRef = useRef(null);
  const warningRef = useRef(null);
  const lastActivityRef = useRef(Date.now());

  const verifyUser = useCallback(async (firebaseUser) => {
    if (!firebaseUser) {
      setUser(null);
      setAuthorized(false);
      setRole(null);
      setPermissions(null);
      setLoading(false);
      return;
    }

    try {
      const idToken = await firebaseUser.getIdToken();
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });

      const data = await res.json();

      if (res.ok && data.authorized) {
        setUser(firebaseUser);
        setAuthorized(true);
        setRole(data.role || 'viewer');
        setPermissions(data.permissions || null);
        setError(null);

        // Set session cookie for Edge Middleware
        fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        }).catch(() => {});

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
        setError(data.error || 'Your email is not authorized to access this dashboard.');
        await fbSignOut();
      }
    } catch {
      setUser(null);
      setAuthorized(false);
      setRole(null);
      setPermissions(null);
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
      // Try signing in — if user doesn't exist, call setup to seed
      let firebaseUser;
      try {
        firebaseUser = await signInWithEmail(email, password);
      } catch (err) {
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
          // Attempt auto-setup for super admin
          const setupRes = await fetch('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (setupRes.ok) {
            firebaseUser = await signInWithEmail(email, password);
          } else {
            const data = await setupRes.json();
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

  const signOut = useCallback(async (reason) => {
    clearTimeout(timeoutRef.current);
    clearTimeout(warningRef.current);
    setSessionWarning(false);
    await fbSignOut();
    setUser(null);
    setAuthorized(false);
    setRole(null);
    setPermissions(null);
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
    <AuthContext.Provider value={{ user, authorized, role, permissions, loading, error, signIn, signOut, sessionWarning, extendSession, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
