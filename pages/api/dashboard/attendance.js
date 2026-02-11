// pages/api/dashboard/attendance.js
// Attendance recording and retrieval API

import admin from 'firebase-admin';
import axios from 'axios';

const initializeFirebase = () => {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  }
  return admin.firestore();
};

export default async function handler(req, res) {
  const db = initializeFirebase();

  if (req.method === 'GET') {
    // Get attendance records
    const { studentId, className, limit = 50, offset = 0 } = req.query;

    try {
      let query = db.collection('attendance_records');

      if (studentId) {
        query = query.where('studentId', '==', studentId);
      }
      if (className) {
        query = query.where('className', '==', className);
      }

      const snapshot = await query
        .orderBy('timestamp', 'desc')
        .limit(parseInt(limit) + parseInt(offset))
        .get();

      const records = snapshot.docs
        .slice(parseInt(offset), parseInt(offset) + parseInt(limit))
        .map(doc => {
          const data = doc.data();
          return {
            id: doc.id,
            ...data,
            // Calculate lateness/early
            status: calculateStatus(data.timestamp),
          };
        });

      return res.json({
        success: true,
        records,
        total: snapshot.size,
      });
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to fetch attendance',
        details: error.message,
      });
    }
  }

  if (req.method === 'POST') {
    // Record attendance (triggered by face recognition match)
    const {
      studentId,
      studentName,
      className,
      gradeCode,
      gradeName,
      accuracy,
      imageUrl,
      method = 'face_recognition', // 'face_recognition', 'manual', 'api'
    } = req.body;

    if (!studentId || !studentName) {
      return res.status(400).json({
        error: 'Missing required fields: studentId, studentName',
      });
    }

    try {
      const now = new Date();
      const [hours, minutes] = [now.getHours(), now.getMinutes()];

      const attendanceRecord = {
        studentId,
        studentName,
        className: className || 'Unknown',
        gradeCode: gradeCode || '',
        gradeName: gradeName || '',
        accuracy: accuracy || 0,
        imageUrl: imageUrl || '',
        method,
        timestamp: now,
        date: now.toISOString().split('T')[0], // YYYY-MM-DD for grouping
        time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Try to sync with Binus API (insert attendance data)
      try {
        await syncWithBinusAttendanceAPI(studentId, studentName, attendanceRecord);
      } catch (apiErr) {
        console.warn('Failed to sync with Binus API:', apiErr.message);
        // Continue anyway - local record is saved
      }

      const docRef = await db.collection('attendance_records').add(attendanceRecord);

      return res.json({
        success: true,
        id: docRef.id,
        message: 'Attendance recorded',
        record: {
          ...attendanceRecord,
          id: docRef.id,
        },
      });
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to record attendance',
        details: error.message,
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function calculateStatus(timestamp) {
  const attendanceTime = new Date(timestamp);
  const hour = attendanceTime.getHours();
  const minute = attendanceTime.getMinutes();
  const timeInMinutes = hour * 60 + minute;

  // Expected start time: 7:00 AM (420 minutes)
  const expectedStart = 7 * 60;
  // Grace period: 15 minutes
  const gracePeriod = 15 * 60;

  if (timeInMinutes <= expectedStart) {
    return 'early';
  } else if (timeInMinutes <= expectedStart + gracePeriod) {
    return 'on_time';
  } else {
    return 'late';
  }
}

async function syncWithBinusAttendanceAPI(studentId, studentName, record) {
  try {
    // Get auth token from Binus API
    const tokenResponse = await axios.get(
      'http://binusian.ws/binusschool/auth/token',
      {
        headers: {
          Authorization: `Basic ${process.env.API_KEY}`,
        },
        timeout: 10000,
      }
    );

    if (tokenResponse.data?.data?.token) {
      const token = tokenResponse.data.data.token;

      // Insert attendance data into Binus API
      await axios.post(
        'http://binusian.ws/binusschool/bss-add-simprug-attendance-fr',
        {
          IdStudent: studentId,
          IdBinusian: studentId, // Using studentId as Binusian ID for now
          ImageDesc: 'Face Recognition Attendance',
          UserAction: 'FR_SYSTEM',
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      console.log(`✓ Attendance synced to Binus API for student ${studentId}`);
    }
  } catch (error) {
    console.error('Error syncing with Binus API:', error.message);
    throw error;
  }
}
