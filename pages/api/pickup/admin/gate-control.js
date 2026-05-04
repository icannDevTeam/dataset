/**
 * GET  /api/pickup/admin/gate-control
 *   Returns current gate state: schedule-computed + manual override.
 *   Response: { ok, gateOverride, profiles: [{ id, name, scheduled, effective }] }
 *
 * POST /api/pickup/admin/gate-control
 *   Body: { gateOverride: 'open' | 'closed' | null }
 *   null = clear override → gate follows the time schedule again.
 *   Stores in tenants/{tid}/settings/pickup.gateOverride
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const kp     = require('../../../../lib/kiosk-profiles');

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method' });
  }

  try {
    initializeFirebase();
    const db  = admin.firestore();
    const tid = tenancy.getTenantId();
    const settingsRef = db.doc(tenancy.pickupSettingsDoc(tid));

    if (req.method === 'POST') {
      const val = req.body?.gateOverride;
      if (val !== 'open' && val !== 'closed' && val !== null) {
        return res.status(400).json({ error: 'gateOverride must be "open", "closed", or null' });
      }
      await settingsRef.set(
        { gateOverride: val === null ? admin.firestore.FieldValue.delete() : val },
        { merge: true },
      );
      return res.status(200).json({ ok: true, gateOverride: val });
    }

    // GET — read settings + all kiosk profiles so admin sees per-profile status
    const [settingsSnap, profilesSnap] = await Promise.all([
      settingsRef.get(),
      db.collection(kp.kioskProfilesPath(tid)).get(),
    ]);

    const settings     = settingsSnap.exists ? settingsSnap.data() : {};
    const gateOverride = settings.gateOverride || null;   // 'open' | 'closed' | null
    const now          = new Date();

    const profiles = profilesSnap.docs.map((d) => {
      const profile   = kp.normalizeProfile(d.id, d.data());
      const scheduled = kp.gateStatus(profile, now);
      const effective = gateOverride
        ? { ...scheduled, open: gateOverride === 'open', manualOverride: gateOverride }
        : { ...scheduled, manualOverride: null };
      return { id: d.id, name: profile.name, scheduled, effective };
    });

    return res.status(200).json({ ok: true, gateOverride, profiles, serverTime: now.toISOString() });
  } catch (e) {
    console.error('[pickup/admin/gate-control]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
