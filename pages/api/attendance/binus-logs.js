/**
 * POST /api/attendance/binus-logs
 *
 * Proxies the BINUS School API (D.2) to retrieve student attendance logs.
 * Authenticates with the same API_KEY used for student lookup.
 *
 * Body:
 *   { startDate, endDate, idStudent?, idBinusian? }
 *
 * Response:
 *   { success, records: [...], totalRecords, dateRange }
 */

import axios from 'axios';
import { withMetrics, trackExternalCall } from '../../../lib/metrics';

const BINUS_TOKEN_URL = 'https://binusian.ws/binusschool/auth/token';
const BINUS_ATTENDANCE_URL = 'https://binusian.ws/binusschool/bss-get-simprug-attendance-fr';

// Sanitize optional ID fields
function sanitizeOptionalId(input) {
  if (!input || typeof input !== 'string') return '';
  const str = input.trim();
  if (str.length === 0) return '';
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(str)) return null; // invalid
  return str;
}

// Validate date string (YYYY-MM-DD or ISO datetime)
function isValidDate(str) {
  if (!str || typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error — API_KEY not set' });
  }

  const { startDate, endDate, idStudent, idBinusian } = req.body || {};

  // Validate dates
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate are required' });
  }
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD or ISO datetime.' });
  }

  // Validate optional filters
  const cleanStudentId = sanitizeOptionalId(idStudent);
  const cleanBinusianId = sanitizeOptionalId(idBinusian);
  if (cleanStudentId === null) {
    return res.status(400).json({ error: 'Invalid idStudent format' });
  }
  if (cleanBinusianId === null) {
    return res.status(400).json({ error: 'Invalid idBinusian format' });
  }

  try {
    // Step 1: Get auth token
    const tokenTimer = trackExternalCall('binus-api', 'auth-token');
    let token;
    try {
      const tokenRes = await axios.get(BINUS_TOKEN_URL, {
        headers: {
          'Authorization': `Basic ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
      token = tokenRes.data?.data?.token ||
              tokenRes.data?.token ||
              tokenRes.data?.access_token;
      tokenTimer();
    } catch (err) {
      tokenTimer({ error: true });
      console.error('BINUS token error:', err.message);
      return res.status(502).json({ error: 'Failed to authenticate with BINUS API', details: err.message });
    }

    if (!token) {
      return res.status(502).json({ error: 'No token received from BINUS API' });
    }

    // Step 2: Call D.2 attendance log endpoint
    // Format dates as ISO datetime strings
    const start = new Date(startDate);
    const end = new Date(endDate);
    // Ensure end date covers the full day
    if (endDate.length === 10) {
      end.setHours(23, 59, 59, 999);
    }

    const body = {
      StartDate: start.toISOString().replace('Z', ''),
      EndDate: end.toISOString().replace('Z', ''),
      IdStudent: cleanStudentId,
      IdBinusian: cleanBinusianId,
    };

    const logTimer = trackExternalCall('binus-api', 'attendance-logs');
    let logRes;
    try {
      logRes = await axios.post(BINUS_ATTENDANCE_URL, body, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000, // attendance logs can be large
      });
      logTimer();
    } catch (err) {
      logTimer({ error: true });
      console.error('BINUS attendance log error:', err.message);

      if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        return res.status(504).json({ error: 'BINUS API timeout — try a shorter date range' });
      }
      return res.status(502).json({ error: 'Failed to fetch attendance logs', details: err.message });
    }

    const data = logRes.data;

    if (data?.resultCode !== 200) {
      return res.status(502).json({
        error: 'BINUS API returned error',
        resultCode: data?.resultCode,
        errorMessage: data?.errorMessage,
      });
    }

    const records = data.attendanceFaceRecognitionResponse || [];

    // Enrich records with parsed date
    const enriched = records.map(r => ({
      idStudent: r.idStudent || '',
      idBinusian: r.idBinusian || '',
      transactionDate: r.transactionDate || '',
      date: r.transactionDate ? r.transactionDate.slice(0, 10) : '',
      time: r.transactionDate ? r.transactionDate.slice(11, 19) : '',
      imageDesc: r.imageDesc || '-',
      userIn: r.userIn || '',
      dateIn: r.dateIn || '',
      stsrc: r.stsrc ?? null,
    }));

    // Sort by transactionDate descending (newest first)
    enriched.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));

    return res.status(200).json({
      success: true,
      totalRecords: enriched.length,
      dateRange: {
        start: start.toISOString().slice(0, 10),
        end: new Date(endDate.length === 10 ? endDate : end.toISOString()).toISOString().slice(0, 10),
      },
      records: enriched,
    });
  } catch (err) {
    console.error('Attendance log handler error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

export default withMetrics(handler);
