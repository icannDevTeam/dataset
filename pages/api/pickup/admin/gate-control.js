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
const { terminalGateStatus, isValidHHMM } = require('../../../../lib/terminal-gate');

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

      const ref = termsRef.doc(String(tidParam));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'terminal not found' });

      const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

      // Schedule edits (optional)
      if (req.body?.windowOpen !== undefined) {
        if (req.body.windowOpen && !isValidHHMM(req.body.windowOpen)) {
          return res.status(400).json({ error: 'windowOpen must be HH:MM' });
        }
        patch.windowOpen = req.body.windowOpen || null;
      }
      if (req.body?.windowClose !== undefined) {
        if (req.body.windowClose && !isValidHHMM(req.body.windowClose)) {
          return res.status(400).json({ error: 'windowClose must be HH:MM' });
        }
        patch.windowClose = req.body.windowClose || null;
      }

      // Manual override (optional, but typical for this endpoint)
      if (val !== undefined) {
        if (val !== 'open' && val !== 'closed' && val !== null) {
          return res.status(400).json({ error: 'gateOverride must be "open", "closed", or null' });
        }
        patch.gateOverride = val;
        patch.gateOverrideAt = admin.firestore.FieldValue.serverTimestamp();
        patch.gateOverrideBy = req.user?.email || req.user?.username || 'admin';
      }

      await ref.set(patch, { merge: true });
      const updated = (await ref.get()).data();
      const eff = terminalGateStatus(updated);
      return res.status(200).json({
        ok: true,
        terminalId: tidParam,
        gateOverride: updated.gateOverride || null,
        windowOpen: updated.windowOpen || null,
        windowClose: updated.windowClose || null,
        effective: eff,
      });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

    const snap = await termsRef.orderBy('name').get();
    const profiles = snap.docs.map((d) => {
      const t = d.data();
      if (t.enabled === false) return null;
      const status = terminalGateStatus(t);
      return {
        id: d.id,
        name: t.name || d.id,
        gates: [t.gateLabel || t.name || d.id],
        override: status.manualOverride,
        scheduled: status.scheduled,
        effective: { open: status.open, manualOverride: status.manualOverride, reason: status.reason },
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
