/**
 * GET/POST /api/pickup/onboarding/info
 *
 * Token-gated metadata endpoint used by the parent onboarding page to
 * render the friendly window banner ("Submissions open until 14 May
 * 17:00") and to decide whether the form should accept input at all.
 *
 * Returns:
 *   { ok, name, windowOpenAt|null, windowCloseAt|null, expiresAt|null,
 *     status: 'usable' | 'not_yet_open' | 'closed' | 'revoked' | 'expired' | 'capacity' | 'disabled' | 'unknown' }
 *
 * Rate limited (60/min/IP) — same posture as /lookup.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const { verifyPickupOnboardingToken } = require('../../../../lib/pickup-token');
const { enforceRateLimit, clientIp } = require('../../../../lib/rate-limit');
const inviteLinks = require('../../../../lib/onboarding-invites');

function reasonToStatus(reason) {
  switch (reason) {
    case 'invite_not_yet_open':     return 'not_yet_open';
    case 'invite_window_closed':    return 'closed';
    case 'invite_expired':          return 'expired';
    case 'invite_revoked':          return 'revoked';
    case 'invite_disabled':         return 'disabled';
    case 'invite_capacity_reached': return 'capacity';
    case 'invite_not_found':        return 'unknown';
    default:                        return 'unknown';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const rl = enforceRateLimit('pickup:onboarding-info', clientIp(req), { max: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  const token = (req.method === 'GET' ? req.query.token : req.body?.token) || '';
  const claims = verifyPickupOnboardingToken(String(token));
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });

  // Tokens without a link-id are legacy / unmanaged: usable until exp.
  if (!claims.lid) {
    return res.status(200).json({
      ok: true,
      name: null,
      windowOpenAt: null,
      windowCloseAt: null,
      expiresAt: claims.exp ? claims.exp * 1000 : null,
      status: 'usable',
    });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const inv = await inviteLinks.getInvite(db, claims.tid, claims.lid);
    if (!inv) {
      return res.status(200).json({
        ok: true, name: null, windowOpenAt: null, windowCloseAt: null,
        expiresAt: null, status: 'unknown',
      });
    }
    const usable = await inviteLinks.assertInviteUsable(db, claims.tid, claims.lid);
    return res.status(200).json({
      ok: true,
      name: inv.name || null,
      windowOpenAt: inv.windowOpenAt || null,
      windowCloseAt: inv.windowCloseAt || null,
      expiresAt: inv.expiresAt || null,
      status: usable.ok ? 'usable' : reasonToStatus(usable.reason),
    });
  } catch (err) {
    console.error('[pickup/onboarding/info]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
}
