/**
 * POST /api/dataset/seed
 *
 * Receives computed face descriptors from the browser and writes them
 * to Firestore `face_descriptors/{studentId}`.
 *
 * Body: {
 *   studentId: string,
 *   studentName: string,
 *   className: string,
 *   gradeCode: string,
 *   descriptors: number[][],   // array of 128-d descriptor arrays
 *   photoCount: number,
 * }
 *
 * GET /api/dataset/seed?studentId=xxx&className=xxx&studentName=xxx
 *
 * Returns signed photo URLs for a specific student so the browser
 * can download them for descriptor computation.
 */

import { initializeFirebase, getFirebaseStorage, getFirestoreDB } from '../../../lib/firebase-admin';
import { withMetrics } from '../../../lib/metrics';

async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGetPhotos(req, res);
  }
  if (req.method === 'POST') {
    return handleSaveDescriptors(req, res);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * GET — return signed URLs for a student's photos
 */
async function handleGetPhotos(req, res) {
  const { className, studentName } = req.query;

  if (!className || !studentName) {
    return res.status(400).json({ error: 'className and studentName are required' });
  }

  try {
    initializeFirebase();
    const storage = getFirebaseStorage();
    const bucket = storage.bucket();

    const prefix = `face_dataset/${className}/${studentName}/`;
    const [files] = await bucket.getFiles({ prefix });

    const imageFiles = files.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f.name));

    const photos = [];
    for (const file of imageFiles.slice(0, 10)) {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 30 * 60 * 1000, // 30 min
      });
      photos.push({ name: file.name.split('/').pop(), url });
    }

    return res.status(200).json({ success: true, photos });
  } catch (error) {
    console.error('Get photos error:', error.message);
    return res.status(500).json({ error: 'Failed to get photos', details: error.message });
  }
}

/**
 * POST — save computed descriptors to Firestore
 */
async function handleSaveDescriptors(req, res) {
  const { studentId, studentName, className, gradeCode, descriptors, photoCount } = req.body;

  if (!studentId || !studentName) {
    return res.status(400).json({ error: 'studentId and studentName are required' });
  }

  if (!descriptors || !Array.isArray(descriptors) || descriptors.length === 0) {
    return res.status(400).json({ error: 'descriptors array is required and must not be empty' });
  }

  // Validate each descriptor is a 128-d array of numbers
  for (let i = 0; i < descriptors.length; i++) {
    if (!Array.isArray(descriptors[i]) || descriptors[i].length !== 128) {
      return res.status(400).json({ error: `descriptor_${i} must be a 128-element array` });
    }
    if (!descriptors[i].every((v) => typeof v === 'number' && isFinite(v))) {
      return res.status(400).json({ error: `descriptor_${i} contains non-numeric values` });
    }
  }

  try {
    initializeFirebase();
    const db = getFirestoreDB();

    // Build Firestore doc (same format as seed-descriptors.cjs)
    const docData = {
      name: studentName,
      homeroom: className || '',
      grade: gradeCode || '',
      descriptorCount: descriptors.length,
      photoCount: photoCount || descriptors.length,
      updatedAt: new Date().toISOString(),
    };

    // Store each descriptor as a separate field (Firestore can't do nested arrays)
    for (let i = 0; i < descriptors.length; i++) {
      docData[`descriptor_${i}`] = descriptors[i];
    }

    await db.collection('face_descriptors').doc(studentId).set(docData);

    return res.status(200).json({
      success: true,
      message: `Saved ${descriptors.length} descriptors for ${studentName}`,
      studentId,
      descriptorCount: descriptors.length,
    });
  } catch (error) {
    console.error('Save descriptors error:', error.message);
    return res.status(500).json({ error: 'Failed to save descriptors', details: error.message });
  }
}

export default withMetrics(handler);
