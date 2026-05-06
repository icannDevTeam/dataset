/**
 * GET  /api/pickup/admin/gate-control
 *   Per-terminal gate control. Each Hikvision face terminal in the registry
 *   may carry a manual `gateOverride` of 'open' | 'closed' | null.
 *
 *   Response (legacy `profiles[]` key kept so the existing
 *   pages/v2/officer-overrides GateControlPanel works unchanged):
 *   {
 *     ok, serverTime,
 *     profiles: [
 *       { id, name, gates:[gateLabel||name], override,
 *         scheduled: {configured:false, opensAt:'', closesAt:'', open:true},
 *         effective: {open, manualOverride} }
 *     ]
 *   }
 *
 * POST /api/pickup/admin/gate-control
 *   Body: { profileId|terminalId, gateOverride: 'open'|'closed'|null }
 *   Writes `tenants/{t}/terminals/{terminalId}.gateOverride`. The Pandora-Linux
 *   listener consults this before issuing a door-relay command.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
const tenancy = require('../../../../lib/tenancy');

async function handler(req, res) {
  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const termsRef = db.collection(tenancy.terminalsPath(tid));

    if (req.method === 'POST') {
      const val = req.body?.gateOverride;
      const tidParam = req.body?.terminalId || req.body?.profileId;
      if (!tidParam) return res.status(400).json({ error: 'terminalId required' });
      if (val !== 'open' && val !== 'closed' && val !== null) {
        return res.status(400).json({ error: 'gateOverride must be "open", "closed", or null' });
      }
      const ref = termsRef.doc(String(tidParam));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'terminal not found' });
      await ref.set({
        gateOverride: val,
        gateOverrideAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.status(200).json({ ok: true, terminalId: tidParam, gateOverride: val });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

    const snap = await termsRef.orderBy('name').get();
    const profiles = snap.docs.map((d) => {
      const t = d.data();
      if (t.enabled === false) return null;
      const override = t.gateOverride === 'open' || t.gateOverride === 'closed' ? t.gateOverride : null;
      const open = override ? override === 'open' : true;
      return {
        id: d.id,
        name: t.name || d.id,
        gates: [t.gateLabel || t.name || d.id],
        override,
        scheduled: { configured: false, opensAt: '', closesAt: '', open: true },
        effective: { open, manualOverride: override },
      };
    }).filter(Boolean);

    return res.status(200).json({
      ok: true,
      serverTime: new Date().toISOString(),
      profiles,
    });
  } catch (e) {
    console.error('[pickup/admin/gate-control]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withAuth(handler, { methods: ['GET', 'POST'] });
