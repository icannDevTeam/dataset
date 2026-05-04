/**
 * GET  /api/pickup/admin/gate-control
 *   Returns current gate state: schedule-computed + manual override.
 *   Response:
 *   {
 *     ok,
 *     gateOverride,          // legacy/global override (all profiles)
 *     gateOverrides,         // per-profile map { [profileId]: 'open' | 'closed' }
 *     profiles: [{ id, name, gates, override, scheduled, effective }]
 *   }
 *
 * POST /api/pickup/admin/gate-control
 *   Body: { profileId?: string, gateOverride: 'open' | 'closed' | null }
 *   - profileId present: apply override only to that profile
 *   - profileId missing: apply legacy global override
 *   null = clear override → gate follows schedule again
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
      const profileId = req.body?.profileId ? String(req.body.profileId) : null;
      if (val !== 'open' && val !== 'closed' && val !== null) {
        return res.status(400).json({ error: 'gateOverride must be "open", "closed", or null' });
      }

      if (profileId) {
        // Per-profile override
        await settingsRef.set(
          {
            [`gateOverrides.${profileId}`]: val === null ? admin.firestore.FieldValue.delete() : val,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return res.status(200).json({ ok: true, profileId, gateOverride: val });
      }

      // Legacy/global override (applies to all profiles)
      await settingsRef.set(
        {
          gateOverride: val === null ? admin.firestore.FieldValue.delete() : val,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return res.status(200).json({ ok: true, gateOverride: val, profileId: null });
    }

    // GET — read settings + all kiosk profiles so admin sees per-profile status
    const [settingsSnap, profilesSnap] = await Promise.all([
      settingsRef.get(),
      db.collection(kp.kioskProfilesPath(tid)).get(),
    ]);

    const settings      = settingsSnap.exists ? settingsSnap.data() : {};
    const gateOverride  = settings.gateOverride || null;   // legacy/global: 'open' | 'closed' | null
    const gateOverrides = settings.gateOverrides && typeof settings.gateOverrides === 'object'
      ? settings.gateOverrides
      : {};
    const now           = new Date();

    const profiles = profilesSnap.docs.map((d) => {
      const profile   = kp.normalizeProfile(d.id, d.data());
      const override  = gateOverrides[d.id] || gateOverride || null;
      const scheduled = kp.gateStatus(profile, now);
      const effective = override
        ? { ...scheduled, open: override === 'open', manualOverride: override }
        : { ...scheduled, manualOverride: null };
      return {
        id: d.id,
        name: profile.name,
        gates: profile.gates || [],
        override,
        scheduled,
        effective,
      };
    });

    return res.status(200).json({
      ok: true,
      gateOverride,
      gateOverrides,
      profiles,
      serverTime: now.toISOString(),
    });
  } catch (e) {
    console.error('[pickup/admin/gate-control]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
