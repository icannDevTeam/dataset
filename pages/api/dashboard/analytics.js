// pages/api/dashboard/analytics.js
// Dashboard analytics and metrics API

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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { timeframe = '24h' } = req.query;
  const db = initializeFirebase();

  try {
    // Calculate date range
    const now = new Date();
    let startDate = new Date();

    switch (timeframe) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '24h':
      default:
        startDate.setHours(now.getHours() - 24);
    }

    // Get statistics
    const logsRef = db.collection('dashboard_logs');

    // Total searches
    const searchesSnap = await logsRef
      .where('logType', '==', 'search')
      .where('timestamp', '>=', startDate)
      .get();
    const totalSearches = searchesSnap.size;
    const uniqueSearchStudents = new Set(
      searchesSnap.docs.map(doc => doc.data().studentId)
    ).size;

    // Total captures
    const capturesSnap = await logsRef
      .where('logType', '==', 'capture')
      .where('timestamp', '>=', startDate)
      .get();
    const totalCaptures = capturesSnap.size;
    const totalImages = capturesSnap.docs.reduce((sum, doc) => {
      return sum + (doc.data().details?.imageCount || 1);
    }, 0);

    // Total failures
    const failuresSnap = await logsRef
      .where('logType', '==', 'failure')
      .where('timestamp', '>=', startDate)
      .get();
    const totalFailures = failuresSnap.size;

    // Average accuracy
    const accuracySnap = await logsRef
      .where('logType', '==', 'accuracy')
      .where('timestamp', '>=', startDate)
      .get();
    const accuracyValues = accuracySnap.docs
      .map(doc => doc.data().accuracy)
      .filter(acc => acc !== null && acc !== undefined);
    const avgAccuracy =
      accuracyValues.length > 0
        ? (
            accuracyValues.reduce((a, b) => a + b, 0) /
            accuracyValues.length
          ).toFixed(2)
        : 0;

    // Success rate
    const successRate =
      totalSearches + totalFailures > 0
        ? (
            ((totalSearches - totalFailures) /
              (totalSearches + totalFailures)) *
            100
          ).toFixed(2)
        : 100;

    // Get top students by captures
    const capturesByStudent = {};
    capturesSnap.docs.forEach(doc => {
      const sid = doc.data().studentId;
      capturesByStudent[sid] = (capturesByStudent[sid] || 0) + 1;
    });

    const topStudents = Object.entries(capturesByStudent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([studentId, count]) => ({
        studentId,
        captureCount: count,
      }));

    return res.json({
      success: true,
      timeframe,
      metrics: {
        totalSearches,
        uniqueSearchStudents,
        totalCaptures,
        totalImages,
        totalFailures,
        successRate: parseFloat(successRate),
        avgAccuracy: parseFloat(avgAccuracy),
        startDate: startDate.toISOString(),
        endDate: now.toISOString(),
      },
      topStudents,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch analytics',
      details: error.message,
    });
  }
}
