/**
 * GET /api/pickup/admin/analytics
 *
 * Pickup event analytics aggregated from pickup_events collection.
 *
 * Aggregation logic lives in `lib/pickup-analytics.js` so that the export
 * endpoint (./export.js) can reuse the exact same shape without an internal
 * HTTP round-trip.
 *
 * Query params:
 *   from     YYYY-MM-DD  (default: today WIB)
 *   to       YYYY-MM-DD  (default: today WIB)
 *   tenant   string      (optional)
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const { computePickupAnalytics } = require('../../../../lib/pickup-analytics');

function getWIBToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function parseDate(str, fallback) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return fallback;
  const d = new Date(str + 'T00:00:00Z');
  return isNaN(d.getTime()) ? fallback : str;
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const today = getWIBToday();
  const from = parseDate(req.query.from, today);
  const to   = parseDate(req.query.to,   today);
  const tid  = tenancy.getTenantId(req.query.tenant);

  try {
    initializeFirebase();
    const db = admin.firestore();
    const data = await computePickupAnalytics(db, tid, { from, to });
    return res.status(200).json({ ok: true, ...data });
  } catch (err) {
    console.error('[pickup/admin/analytics]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['GET'], permission: 'analytics.view' });
