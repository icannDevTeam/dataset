/**
 * POST /api/hikvision/events
 *
 * Query stored events from a Hikvision device's local event log.
 * Only works on devices that support AcsEvent search (DS-K1T342MFX).
 *
 * Body: { ip, username, password, date?, startTime?, endTime?, page?, pageSize? }
 * Returns: { supported, totalEvents, events: [...], page, pageSize }
 */

import { hikJson, isAllowedDeviceIP } from '../../../lib/hikvision';
import { withMetrics } from '../../../lib/metrics';

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ip, username, password, date, startTime, endTime, page = 0, pageSize = 30 } = req.body;

  if (!ip || !username || !password) {
    return res.status(400).json({ error: 'Missing device credentials (ip, username, password)' });
  }

  if (!isAllowedDeviceIP(ip)) {
    return res.status(400).json({ error: 'Invalid device IP. Only private LAN addresses are allowed.' });
  }

  const device = { ip, username, password };

  // Build time range
  const targetDate = date || new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const start = startTime || `${targetDate}T00:00:00+07:00`;
  const end = endTime || `${targetDate}T23:59:59+07:00`;

  const clampedPageSize = Math.min(Math.max(1, pageSize), 100);
  const position = page * clampedPageSize;

  try {
    const data = await hikJson(device, 'post', '/ISAPI/AccessControl/AcsEvent?format=json', {
      AcsEventCond: {
        searchID: 'dashboard',
        searchResultPosition: position,
        maxResults: clampedPageSize,
        major: 5,
        minor: 0,
        startTime: start,
        endTime: end,
      },
    });

    const acs = data?.AcsEvent || {};
    const total = acs.totalMatches || 0;
    const rawEvents = acs.InfoList || [];

    const events = rawEvents.map((evt) => ({
      time: evt.time || '',
      major: evt.major,
      minor: evt.minor,
      name: evt.name || '',
      employeeNo: evt.employeeNoString || String(evt.employeeNo || ''),
      cardReaderNo: evt.cardReaderNo || 0,
      doorNo: evt.doorNo || 0,
      mask: evt.mask || '',
      verifyMode: evt.currentVerifyMode || '',
      // Classify event type
      type:
        evt.minor === 75 ? 'face_match' :
        evt.minor === 76 ? 'face_verify' :
        evt.minor === 104 ? 'face_recognize' :
        evt.minor === 22 ? 'door_open' :
        evt.minor === 21 ? 'door_close' :
        `event_${evt.minor}`,
      isFaceEvent: [75, 76, 104].includes(evt.minor),
    }));

    return res.status(200).json({
      supported: true,
      date: targetDate,
      startTime: start,
      endTime: end,
      totalEvents: total,
      events,
      page,
      pageSize: clampedPageSize,
      hasMore: acs.responseStatusStrg === 'MORE',
    });
  } catch (err) {
    // If device doesn't support event search
    if (err.response?.status === 403 || err.response?.status === 400) {
      return res.status(200).json({
        supported: false,
        date: targetDate,
        totalEvents: 0,
        events: [],
        message: 'This device does not support event search (AcsEvent API).',
      });
    }
    console.error('Events error:', err.message);
    return res.status(500).json({
      error: 'Failed to query device events',
      details: err.message,
    });
  }
}

export default withMetrics(handler);
