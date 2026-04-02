/**
 * POST /api/hikvision/sync
 *
 * Pull missed face-verification events from a Hikvision device and
 * write them to Firestore + local attendance records. This is the
 * dashboard equivalent of `attendance_listener.py --catchup`.
 *
 * Only works on devices that support AcsEvent search (DS-K1T342MFX).
 *
 * Body: { ip, username, password, dates?: string[] }
 *   - dates: array of "YYYY-MM-DD" strings. Defaults to today (WIB).
 *
 * Returns: { synced, skipped, errors, details: [...] }
 */

import { hikJson, isAllowedDeviceIP } from '../../../lib/hikvision';
import { initializeFirebase, getFirebaseAdmin } from '../../../lib/firebase-admin';
import { withMetrics } from '../../../lib/metrics';

const WIB_OFFSET = 7 * 3600 * 1000;
const CUTOFF_HOUR = 7;
const CUTOFF_MINUTE = 30;
const FACE_EVENT_MINORS = [75, 76, 104];

function getWIBNow() {
  return new Date(Date.now() + WIB_OFFSET);
}

function todayWIB() {
  return getWIBNow().toISOString().slice(0, 10);
}

function determineStatus(timeStr) {
  try {
    const dt = new Date(timeStr);
    const h = dt.getHours !== undefined ? dt.getUTCHours() : 0;
    const m = dt.getMinutes !== undefined ? dt.getUTCMinutes() : 0;
    // Parse the +07:00 time directly
    const match = timeStr.match(/T(\d{2}):(\d{2})/);
    if (match) {
      const hour = parseInt(match[1], 10);
      const min = parseInt(match[2], 10);
      if (hour > CUTOFF_HOUR || (hour === CUTOFF_HOUR && min > CUTOFF_MINUTE)) {
        return 'Late';
      }
    }
    return 'Present';
  } catch {
    return 'Present';
  }
}

function formatTimestamp(isoStr) {
  // "2026-04-02T08:20:03+07:00" → "2026-04-02 08:20:03"
  const match = isoStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : isoStr;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ip, username, password, dates } = req.body;

  if (!ip || !username || !password) {
    return res.status(400).json({ error: 'Missing device credentials (ip, username, password)' });
  }

  if (!isAllowedDeviceIP(ip)) {
    return res.status(400).json({ error: 'Invalid device IP. Only private LAN addresses are allowed.' });
  }

  const device = { ip, username, password };
  const targetDates = Array.isArray(dates) && dates.length > 0 ? dates : [todayWIB()];

  // Validate date formats
  for (const d of targetDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return res.status(400).json({ error: `Invalid date format: ${d}. Use YYYY-MM-DD.` });
    }
  }

  // Cap at 30 days to prevent abuse
  if (targetDates.length > 30) {
    return res.status(400).json({ error: 'Maximum 30 days per sync request.' });
  }

  // Test if device supports event search
  try {
    await hikJson(device, 'post', '/ISAPI/AccessControl/AcsEvent?format=json', {
      AcsEventCond: {
        searchID: 'probe',
        searchResultPosition: 0,
        maxResults: 1,
        major: 5,
        minor: 0,
        startTime: `${targetDates[0]}T00:00:00+07:00`,
        endTime: `${targetDates[0]}T23:59:59+07:00`,
      },
    });
  } catch {
    return res.status(200).json({
      supported: false,
      synced: 0,
      skipped: 0,
      errors: 0,
      message: 'This device does not support event search. Catch-up sync unavailable.',
      details: [],
    });
  }

  // Initialize Firebase
  try {
    initializeFirebase();
  } catch (e) {
    return res.status(500).json({ error: 'Firebase initialization failed', details: e.message });
  }

  const admin = getFirebaseAdmin();
  const db = admin.firestore();

  // Load student metadata for enrichment
  let studentMeta = {};
  try {
    const metaSnap = await db.collection('student_metadata').get();
    metaSnap.forEach((doc) => {
      studentMeta[doc.id] = doc.data();
    });
  } catch {
    // Non-fatal
  }

  const details = [];
  let totalSynced = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const dateStr of targetDates) {
    const startTime = `${dateStr}T00:00:00+07:00`;
    const endTime = `${dateStr}T23:59:59+07:00`;

    // Load existing records for this date to check what's already in Firestore
    const existingEmpNos = new Set();
    try {
      const recsSnap = await db.collection('attendance').doc(dateStr).collection('records').get();
      recsSnap.forEach((doc) => existingEmpNos.add(doc.id));
    } catch {
      // Empty day
    }

    // Paginate through device events
    let pos = 0;
    const batchSize = 30;
    let synced = 0;
    let skipped = 0;
    let errors = 0;
    const seenEmpNos = new Set();

    while (true) {
      let data;
      try {
        data = await hikJson(device, 'post', '/ISAPI/AccessControl/AcsEvent?format=json', {
          AcsEventCond: {
            searchID: `sync_${dateStr}`,
            searchResultPosition: pos,
            maxResults: batchSize,
            major: 5,
            minor: 0,
            startTime,
            endTime,
          },
        });
      } catch (e) {
        errors++;
        details.push({ date: dateStr, error: e.message });
        break;
      }

      const acs = data?.AcsEvent || {};
      const events = acs.InfoList || [];
      const total = acs.totalMatches || 0;

      if (!events.length) break;

      for (const evt of events) {
        if (!FACE_EVENT_MINORS.includes(evt.minor)) continue;

        const empNo = evt.employeeNoString || String(evt.employeeNo || '');
        const name = evt.name || '';
        if (!empNo || !name) continue;

        // First occurrence only (earliest scan per student)
        if (seenEmpNos.has(empNo)) continue;
        seenEmpNos.add(empNo);

        // Skip if already in Firestore
        if (existingEmpNos.has(empNo)) {
          skipped++;
          continue;
        }

        const eventTime = evt.time || '';
        const timestamp = formatTimestamp(eventTime);
        const status = determineStatus(eventTime);

        // Enrich with metadata
        const meta = studentMeta[empNo] || {};
        const homeroom = meta.homeroom || '';
        const grade = meta.grade || '';

        try {
          const docRef = db.collection('attendance').doc(dateStr).collection('records').doc(empNo);
          await docRef.set({
            name,
            employeeNo: empNo,
            timestamp,
            status,
            late: status === 'Late',
            homeroom,
            grade,
            source: 'hikvision_catchup',
            updatedAt: getWIBNow().toISOString(),
          });
          // Update day summary
          await db.collection('attendance').doc(dateStr).set(
            { lastUpdated: getWIBNow().toISOString() },
            { merge: true }
          );
          synced++;
          existingEmpNos.add(empNo);
        } catch (e) {
          errors++;
        }
      }

      pos += events.length;
      if (acs.responseStatusStrg !== 'MORE' || pos >= total) break;
    }

    totalSynced += synced;
    totalSkipped += skipped;
    totalErrors += errors;

    details.push({
      date: dateStr,
      deviceEvents: seenEmpNos.size,
      synced,
      skipped,
      alreadyRecorded: existingEmpNos.size,
    });
  }

  return res.status(200).json({
    supported: true,
    synced: totalSynced,
    skipped: totalSkipped,
    errors: totalErrors,
    details,
  });
}

export default withMetrics(handler);
