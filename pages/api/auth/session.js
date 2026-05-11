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
const { signCookie, verifyCookie: _verifyCookie, SESSION_MAX_AGE_SEC } = require('../../../lib/session-cookie');

const SESSION_MAX_AGE = SESSION_MAX_AGE_SEC; // back-compat alias

// Re-export the canonical verifier so existing imports keep working.
export const verifyCookie = _verifyCookie;

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
