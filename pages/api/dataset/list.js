/**
 * GET /api/dataset/list
 *
 * Lists all students in Firebase Storage face_dataset/ with their photos.
 * Returns: [{ studentName, className, photos: [{ name, url, size }] }]
 *
 * Query params:
 *   ?className=4C  — filter by class
 */

import { initializeFirebase, getFirebaseStorage, getFirestoreDB } from '../../../lib/firebase-admin';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    initializeFirebase();

    const storage = getFirebaseStorage();
    const bucket = storage.bucket();
    const classFilter = req.query.className || '';

    // List all files under face_dataset/
    const prefix = classFilter ? `face_dataset/${classFilter}/` : 'face_dataset/';
    const [files] = await bucket.getFiles({ prefix });

    // Group files by className/studentName
    const studentsMap = {};

    for (const file of files) {
      const parts = file.name.split('/');
      // face_dataset/ClassName/StudentName/photo.jpg
      if (parts.length < 4) continue;

      const className = parts[1];
      const studentName = parts[2];
      const fileName = parts.slice(3).join('/');

      if (!fileName || fileName.endsWith('/')) continue;

      const key = `${className}/${studentName}`;
      if (!studentsMap[key]) {
        studentsMap[key] = {
          studentName,
          className,
          photos: [],
        };
      }

      // Generate a signed URL (valid for 1 hour)
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000,
      });

      studentsMap[key].photos.push({
        name: fileName,
        path: file.name,
        url,
        size: parseInt(file.metadata.size || '0'),
        updated: file.metadata.updated,
      });
    }

    // Also check Firestore for student metadata
    const db = getFirestoreDB();
    const studentsSnapshot = await db.collection('students').get();
    const firestoreData = {};
    studentsSnapshot.forEach((doc) => {
      const data = doc.data();
      firestoreData[doc.id] = data;
    });

    // Convert to array and enrich with Firestore metadata
    const students = Object.values(studentsMap).map((s) => {
      // Find matching Firestore doc by name
      const fsMatch = Object.values(firestoreData).find(
        (fd) => fd.name === s.studentName && fd.homeroom === s.className
      );
      return {
        ...s,
        studentId: fsMatch?.id || '',
        gradeCode: fsMatch?.gradeCode || '',
        gradeName: fsMatch?.gradeName || '',
        totalImages: s.photos.length,
      };
    });

    // Sort by class then name
    students.sort((a, b) => {
      if (a.className !== b.className) return a.className.localeCompare(b.className);
      return a.studentName.localeCompare(b.studentName);
    });

    return res.status(200).json({
      success: true,
      total: students.length,
      students,
    });
  } catch (error) {
    console.error('Dataset list error:', error.message);
    return res.status(500).json({
      error: 'Failed to list dataset',
      details: error.message,
    });
  }
}
