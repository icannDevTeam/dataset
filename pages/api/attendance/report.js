/**
 * GET /api/attendance/report
 *
 * Returns comprehensive attendance report data for a date range.
 * Designed for printable reports with per-class, per-student, and per-terminal breakdowns.
 *
 * Query params:
 *   ?from=YYYY-MM-DD   Start date (required)
 *   ?to=YYYY-MM-DD     End date (default: today WIB)
 *   ?class=4C           Filter by homeroom (optional, comma-separated for multiple)
 *   ?grade=4            Filter by grade (optional)
 *   ?status=Present     Filter by status (optional: Present, Late)
 *   ?source=Device1     Filter by source/terminal (optional)
 *
 * Response:
 *   - range: { from, to, totalDays, schoolDays }
 *   - filters: { classes, grades, statuses, sources }  (available filter values)
 *   - summary: { totalStudents, totalScans, avgDailyAttendance, presentRate, lateRate, ... }
 *   - classSummary: [{ homeroom, grade, enrolled, totalScans, avgPresent, avgLate, attendanceRate, students }]
 *   - studentRecords: [{ name, employeeNo, homeroom, grade, daysPresent, daysLate, daysAbsent, attendanceRate, records }]
 *   - sourceSummary: [{ source, totalScans, uniqueStudents }]
 *   - dailyBreakdown: [{ date, total, present, late }]
 */

import { getFirestoreDB } from '../../../lib/firebase-admin';
import { withMetrics } from '../../../lib/metrics';
import { withAuth } from '../../../lib/auth-middleware';

