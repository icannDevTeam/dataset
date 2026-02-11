export default function handler(req, res) {
  const pk = process.env.FIREBASE_PRIVATE_KEY || '';
  res.status(200).json({ 
    status: 'ok', 
    service: 'facial-attendance-web-collector',
    timestamp: new Date().toISOString(),
    envCheck: {
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_PRIVATE_KEY_ID: !!process.env.FIREBASE_PRIVATE_KEY_ID,
      FIREBASE_PRIVATE_KEY_length: pk.length,
      FIREBASE_PRIVATE_KEY_starts: pk.substring(0, 30),
      FIREBASE_PRIVATE_KEY_ends: pk.substring(pk.length - 30),
      FIREBASE_PRIVATE_KEY_hasRealNewlines: pk.includes('\n'),
      FIREBASE_PRIVATE_KEY_hasLiteralBackslashN: pk.includes('\\n'),
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || 'NOT SET',
      API_KEY: !!process.env.API_KEY,
    }
  });
}
