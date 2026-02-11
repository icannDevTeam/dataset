import admin from 'firebase-admin';

let initialized = false;

export function initializeFirebase() {
  if (initialized || admin.apps.length > 0) {
    return;
  }

  try {
    // Handle FIREBASE_PRIVATE_KEY: Vercel may store it with literal \n,
    // double-escaped \\n, wrapped in quotes, or with real newlines
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    // Strip surrounding quotes if present
    if ((privateKey.startsWith('"') && privateKey.endsWith('"')) ||
        (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
      privateKey = privateKey.slice(1, -1);
    }
    // Replace double-escaped \\n first, then literal \n
    privateKey = privateKey.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');

    // Debug: log key details (safe — only shows structure, not the key itself)
    console.log('PK debug:', {
      rawLen: (process.env.FIREBASE_PRIVATE_KEY || '').length,
      processedLen: privateKey.length,
      startsWithBegin: privateKey.startsWith('-----BEGIN'),
      endsWithEnd: privateKey.trimEnd().endsWith('-----'),
      hasRealNewlines: privateKey.includes('\n'),
      newlineCount: (privateKey.match(/\n/g) || []).length,
      first40: privateKey.substring(0, 40),
    });

    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    };

    if (!serviceAccount.project_id) {
      throw new Error('Firebase config missing: FIREBASE_PROJECT_ID');
    }
    if (!serviceAccount.private_key) {
      throw new Error('Firebase config missing: FIREBASE_PRIVATE_KEY');
    }
    if (!process.env.FIREBASE_STORAGE_BUCKET) {
      throw new Error('Firebase config missing: FIREBASE_STORAGE_BUCKET');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });

    initialized = true;
    console.log('✓ Firebase Admin initialized');
    console.log('  Project:', serviceAccount.project_id);
    console.log('  Bucket:', process.env.FIREBASE_STORAGE_BUCKET);
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