function getWIBDate(dateStr) {
  if (dateStr) return dateStr;
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function dateRange(from, to) {
  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const toDate = getWIBDate(req.query.to);
    const fromDate = req.query.from || toDate;

    // Validate date range (max 90 days)
    const fromMs = new Date(fromDate + 'T00:00:00Z').getTime();
    const toMs = new Date(toDate + 'T00:00:00Z').getTime();
    if (isNaN(fromMs) || isNaN(toMs)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    const daysDiff = Math.ceil((toMs - fromMs) / 86400000) + 1;
    if (daysDiff > 90) {
      return res.status(400).json({ error: 'Date range cannot exceed 90 days.' });
    }
    if (daysDiff < 1) {
      return res.status(400).json({ error: 'From date must be before or equal to To date.' });
    }

    // Parse filters
    const filterClasses = req.query.class ? req.query.class.split(',').map((s) => s.trim()) : null;
    const filterGrade = req.query.grade || null;
    const filterStatus = req.query.status || null;
    const filterSource = req.query.source || null;

    const db = getFirestoreDB();

    // Build metadata lookup
    const [metadataSnap, studentsSnap] = await Promise.all([
      db.collection('student_metadata').get(),
      db.collection('students').get(),
    ]);

    const metaMap = {};
    const nameMap = {};
    metadataSnap.forEach((doc) => {
      const d = doc.data();
      metaMap[doc.id] = {
        homeroom: d.homeroom || '',
        grade: d.grade || d.gradeCode || '',
        name: d.name || '',
      };
      if (d.name && d.homeroom) {
        nameMap[d.name] = metaMap[doc.id];
      }
    });
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
        if (!metaMap[id].homeroom && d.homeroom) metaMap[id].homeroom = d.homeroom;
        if (!metaMap[id].grade && (d.gradeCode || d.grade)) metaMap[id].grade = d.gradeCode || d.grade;
        if (!metaMap[id].name && d.name) metaMap[id].name = d.name;
      }
      if (d.name && d.homeroom && !nameMap[d.name]) {
        nameMap[d.name] = { homeroom: d.homeroom, grade: d.gradeCode || d.grade || '', name: d.name };
      }
    });

    // Build enrolled students map (for absence tracking)
    const enrolledMap = {}; // employeeNo → { name, homeroom, grade }
    studentsSnap.forEach((doc) => {
      const d = doc.data();
      enrolledMap[doc.id] = {
        name: d.name || metaMap[doc.id]?.name || '',
        homeroom: d.homeroom || metaMap[doc.id]?.homeroom || '',
        grade: d.gradeCode || d.grade || metaMap[doc.id]?.grade || '',
      };
    });

    // Discover which dates exist
    const dateDocs = await db.collection('attendance').listDocuments();
    const existingDates = new Set(dateDocs.map((d) => d.id));
    const allDates = dateRange(fromDate, toDate);
    const schoolDays = allDates.filter(isWeekday);
    const datesToFetch = allDates.filter((d) => existingDates.has(d));

    // Fetch all records
    const BATCH_SIZE = 10;
    const dailyBreakdown = [];
    const studentDays = {}; // employeeNo → { name, homeroom, grade, dates: { date → status } }
    const sourceMap = {};   // source → { totalScans, students: Set }
    const allClassSet = new Set();
    const allGradeSet = new Set();
    const allStatusSet = new Set();
    const allSourceSet = new Set();

    for (let i = 0; i < datesToFetch.length; i += BATCH_SIZE) {
      const batch = datesToFetch.slice(i, i + BATCH_SIZE);
      const snapshots = await Promise.all(
        batch.map((date) =>
          db.collection('attendance').doc(date).collection('records')
            .orderBy('timestamp', 'asc').get()
            .then((snap) => ({ date, snap }))
        )
      );

      for (const { date, snap } of snapshots) {
        const dayRecords = [];
        snap.forEach((doc) => dayRecords.push({ id: doc.id, ...doc.data() }));

        let dayPresent = 0;
        let dayLate = 0;

        for (const r of dayRecords) {
          // Enrich
          const meta = metaMap[r.employeeNo] || metaMap[r.id] || {};
          if (!r.homeroom && meta.homeroom) r.homeroom = meta.homeroom;
          if (!r.grade && meta.grade) r.grade = meta.grade;
          if (!r.name && meta.name) r.name = meta.name;
          if (!r.homeroom && r.name && nameMap[r.name]) {
            r.homeroom = nameMap[r.name].homeroom;
            if (!r.grade) r.grade = nameMap[r.name].grade;
          }

          // Collect all filter values
          if (r.homeroom) allClassSet.add(r.homeroom);
          if (r.grade) allGradeSet.add(r.grade);
          if (r.status) allStatusSet.add(r.status);
          const source = r.source || r.deviceName || 'Unknown';
          allSourceSet.add(source);

          // Apply filters
          if (filterClasses && r.homeroom && !filterClasses.includes(r.homeroom)) continue;
          if (filterGrade && r.grade !== filterGrade) continue;
          if (filterStatus && r.status !== filterStatus) continue;
          if (filterSource && source !== filterSource) continue;

          if (r.status === 'Present') dayPresent++;
          if (r.status === 'Late') dayLate++;

          // Track per-student
          const key = r.employeeNo || r.id;
          if (!studentDays[key]) {
            studentDays[key] = {
              name: r.name || key,
              employeeNo: r.employeeNo || '',
              homeroom: r.homeroom || '',
              grade: r.grade || '',
              dates: {},
            };
          }
          studentDays[key].dates[date] = {
            status: r.status,
            timestamp: r.timestamp || '',
            source,
            confidence: r.confidence,
          };

          // Track per-source
          if (!sourceMap[source]) sourceMap[source] = { totalScans: 0, students: new Set() };
          sourceMap[source].totalScans++;
          sourceMap[source].students.add(key);
        }

        dailyBreakdown.push({
          date,
          total: dayPresent + dayLate,
          present: dayPresent,
          late: dayLate,
        });
      }
    }

    // Fill zero-data days
    dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));
    const fullDaily = allDates.map((date) => {
      const found = dailyBreakdown.find((d) => d.date === date);
      return found || { date, total: 0, present: 0, late: 0 };
    });

    // Build student records with absence tracking
    const daysWithData = datesToFetch.length;
    const studentRecords = Object.entries(studentDays).map(([key, s]) => {
      const daysPresent = Object.values(s.dates).filter((d) => d.status === 'Present').length;
      const daysLate = Object.values(s.dates).filter((d) => d.status === 'Late').length;
      const daysAttended = daysPresent + daysLate;
      const daysAbsent = Math.max(0, daysWithData - daysAttended);
      return {
        name: s.name,
        employeeNo: s.employeeNo,
        homeroom: s.homeroom,
        grade: s.grade,
        daysPresent,
        daysLate,
        daysAbsent,
        totalDays: daysWithData,
        attendanceRate: daysWithData > 0 ? parseFloat(((daysAttended / daysWithData) * 100).toFixed(1)) : 0,
        onTimeRate: daysAttended > 0 ? parseFloat(((daysPresent / daysAttended) * 100).toFixed(1)) : 0,
      };
    }).sort((a, b) => a.homeroom.localeCompare(b.homeroom) || a.name.localeCompare(b.name));

    // Build class summary
    const classGroups = {};
    for (const s of studentRecords) {
      const hr = s.homeroom || 'Unknown';
      if (!classGroups[hr]) classGroups[hr] = { students: [], grade: s.grade };
      classGroups[hr].students.push(s);
    }

    // Count enrolled students per class
    const enrolledByClass = {};
    Object.entries(enrolledMap).forEach(([, info]) => {
      const hr = info.homeroom || 'Unknown';
      if (!enrolledByClass[hr]) enrolledByClass[hr] = 0;
      enrolledByClass[hr]++;
    });

    const classSummary = Object.entries(classGroups).map(([homeroom, group]) => {
      const students = group.students;
      const totalPresent = students.reduce((sum, s) => sum + s.daysPresent, 0);
      const totalLate = students.reduce((sum, s) => sum + s.daysLate, 0);
      const totalScans = totalPresent + totalLate;
      const enrolled = enrolledByClass[homeroom] || students.length;
      const avgAttendance = daysWithData > 0 && enrolled > 0
        ? parseFloat(((totalScans / (daysWithData * enrolled)) * 100).toFixed(1))
        : 0;

      return {
        homeroom,
        grade: group.grade,
        enrolled,
        studentsTracked: students.length,
        totalScans,
        totalPresent,
        totalLate,
        attendanceRate: avgAttendance,
        onTimeRate: totalScans > 0 ? parseFloat(((totalPresent / totalScans) * 100).toFixed(1)) : 0,
      };
    }).sort((a, b) => a.homeroom.localeCompare(b.homeroom));

    // Source summary
    const sourceSummary = Object.entries(sourceMap).map(([source, data]) => ({
      source,
      totalScans: data.totalScans,
      uniqueStudents: data.students.size,
    })).sort((a, b) => b.totalScans - a.totalScans);

    // Overall summary
    const totalScans = studentRecords.reduce((sum, s) => sum + s.daysPresent + s.daysLate, 0);
    const totalPresent = studentRecords.reduce((sum, s) => sum + s.daysPresent, 0);
    const totalLate = studentRecords.reduce((sum, s) => sum + s.daysLate, 0);

    return res.status(200).json({
      range: {
        from: fromDate,
        to: toDate,
        totalDays: daysDiff,
        schoolDays: schoolDays.length,
        daysWithData,
      },
      filters: {
        classes: [...allClassSet].sort(),
        grades: [...allGradeSet].sort((a, b) => {
          const na = parseInt(a), nb = parseInt(b);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        }),
        statuses: [...allStatusSet].sort(),
        sources: [...allSourceSet].sort(),
      },
      summary: {
        totalStudents: studentRecords.length,
        enrolledStudents: studentsSnap.size,
        totalScans,
        totalPresent,
        totalLate,
        presentRate: totalScans > 0 ? parseFloat(((totalPresent / totalScans) * 100).toFixed(1)) : 0,
        lateRate: totalScans > 0 ? parseFloat(((totalLate / totalScans) * 100).toFixed(1)) : 0,
        avgDailyAttendance: daysWithData > 0 ? Math.round(totalScans / daysWithData) : 0,
      },
      classSummary,
      studentRecords,
      sourceSummary,
      dailyBreakdown: fullDaily,
    });
  } catch (error) {
    console.error('Report API error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export default withAuth(withMetrics(handler));
