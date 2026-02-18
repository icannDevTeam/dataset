/**
 * GET /api/attendance/metrics
 *
 * Returns attendance metrics, student metadata (class/grade), and
 * system performance stats from Firestore.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  (optional, defaults to today WIB)
 */

import { getFirestoreDB } from '../../../lib/firebase-admin';

function getWIBDate(dateStr) {
  if (dateStr) return dateStr;
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const date = getWIBDate(req.query.date);
    const db = getFirestoreDB();

    // Get attendance records
    const snapshot = await db
      .collection('attendance')
      .doc(date)
      .collection('records')
      .orderBy('timestamp', 'asc')
      .get();

    const records = [];
    snapshot.forEach((doc) => {
      records.push({ id: doc.id, ...doc.data() });
    });

    // Get all student metadata
    const studentsSnap = await db.collection('students').get();
    const students = {};
    studentsSnap.forEach((doc) => {
      students[doc.id] = doc.data();
    });

    // Enrich records with class/grade info
    const enrichedRecords = records.map((r) => {
      const meta = students[r.employeeNo] || {};
      return {
        ...r,
        className: meta.homeroom || r.className || '',
        gradeName: meta.gradeName || r.gradeName || '',
        gradeCode: meta.gradeCode || r.gradeCode || '',
      };
    });

    // Extract unique classes and grades
    const allStudents = Object.values(students);
    const classes = [...new Set(allStudents.map((s) => s.homeroom).filter(Boolean))].sort();
    const grades = [...new Set(allStudents.map((s) => s.gradeName).filter(Boolean))].sort();

    // Day summary
    const dayDoc = await db.collection('attendance').doc(date).get();
    const dayData = dayDoc.exists ? dayDoc.data() : {};

    // Performance metrics from Firestore (written by Jetson)
    let perfMetrics = {};
    try {
      const perfDoc = await db.collection('system').doc('performance').get();
      if (perfDoc.exists) perfMetrics = perfDoc.data();
    } catch {}

    const presentCount = enrichedRecords.filter((r) => r.status === 'Present').length;
    const lateCount = enrichedRecords.filter((r) => r.status === 'Late').length;

    // Compute timing metrics from records
    let avgResponseTime = null;
    const timestamps = enrichedRecords
      .map((r) => r.timestamp)
      .filter(Boolean)
      .map((t) => new Date(t.replace(' ', 'T') + '+07:00').getTime());

    if (timestamps.length >= 2) {
      const diffs = [];
      for (let i = 1; i < timestamps.length; i++) {
        diffs.push(timestamps[i] - timestamps[i - 1]);
      }
      avgResponseTime = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length / 1000);
    }

    return res.status(200).json({
      date,
      records: enrichedRecords,
      students: allStudents,
      filters: { classes, grades },
      summary: {
        total: enrichedRecords.length,
        present: presentCount,
        late: lateCount,
        enrolled: allStudents.length,
        lastUpdated: dayData.lastUpdated || null,
      },
      performance: {
        ...perfMetrics,
        avgSecondsBetweenScans: avgResponseTime,
        totalScansToday: enrichedRecords.length,
      },
    });
  } catch (error) {
    console.error('Metrics API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
