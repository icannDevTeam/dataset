// pages/api/dashboard/logs.js
// Dashboard logging and analytics API

import admin from 'firebase-admin';

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
    // Get logs based on type (searches, captures, failures, accuracy)
    const { type = 'all', limit = 100, offset = 0 } = req.query;

    try {
      let query = db.collection('dashboard_logs');

      if (type !== 'all') {
        query = query.where('logType', '==', type);
      }

      const snapshot = await query
        .orderBy('timestamp', 'desc')
        .limit(parseInt(limit) + parseInt(offset))
        .get();

      const logs = snapshot.docs
        .slice(parseInt(offset), parseInt(offset) + parseInt(limit))
        .map(doc => ({
          id: doc.id,
          ...doc.data(),
        }));

      const totalCount = snapshot.size;

      return res.json({
        success: true,
        logs,
        totalCount,
        type,
      });
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to fetch logs',
        details: error.message,
      });
    }
  }

  if (req.method === 'POST') {
    // Log an event (student search, capture, failure, accuracy)
    const {
      logType, // 'search', 'capture', 'failure', 'accuracy'
      studentId,
      studentName,
      className,
      details,
      accuracy = null,
      timestamp = new Date().toISOString(),
    } = req.body;

    if (!logType || !studentId) {
      return res.status(400).json({
        error: 'Missing required fields: logType, studentId',
      });
    }

    try {
      const logEntry = {
        logType,
        studentId,
        studentName: studentName || 'Unknown',
        className: className || 'Unknown',
        details: details || {},
        accuracy,
        timestamp: new Date(timestamp),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const docRef = await db.collection('dashboard_logs').add(logEntry);

      return res.json({
        success: true,
        id: docRef.id,
        message: 'Log entry created',
      });
    } catch (error) {
      return res.status(500).json({
        error: 'Failed to create log',
        details: error.message,
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
