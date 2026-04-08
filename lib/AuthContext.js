/**
 * Auth Context — manages dashboard authentication state.
 * Wraps Firebase Auth with server-side email authorization check.
 * Logs access events on successful sign-in.
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { auth, onAuthStateChanged, signInWithGoogle as fbSignIn, signOut as fbSignOut } from '../lib/firebase-client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);       // Firebase user object
  const [authorized, setAuthorized] = useState(false); // Server-verified authorization
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Verify user with server (check email is in authorized list + log access)
  const verifyUser = useCallback(async (firebaseUser) => {
    if (!firebaseUser) {
      setUser(null);
      setAuthorized(false);
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
        setError(data.error || 'Your email is not authorized to access this dashboard.');
        await fbSignOut();
      }
    } catch (err) {
      setUser(null);
      setAuthorized(false);
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
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, [verifyUser]);

  const signIn = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const firebaseUser = await fbSignIn();
      await verifyUser(firebaseUser);
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setError('Sign-in failed. Please try again.');
      }
      setLoading(false);
    }
  }, [verifyUser]);

  const signOut = useCallback(async () => {
    await fbSignOut();
    setUser(null);
    setAuthorized(false);
    setError(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, authorized, loading, error, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
