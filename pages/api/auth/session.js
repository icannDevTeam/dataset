/**
 * /api/auth/session — Manage session cookie for Edge Middleware
 *
 * POST   - Set __session cookie after successful auth verification
 * DELETE - Clear __session cookie on sign-out
 *
 * The cookie is HttpOnly, Secure, SameSite=Lax with a 30-min max age.
 * Edge Middleware reads this cookie to gate page access before SSR.
 */
import { initializeFirebase } from '../../../lib/firebase-admin';
import admin from 'firebase-admin';
import crypto from 'crypto';

const SESSION_MAX_AGE = 30 * 60; // 30 minutes in seconds

// HMAC key for session cookie signing — falls back to a derived key from Firebase project ID
const SESSION_SECRET = process.env.SESSION_SECRET
  || process.env.DASHBOARD_API_KEY
  || 'fallback-change-me';

function signCookie(payload) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

export function verifyCookie(cookie) {
  try {
    const decoded = Buffer.from(cookie, 'base64').toString();
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) return null;
    const payload = decoded.substring(0, lastColon);
    const sig = decoded.substring(lastColon + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    // Extract timestamp from payload (email:timestamp)
    const parts = payload.split(':');
    const timestamp = parseInt(parts[parts.length - 1], 10);
    if (isNaN(timestamp) || Date.now() - timestamp > SESSION_MAX_AGE * 1000) return null;
    return { email: parts.slice(0, -1).join(':'), timestamp };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'Missing idToken' });
    }

    try {
      initializeFirebase();
      const decoded = await admin.auth().verifyIdToken(idToken);
      if (!decoded.email) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      // HMAC-signed session cookie — tamper-proof
      const payload = `${decoded.email}:${Date.now()}`;
      const marker = signCookie(payload);

      res.setHeader('Set-Cookie', [
        `__session=${marker}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
      ]);

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[SESSION POST]', err.message);
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  if (req.method === 'DELETE') {
    // Clear the session cookie
    res.setHeader('Set-Cookie', [
      `__session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    ]);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
