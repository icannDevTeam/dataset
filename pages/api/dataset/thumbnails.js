/**
 * GET /api/dataset/thumbnails
 *
 * Returns a map of studentId → photo URL for avatar thumbnails.
 * Uses the first photo found for each student in Firebase Storage.
 * Signed URLs are cached in memory for 30 minutes to avoid re-signing.
 *
 * Response:
 *   { success: true, thumbnails: { "2470006594": "https://...", ... } }
 */

import { initializeFirebase, getFirebaseStorage, getFirestoreDB } from '../../../lib/firebase-admin';
import { withMetrics } from '../../../lib/metrics';

// In-memory cache: { thumbnails, expiry }
let cache = { thumbnails: null, expiry: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Return cached if fresh
    if (cache.thumbnails && Date.now() < cache.expiry) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json({ success: true, thumbnails: cache.thumbnails });
    }

    initializeFirebase();
    const storage = getFirebaseStorage();
    const bucket = storage.bucket();
    const db = getFirestoreDB();

    // Build studentName+className → studentId map from Firestore
    const [metaSnap, studentsSnap] = await Promise.all([
      db.collection('student_metadata').get(),
      db.collection('students').get(),
    ]);

    // name+homeroom → employeeNo
    const nameToId = {};
    metaSnap.forEach((doc) => {
      const d = doc.data();
      if (d.name && d.homeroom) {
        nameToId[`${d.homeroom}/${d.name}`] = doc.id;
      }
    });
    studentsSnap.forEach((doc) => {
      const d = doc.data();
      if (d.name && d.homeroom) {
        nameToId[`${d.homeroom}/${d.name}`] = doc.id;
      }
    });

    // List all files under face_dataset/ (only at folder level to find first photo per student)
    const [files] = await bucket.getFiles({ prefix: 'face_dataset/' });

    // Group: pick first photo per className/studentName
    const firstPhoto = {}; // "className/studentName" → file

    for (const file of files) {
      const parts = file.name.split('/');
      if (parts.length < 4) continue;

      const className = parts[1];
      const studentName = parts[2];
      const fileName = parts.slice(3).join('/');
      if (!fileName || fileName.endsWith('/')) continue;

      const key = `${className}/${studentName}`;
      if (!firstPhoto[key]) {
        firstPhoto[key] = file;
      }
    }

    // Generate signed URLs and map to studentId
    const thumbnails = {};
    const signPromises = Object.entries(firstPhoto).map(async ([key, file]) => {
      try {
        const [url] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + CACHE_TTL + 5 * 60 * 1000, // slightly longer than cache
        });
        const studentId = nameToId[key];
        if (studentId) {
          thumbnails[studentId] = url;
        }
        // Also store by name for fallback matching
        const studentName = key.split('/')[1];
        if (studentName) {
          thumbnails[`name:${studentName}`] = url;
        }
      } catch {
        // Skip files that fail to sign
      }
    });

    await Promise.all(signPromises);

    // Update cache
    cache = { thumbnails, expiry: Date.now() + CACHE_TTL };

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ success: true, thumbnails });
  } catch (error) {
    console.error('Thumbnails API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

export default withMetrics(handler);
