/**
 * GET /api/attendance/analytics
 *
 * Returns multi-day attendance analytics computed from Firestore.
 *
 * Query params:
 *   ?days=30        Number of calendar days to look back (default 30, max 90)
 *   ?to=YYYY-MM-DD  End date (default today WIB)
 *
 * Response:
 *   - range: { from, to, days }
 *   - dailyTrends: [{ date, total, present, late }]
 *   - summary: { avgAttendanceRate, totalScans, totalPresent, totalLate, enrolledStudents, daysWithData }
 *   - classRates: [{ homeroom, total, present, late, rate }]  (sorted desc by rate)
 *   - hourlyDistribution: [{ hour, count }]  (0-23)
 *   - accuracy: { avg, min, max, scansWithConfidence, distribution: { below50, 50to80, 80to95, above95 } }
 *   - lowAccuracyFlags: [{ name, employeeNo, homeroom, date, timestamp, confidence }]  (confidence < 0.5)
 */

import { getFirestoreDB } from '../../../lib/firebase-admin';
import { withMetrics } from '../../../lib/metrics';
import { withAuth } from '../../../lib/auth-middleware';

function getWIBDate(dateStr) {
  if (dateStr) return dateStr;
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

/** Generate an array of YYYY-MM-DD strings from `from` to `to` inclusive. */
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

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const toDate = getWIBDate(req.query.to);
    const toMs = new Date(toDate + 'T00:00:00Z').getTime();
    const fromDate = new Date(toMs - (days - 1) * 86400000).toISOString().slice(0, 10);

    const db = getFirestoreDB();

    // Discover which date documents actually exist in Firestore
    const dateDocs = await db.collection('attendance').listDocuments();
    const existingDates = new Set(dateDocs.map((d) => d.id));

    // Filter to only dates within range that exist
    const allDates = dateRange(fromDate, toDate);
    const datesToFetch = allDates.filter((d) => existingDates.has(d));

    // ── Build metadata lookup for enrichment (same pattern as today.js) ──
    // This ensures records with missing homeroom/grade get enriched from
    // student_metadata and students collections before aggregation.
    const [metadataSnap, studentsSnap] = await Promise.all([
      db.collection('student_metadata').get(),
      db.collection('students').get(),
    ]);

    const metaMap = {};
    // Also build a name→metadata map for fallback enrichment
    const nameMap = {};
    metadataSnap.forEach((doc) => {
      const d = doc.data();
      metaMap[doc.id] = {
        homeroom: d.homeroom || '',
        grade: d.grade || d.gradeCode || '',
        name: d.name || '',
      };
      // Only store in nameMap if this entry has homeroom (skip empty ones)
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

    const enrolledStudents = studentsSnap.size;

    // Fetch all records in parallel (batched to avoid overwhelming Firestore)
    const BATCH_SIZE = 10;
    const dailyTrends = [];
    const allRecords = [];
    const classMap = {}; // homeroom → { total, present, late }
    const hourlyMap = {}; // hour → count
    const confidenceValues = [];
    const lowAccuracyFlags = [];

    for (let i = 0; i < datesToFetch.length; i += BATCH_SIZE) {
      const batch = datesToFetch.slice(i, i + BATCH_SIZE);
      const snapshots = await Promise.all(
        batch.map((date) =>
          db
            .collection('attendance')
            .doc(date)
            .collection('records')
            .orderBy('timestamp', 'asc')
            .get()
            .then((snap) => ({ date, snap }))
        )
      );

      for (const { date, snap } of snapshots) {
        const records = [];
        snap.forEach((doc) => records.push({ id: doc.id, ...doc.data() }));

        const present = records.filter((r) => r.status === 'Present').length;
        const late = records.filter((r) => r.status === 'Late').length;

        dailyTrends.push({ date, total: records.length, present, late });

        for (const r of records) {
          // Enrich record with metadata (fill missing homeroom/grade)
          const meta = metaMap[r.employeeNo] || metaMap[r.id] || {};
          if (!r.homeroom && meta.homeroom) r.homeroom = meta.homeroom;
          if (!r.grade && meta.grade) r.grade = meta.grade;
          if (!r.name && meta.name) r.name = meta.name;

          // Name-based fallback: if homeroom still missing, try matching by name
          if (!r.homeroom && r.name && nameMap[r.name]) {
            r.homeroom = nameMap[r.name].homeroom;
            if (!r.grade) r.grade = nameMap[r.name].grade;
          }

          allRecords.push(r);

          // Class aggregation
          const hr = r.homeroom || 'Unknown';
          if (!classMap[hr]) classMap[hr] = { total: 0, present: 0, late: 0 };
          classMap[hr].total++;
          if (r.status === 'Present') classMap[hr].present++;
          if (r.status === 'Late') classMap[hr].late++;

          // Hourly distribution
          if (r.timestamp) {
            const hourMatch = r.timestamp.match(/(\d{2}):\d{2}:\d{2}/);
            if (hourMatch) {
              const h = parseInt(hourMatch[1], 10);
              hourlyMap[h] = (hourlyMap[h] || 0) + 1;
            }
          }

          // Confidence/accuracy tracking
          if (typeof r.confidence === 'number') {
            confidenceValues.push(r.confidence);
            if (r.confidence < 0.5) {
              lowAccuracyFlags.push({
                name: r.name || r.id || 'Unknown',
                employeeNo: r.employeeNo || '',
                homeroom: r.homeroom || '',
                date,
                timestamp: r.timestamp || '',
                confidence: parseFloat(r.confidence.toFixed(3)),
              });
            }
          }
        }
      }
    }

    // Sort daily trends by date
    dailyTrends.sort((a, b) => a.date.localeCompare(b.date));

    // Fill in zero-data days for complete series
    const fullTrends = allDates.map((date) => {
      const found = dailyTrends.find((d) => d.date === date);
      return found || { date, total: 0, present: 0, late: 0 };
    });

    // Get enrolled student count
    // (already fetched above as studentsSnap)

    // Summary
    const totalScans = allRecords.length;
    const totalPresent = allRecords.filter((r) => r.status === 'Present').length;
    const totalLate = allRecords.filter((r) => r.status === 'Late').length;
    const daysWithData = datesToFetch.length;

    // Avg attendance rate: across days that have data, what % are present+late out of enrolled
    let avgAttendanceRate = 0;
    if (daysWithData > 0 && enrolledStudents > 0) {
      const rates = dailyTrends.map((d) => (d.total / enrolledStudents) * 100);
      avgAttendanceRate = parseFloat((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1));
    } else if (daysWithData > 0) {
      // Fallback: just use the average daily total
      avgAttendanceRate = 100;
    }

    // Class rates sorted by attendance rate descending
    const classRates = Object.entries(classMap)
      .map(([homeroom, stats]) => ({
        homeroom,
        ...stats,
        rate: parseFloat(((stats.present / Math.max(stats.total, 1)) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.rate - a.rate || b.total - a.total);

    // Hourly distribution (full 0-23)
    const hourlyDistribution = [];
    for (let h = 0; h < 24; h++) {
      hourlyDistribution.push({ hour: h, count: hourlyMap[h] || 0 });
    }

    return res.status(200).json({
      range: { from: fromDate, to: toDate, days },
      dailyTrends: fullTrends,
      summary: {
        avgAttendanceRate,
        totalScans,
        totalPresent,
        totalLate,
        enrolledStudents,
        daysWithData,
        avgDaily: daysWithData > 0 ? Math.round(totalScans / daysWithData) : 0,
      },
      classRates,
      hourlyDistribution,
      accuracy: {
        avg: confidenceValues.length > 0 ? parseFloat((confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length * 100).toFixed(1)) : null,
        min: confidenceValues.length > 0 ? parseFloat((Math.min(...confidenceValues) * 100).toFixed(1)) : null,
        max: confidenceValues.length > 0 ? parseFloat((Math.max(...confidenceValues) * 100).toFixed(1)) : null,
        scansWithConfidence: confidenceValues.length,
        distribution: {
          below50: confidenceValues.filter((v) => v < 0.5).length,
          '50to80': confidenceValues.filter((v) => v >= 0.5 && v < 0.8).length,
          '80to95': confidenceValues.filter((v) => v >= 0.8 && v < 0.95).length,
          above95: confidenceValues.filter((v) => v >= 0.95).length,
        },
      },
      lowAccuracyFlags: lowAccuracyFlags.sort((a, b) => a.confidence - b.confidence),
    });
  } catch (error) {
    console.error('Analytics API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

export default withAuth(withMetrics(handler));
