/**
 * Firebase Client SDK — email/password authentication for dashboard.
 */
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged } from 'firebase/auth';

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

export async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

export async function signOut() {
  await fbSignOut(auth);
}

export { onAuthStateChanged };
