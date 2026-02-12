/**
 * GET /api/attendance/today
 *
 * Returns today's attendance records from Firestore.
 * Query params:
 *   ?date=YYYY-MM-DD  (optional, defaults to today WIB)
 */

import { getFirestoreDB } from '../../../lib/firebase-admin';

function getWIBDate(dateStr) {
  if (dateStr) return dateStr;
  // UTC+7
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

    // Get all records for the date
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

    // Get enrolled students count from device summary (stored by listener)
    const dayDoc = await db.collection('attendance').doc(date).get();
    const dayData = dayDoc.exists ? dayDoc.data() : {};

    const presentCount = records.filter((r) => r.status === 'Present').length;
    const lateCount = records.filter((r) => r.status === 'Late').length;

    return res.status(200).json({
      date,
      records,
      summary: {
        total: records.length,
        present: presentCount,
        late: lateCount,
        lastUpdated: dayData.lastUpdated || null,
      },
    });
  } catch (error) {
    console.error('Attendance API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
