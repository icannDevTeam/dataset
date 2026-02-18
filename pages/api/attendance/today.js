/**
 * GET /api/attendance/today
 *
 * Returns today's attendance records from Firestore, enriched with
 * class/grade metadata from student_metadata and students collections.
 *
 * Query params:
 *   ?date=YYYY-MM-DD  (optional, defaults to today WIB)
 *
 * Response includes:
 *   - records[].homeroom  (e.g. "4C")
 *   - records[].grade     (e.g. "4")
 *   - availableClasses    (unique homerooms for filter UI)
 *   - availableGrades     (unique grades for filter UI)
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

    // Fetch attendance records and student metadata in parallel
    const [attendanceSnap, metadataSnap, studentsSnap, dayDoc] = await Promise.all([
      db.collection('attendance').doc(date).collection('records').orderBy('timestamp', 'asc').get(),
      db.collection('student_metadata').get(),
      db.collection('students').get(),
      db.collection('attendance').doc(date).get(),
    ]);

    // Build metadata lookup: employeeNo → { homeroom, grade }
    const metaMap = {};
    metadataSnap.forEach((doc) => {
      const d = doc.to_dict ? doc.to_dict() : doc.data();
      metaMap[doc.id] = {
        homeroom: d.homeroom || '',
        grade: d.grade || d.gradeCode || '',
        name: d.name || '',
      };
    });

    // Also build from students collection (keyed by studentId = employeeNo)
    studentsSnap.forEach((doc) => {
      const d = doc.data();
      const id = doc.id;
      if (!metaMap[id]) {
        metaMap[id] = {
          homeroom: d.homeroom || '',
          grade: d.gradeCode || d.grade || '',
          name: d.name || '',
        };
      } else {
        // Fill in missing fields from students collection
        if (!metaMap[id].homeroom && d.homeroom) metaMap[id].homeroom = d.homeroom;
        if (!metaMap[id].grade && (d.gradeCode || d.grade)) metaMap[id].grade = d.gradeCode || d.grade;
      }
    });

    // Enrich attendance records with class/grade
    const records = [];
    attendanceSnap.forEach((doc) => {
      const data = { id: doc.id, ...doc.data() };
      const meta = metaMap[data.employeeNo] || metaMap[doc.id] || {};
      data.homeroom = data.homeroom || meta.homeroom || '';
      data.grade = data.grade || meta.grade || '';
      records.push(data);
    });

    const dayData = dayDoc.exists ? dayDoc.data() : {};

    const presentCount = records.filter((r) => r.status === 'Present').length;
    const lateCount = records.filter((r) => r.status === 'Late').length;

    // Collect unique classes and grades for filter dropdowns
    const classSet = new Set();
    const gradeSet = new Set();
    records.forEach((r) => {
      if (r.homeroom) classSet.add(r.homeroom);
      if (r.grade) gradeSet.add(r.grade);
    });
    // Also add from full metadata (for absent tracking)
    Object.values(metaMap).forEach((m) => {
      if (m.homeroom) classSet.add(m.homeroom);
      if (m.grade) gradeSet.add(m.grade);
    });

    return res.status(200).json({
      date,
      records,
      summary: {
        total: records.length,
        present: presentCount,
        late: lateCount,
        lastUpdated: dayData.lastUpdated || null,
      },
      availableClasses: [...classSet].sort(),
      availableGrades: [...gradeSet].sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      }),
    });
  } catch (error) {
    console.error('Attendance API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
