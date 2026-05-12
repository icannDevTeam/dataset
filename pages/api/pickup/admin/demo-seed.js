import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const { runPickupDemoSeed } = require('../../../../lib/pickup-demo-seeder');

async function handler(req, res) {
  try {
    initializeFirebase();
    const db = admin.firestore();
    const actorEmail = String(req.user.email || '').toLowerCase();

    const tid = req.body?.tenant ? String(req.body.tenant).slice(0, 64) : tenancy.getTenantId();
    const profileId = req.body?.profileId ? String(req.body.profileId).slice(0, 64) : null;
    const profileName = req.body?.profileName ? String(req.body.profileName).slice(0, 120) : null;
    const eventCountRaw = req.body?.eventCount;
    let eventCount = null;
    if (eventCountRaw != null) {
      const n = Number(eventCountRaw);
      if (!Number.isFinite(n) || n < 1 || n > 1000) {
        return res.status(400).json({ error: 'invalid_input', details: ['eventCount: must be 1-1000'] });
      }
      eventCount = Math.floor(n);
    }

    const seed = await runPickupDemoSeed({
      db,
      tid,
      profileId,
      profileName,
      force: true,
      reason: 'manual_admin',
      actorEmail,
      eventCount,
    });

    return res.status(200).json({ ok: true, seed });
  } catch (e) {
    console.error('[pickup/admin/demo-seed]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, {
  methods: ['POST'],
  role: ['owner', 'admin'],
  rateLimit: 6,
});