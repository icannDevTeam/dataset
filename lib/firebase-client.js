/**
 * Firebase Client SDK initialization for dashboard authentication.
 * Uses Google sign-in for admin access control.
 */
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyClDQe4e2NpfVw4nvLG10vzK8wmdGCHJwk',
  authDomain: 'facial-attendance-binus.firebaseapp.com',
  projectId: 'facial-attendance-binus',
  storageBucket: 'facial-attendance-binus.firebasestorage.app',
  messagingSenderId: '866005352235',
  appId: '1:866005352235:web:90f5c63b84892bdf774f6e',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOut() {
  await fbSignOut(auth);
}

export { onAuthStateChanged };
