/**
 * Firebase Client SDK — email/password authentication for dashboard.
 */
import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth, signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged,
  multiFactor, TotpMultiFactorGenerator, getMultiFactorResolver,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'AIzaSyClDQe4e2NpfVw4nvLG10vzK8wmdGCHJwk',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'facial-attendance-binus.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'facial-attendance-binus',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'facial-attendance-binus.firebasestorage.app',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '866005352235',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '1:866005352235:web:90f5c63b84892bdf774f6e',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);

export async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signOut() {
  await fbSignOut(auth);
}

// ── TOTP multi-factor auth (enabled 2026-09-17) ────────────────────────────
// Enrollment: multiFactor(user).getSession() -> TotpMultiFactorGenerator
//   .generateSecret(session) -> show secret.secretKey for the user to add to
//   their authenticator app -> assertionForEnrollment(secret, code) -> enroll.
// Sign-in challenge: signInWithEmailAndPassword throws
//   'auth/multi-factor-auth-required' when the account has an enrolled
//   factor -> getMultiFactorResolver(auth, error) -> assertionForSignIn
//   (hint.uid, code) -> resolver.resolveSignIn(assertion).
export { multiFactor, TotpMultiFactorGenerator, getMultiFactorResolver };

export { onAuthStateChanged };
