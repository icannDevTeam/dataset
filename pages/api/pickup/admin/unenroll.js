/**
 * POST /api/pickup/admin/unenroll
 *
 * Remove already-enrolled chaperones from Hikvision terminals — deletes the
 * face record AND the access-control user (revokes door rights). Built for
 * cleaning up mistaken enrolments (e.g. parents who uploaded an ID card
 * instead of a face photo).
 *
 * Body: {
 *   chaperoneIds: string[],   // required
 *   deviceIps?:   string[],   // optional — restrict to specific terminals;
 *                             // omitted = remove from EVERY configured device
 *   tenant?:      string,
 * }
 *
 * Response: { ok, summary: [{chaperoneId, ok, devices, error?}] }
 *
 * Permission: pickup_admin.delete_face (destructive device operation).
 */
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';
import { unenrollChaperone } from '../../../../lib/chaperone-enroll';

const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { chaperoneIds, deviceIps, tenant } = req.body || {};
  const tid = tenant ? String(tenant) : tenancy.getTenantId();

  const ids = Array.isArray(chaperoneIds) ? chaperoneIds.map(String).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'chaperoneIds required' });
  if (ids.length > 25) return res.status(400).json({ error: 'too_many', message: 'Maximum 25 chaperones per request.' });

  const opts = {};
  if (Array.isArray(deviceIps) && deviceIps.length > 0) {
    opts.deviceIps = deviceIps.map(String).filter(Boolean);
  }

  try {
    initializeFirebase();
    const db = admin.firestore();

    const summary = [];
    for (const id of ids) {
      try {
        const r = await unenrollChaperone(db, tid, id, opts);
        summary.push({ chaperoneId: id, ok: r.ok, devices: r.devices, ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) });
      } catch (e) {
        summary.push({ chaperoneId: id, ok: false, error: e.message });
      }
    }

    await logAudit(db, {
      tenantId: tid, req,
      actor: {
        email: req.user?.email || null,
        name: req.user?.name || null,
        role: req.user?.role || 'admin',
      },
      kind: 'chaperone.unenroll',
      target: { type: 'chaperone', id: ids.join(','), label: `${ids.length} chaperone(s)` },
      after: { chaperoneIds: ids, deviceIps: opts.deviceIps || 'ALL', summary },
      summary: `Removed ${ids.length} chaperone(s) from ${opts.deviceIps ? opts.deviceIps.length + ' terminal(s)' : 'ALL terminals'}`,
    });

    return res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error('[pickup/admin/unenroll]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['POST'], permission: 'pickup_admin.delete_face' });
