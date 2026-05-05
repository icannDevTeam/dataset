/**
 * POST /api/pickup/admin/officer-override
 *
 * Officer types the 6-digit overrideCode shown on the TV card; if it matches
 * the latest non-OK pickup_event in the last 10 minutes, the event is flipped
 * to "approved by officer" — TV repaints the band and gate-officer can let
 * the chaperone through.
 *
 * Body: { code, officer, note?, tenant? }
 *
 * Returns: { ok, eventId, chaperone, gate }
 */
import admin from 'firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { verifyCookie } from '../../auth/session';
const { runOfficerOverride } = require('../../../../lib/officer-override-core.cjs');
const tenancy = require('../../../../lib/tenancy');

const TEACHER_EMAIL_DOMAIN = (process.env.TEACHER_EMAIL_DOMAIN || 'binus.edu').toLowerCase();

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';').map((p) => p.trim());
  for (const p of parts) {
    if (!p.startsWith(`${name}=`)) continue;
    return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { code, officer, note, tenant } = req.body || {};
  if (!code || !/^\d{6}$/.test(String(code))) {
    return res.status(400).json({ error: 'code must be a 6-digit number' });
  }
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenant || tenancy.getTenantId();

  const sessionMarker = readCookie(req, '__session');
  const session = sessionMarker ? verifyCookie(sessionMarker) : null;

  const result = await runOfficerOverride({
    session,
    code,
    officer,
    note,
    db,
    tid,
    pickupEventsPath: tenancy.pickupEventsPath,
    securityIncidentsPath: tenancy.securityIncidentsPath,
    teacherDomain: TEACHER_EMAIL_DOMAIN,
  });

  // Strip internal test field before sending
  const { _override: _, ...responseBody } = result.body;
  return res.status(result.statusCode).json(responseBody);
}

export default withAuth(handler, { methods: ['POST'] });
