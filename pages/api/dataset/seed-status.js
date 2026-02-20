/**
 * GET /api/dataset/seed-status
 *
 * Returns the enrollment status for the mobile app:
 *  - Which students have photos uploaded
 *  - Which students already have face descriptors seeded
 *  - Photo counts and descriptor counts
 */

import { initializeFirebase, getFirebaseStorage, getFirestoreDB } from '../../../lib/firebase-admin';
import { withMetrics } from '../../../lib/metrics';

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    initializeFirebase();
    const storage = getFirebaseStorage();
    const bucket = storage.bucket();
    const db = getFirestoreDB();

    // 1. List all photos in face_dataset/
    const [files] = await bucket.getFiles({ prefix: 'face_dataset/' });

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
        studentsMap[key] = { studentName, className, photoCount: 0, photoUrls: [] };
      }
      studentsMap[key].photoCount++;
    }

    // 2. Get student metadata from Firestore (to get studentId)
    const studentsSnap = await db.collection('students').get();
    const studentIdMap = {}; // name+homeroom -> studentId
    studentsSnap.forEach((doc) => {
      const d = doc.data();
      const key = `${d.homeroom}/${d.name}`;
      studentIdMap[key] = { id: doc.id, gradeCode: d.gradeCode || '' };
    });

    // 3. Get existing face descriptors
    const descSnap = await db.collection('face_descriptors').get();
    const descriptorMap = {}; // studentId -> { descriptorCount, updatedAt }
    descSnap.forEach((doc) => {
      const d = doc.data();
      descriptorMap[doc.id] = {
        descriptorCount: d.descriptorCount || 0,
        updatedAt: d.updatedAt || null,
      };
    });

    // 4. Build combined status list
    const students = Object.entries(studentsMap).map(([key, val]) => {
      const meta = studentIdMap[key] || {};
      const studentId = meta.id || '';
      const desc = studentId ? descriptorMap[studentId] : null;

      return {
        studentName: val.studentName,
        className: val.className,
        studentId,
        gradeCode: meta.gradeCode || '',
        photoCount: val.photoCount,
        seeded: desc ? desc.descriptorCount > 0 : false,
        descriptorCount: desc ? desc.descriptorCount : 0,
        lastSeeded: desc ? desc.updatedAt : null,
      };
    });

    students.sort((a, b) => {
      if (a.className !== b.className) return a.className.localeCompare(b.className);
      return a.studentName.localeCompare(b.studentName);
    });

    const totalStudents = students.length;
    const seededCount = students.filter((s) => s.seeded).length;
    const unseededCount = totalStudents - seededCount;

    return res.status(200).json({
      success: true,
      totalStudents,
      seededCount,
      unseededCount,
      students,
    });
  } catch (error) {
    console.error('Seed status error:', error.message);
    return res.status(500).json({ error: 'Failed to get seed status', details: error.message });
  }
}

export default withMetrics(handler);
