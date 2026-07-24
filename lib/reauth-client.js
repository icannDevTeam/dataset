/**
 * lib/reauth-client.js — Browser-side step-up auth.
 *
 * Verifies the user's password WITHOUT touching the primary session by
 * spinning up a secondary Firebase app instance, signing in there, grabbing
 * a fresh ID token, and signing the secondary instance back out.
 *
 * Server pairs this with `lib/reauth.js` → checks `X-Reauth-Token`.
 */
import { initializeApp, getApp, deleteApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth as primaryAuth } from './firebase-client';

const SECONDARY_APP_NAME = '__binus_reauth__';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'AIzaSyClDQe4e2NpfVw4nvLG10vzK8wmdGCHJwk',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'facial-attendance-binus.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'facial-attendance-binus',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'facial-attendance-binus.firebasestorage.app',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '866005352235',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '1:866005352235:web:90f5c63b84892bdf774f6e',
};

function getSecondaryApp() {
  try {
    return getApp(SECONDARY_APP_NAME);
  } catch {
    return initializeApp(firebaseConfig, SECONDARY_APP_NAME);
  }
}

/**
 * Prompt-driven re-auth. Returns a fresh ID token suitable for the
 * `X-Reauth-Token` header on a single privileged API call.
 *
 * Throws an Error with a friendly `.message` on failure.
 */
export async function getReauthToken(password, { emailOverride } = {}) {
  const email = emailOverride || primaryAuth.currentUser?.email;
  if (!email) throw new Error('No active session — please sign in again.');
  if (!password) throw new Error('Password is required.');

  const secondary = getSecondaryApp();
  const secondaryAuth = getAuth(secondary);

  try {
    const cred = await signInWithEmailAndPassword(secondaryAuth, email, password);
    // forceRefresh=true so auth_time on the resulting token is "now"
    const token = await cred.user.getIdToken(true);
    try { await signOut(secondaryAuth); } catch {}
    return token;
  } catch (err) {
    try { await signOut(secondaryAuth); } catch {}
    const code = err?.code || '';
    if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
      throw new Error('Incorrect password.');
    }
    if (code === 'auth/too-many-requests') {
      throw new Error('Too many attempts. Try again in a few minutes.');
    }
    if (code === 'auth/user-disabled') {
      throw new Error('This account has been disabled.');
    }
    if (code === 'auth/network-request-failed') {
      throw new Error('Network error. Check your connection and try again.');
    }
    throw new Error(err?.message || 'Re-authentication failed.');
  } finally {
    // Best-effort cleanup of the secondary app (next call will recreate it).
    try { await deleteApp(secondary); } catch {}
  }
}
