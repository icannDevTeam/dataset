import admin from 'firebase-admin';

let initialized = false;

function cleanEnv(value) {
  if (value == null) return '';
  let v = String(value);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

export function initializeFirebase() {
  if (initialized || admin.apps.length > 0) {
    return;
  }

  try {
    // Handle FIREBASE_PRIVATE_KEY: Vercel may store it with literal \n,
    // double-escaped \\n, wrapped in quotes, or with real newlines
    let privateKey = cleanEnv(process.env.FIREBASE_PRIVATE_KEY);
    // Replace double-escaped \\n first, then literal \n
    privateKey = privateKey.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');

    const serviceAccount = {
      type: "service_account",
      project_id: cleanEnv(process.env.FIREBASE_PROJECT_ID),
      private_key_id: cleanEnv(process.env.FIREBASE_PRIVATE_KEY_ID),
      private_key: privateKey,
      client_email: cleanEnv(process.env.FIREBASE_CLIENT_EMAIL),
      client_id: cleanEnv(process.env.FIREBASE_CLIENT_ID),
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    };

    const storageBucket = cleanEnv(process.env.FIREBASE_STORAGE_BUCKET);

    if (!serviceAccount.project_id) {
      throw new Error('Firebase config missing: FIREBASE_PROJECT_ID');
    }
    if (!serviceAccount.private_key) {
      throw new Error('Firebase config missing: FIREBASE_PRIVATE_KEY');
    }
    if (!storageBucket) {
      throw new Error('Firebase config missing: FIREBASE_STORAGE_BUCKET');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket,
    });

    initialized = true;
    console.log('✓ Firebase Admin initialized');
    console.log('  Project:', serviceAccount.project_id);
    console.log('  Bucket:', storageBucket);
  } catch (error) {
    console.error('✗ Firebase initialization failed:', error.message);
    throw error;
  }
}

export function getFirebaseAdmin() {
  if (!admin.apps.length) {
    initializeFirebase();
  }
  return admin;
}

export function getFirebaseStorage() {
  return getFirebaseAdmin().storage();
}

export function getFirestoreDB() {
  return getFirebaseAdmin().firestore();
}
