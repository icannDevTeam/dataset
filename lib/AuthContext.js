/**
 * Auth Context — manages dashboard authentication state.
 * Email/password auth with server-side authorization check.
 * Logs access events on successful sign-in.
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { auth, onAuthStateChanged, signInWithEmail, signOut as fbSignOut } from '../lib/firebase-client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authorized, setAuthorized] = useState(false);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const verifyUser = useCallback(async (firebaseUser) => {
    if (!firebaseUser) {
      setUser(null);
      setAuthorized(false);
      setRole(null);
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
        setError(data.error || 'Your email is not authorized to access this dashboard.');
        await fbSignOut();
      }
    } catch {
      setUser(null);
      setAuthorized(false);
      setRole(null);
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

  const signOut = useCallback(async () => {
    await fbSignOut();
    setUser(null);
    setAuthorized(false);
    setRole(null);
    setError(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, authorized, role, loading, error, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
