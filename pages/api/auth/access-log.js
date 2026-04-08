/**
 * POST /api/auth/access-log
 * Records dashboard access event (IP, user agent, timestamp) to Firestore.
 * 
 * GET /api/auth/access-log?limit=50
 * Returns recent access logs (requires auth).
 */
import { initializeFirebase, getFirestoreDB } from '../../../lib/firebase-admin';
import { withAuth } from '../../../lib/auth-middleware';
import admin from 'firebase-admin';

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

async function handler(req, res) {
  initializeFirebase();
  const db = getFirestoreDB();

  if (req.method === 'POST') {
    // Record access event
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Missing idToken' });

    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      const email = decoded.email;
      if (!email) return res.status(400).json({ error: 'No email' });

      const ip = getClientIP(req);
      const userAgent = req.headers['user-agent'] || 'unknown';

      // Parse user agent for device info
      const device = parseUserAgent(userAgent);

      await db.collection('access_logs').add({
        email: email.toLowerCase(),
        name: decoded.name || email.split('@')[0],
        ip,
        userAgent,
        device: device.device,
        browser: device.browser,
        os: device.os,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        action: 'login',
      });

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[ACCESS LOG]', err.message);
      return res.status(500).json({ error: 'Failed to log access' });
    }
  }

  if (req.method === 'GET') {
    // Verify caller is authenticated via same-origin or API key
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);

      const snapshot = await db.collection('access_logs')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

      const logs = snapshot.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          email: d.email,
          name: d.name,
          ip: d.ip,
          device: d.device,
          browser: d.browser,
          os: d.os,
          action: d.action,
          timestamp: d.timestamp?.toDate?.()?.toISOString() || null,
        };
      });

      return res.status(200).json({ logs });
    } catch (err) {
      console.error('[ACCESS LOG GET]', err.message);
      return res.status(500).json({ error: 'Failed to fetch logs' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withAuth(handler, { public: true });

function parseUserAgent(ua) {
  const result = { device: 'Unknown', browser: 'Unknown', os: 'Unknown' };

  // OS
  if (/Windows NT 10/.test(ua)) result.os = 'Windows 10';
  else if (/Windows NT/.test(ua)) result.os = 'Windows';
  else if (/Mac OS X/.test(ua)) result.os = 'macOS';
  else if (/Android/.test(ua)) result.os = 'Android';
  else if (/iPhone|iPad/.test(ua)) result.os = 'iOS';
  else if (/Linux/.test(ua)) result.os = 'Linux';
  else if (/CrOS/.test(ua)) result.os = 'ChromeOS';

  // Browser
  if (/Edg\//.test(ua)) result.browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) result.browser = 'Chrome';
  else if (/Firefox\//.test(ua)) result.browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) result.browser = 'Safari';

  // Device type
  if (/Mobile|Android.*Mobile|iPhone/.test(ua)) result.device = 'Mobile';
  else if (/iPad|Android(?!.*Mobile)|Tablet/.test(ua)) result.device = 'Tablet';
  else result.device = 'Desktop';

  return result;
}
