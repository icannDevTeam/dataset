/**
 * GET /api/pickup/admin/kiosk-status
 *
 * Returns the kiosk token + a small live status object for each kiosk profile
 * so the admin dashboard can build copy-ready URLs and show live activity.
 *
 * Response: {
 *   ok: true,
 *   token: "<PICKUP_TV_TOKEN>",
 *   origin: "<request origin>",
 *   gateOptions: ["..."],
 *   profiles: [
 *     { id, name, gates, homerooms, showQueue, maxCards, beepEnabled, accent,
 *       liveCount, lastEventAt }
 *   ],
 * }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
const tenancy = require('../../../../lib/tenancy');
const kp = require('../../../../lib/kiosk-profiles');

const WINDOW_MS = 30 * 60 * 1000;

async function handler(req, res) {
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

  initializeFirebase();
  const db = admin.firestore();

  // Load profiles
  const psnap = await db.collection(kp.kioskProfilesPath(tid)).orderBy('name').get();
  const profiles = psnap.docs.map((d) => kp.normalizeProfile(d.id, d.data()));

  // Load recent events (single read used to compute counts for every profile)
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - WINDOW_MS);
  const esnap = await db.collection(tenancy.pickupEventsPath(tid))
    .where('recordedAt', '>', cutoff)
    .orderBy('recordedAt', 'desc')
    .limit(200)
    .get();
  const events = esnap.docs.map((d) => d.data());

  // Build gate suggestions from real events + Hikvision device list (if any)
  const gateSet = new Set();
  events.forEach((e) => { if (e.gate) gateSet.add(e.gate); });
  try {
    const dsnap = await db.collection(`${tenancy.tenantDoc(tid)}/devices`).get();
    dsnap.docs.forEach((d) => {
      const x = d.data() || {};
      if (x.name) gateSet.add(x.name);
      if (x.deviceName) gateSet.add(x.deviceName);
    });
  } catch {}
  // Static fallback so cold-start admins still see options
  ['Basement 1 Terminal (DS-K1T341AMF)',
   'PYP Lobby Entrance (DS-K1T342MFX)',
   'MYP Tower (DS-K1T342MFX)'].forEach((g) => gateSet.add(g));

  // Per-profile live count
  const enriched = profiles.map((p) => {
    let liveCount = 0;
    let lastEventAt = null;
    for (const e of events) {
      if (kp.eventMatchesProfile({ ...e, students: e.students || [] }, p)) {
        liveCount += 1;
        const ts = e.recordedAt?.toDate ? e.recordedAt.toDate() : null;
        if (ts && (!lastEventAt || ts > lastEventAt)) lastEventAt = ts;
      }
    }
    return { ...p, liveCount, lastEventAt: lastEventAt ? lastEventAt.toISOString() : null };
  });

  const totalLive = events.length;
  const origin = req.headers.origin || (req.headers.host ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` : '');

  return res.status(200).json({
    ok: true,
    token: process.env.PICKUP_TV_TOKEN || '',
    origin,
    tenant: tid,
    totalLive,
    gateOptions: [...gateSet].sort(),
    profiles: enriched,
  });
}

export default withAuth(handler, { methods: ['GET'] });
