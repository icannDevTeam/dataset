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
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const { terminalGateStatus, effectiveGateStatus, isValidHHMM } = require('../../../../lib/terminal-gate');

function terminalNaturalCompare(aName, bName) {
  const a = String(aName || '').trim();
  const b = String(bName || '').trim();
  const am = a.match(/^Terminal\s+(\d+)$/i);
  const bm = b.match(/^Terminal\s+(\d+)$/i);
  if (am && bm) {
    const an = parseInt(am[1], 10);
    const bn = parseInt(bm[1], 10);
    if (an !== bn) return an - bn;
  }
  if (am && !bm) return -1;
  if (!am && bm) return 1;
  return a.localeCompare(b);
}

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
      // Pull the bound release group (if any) so overrides for today take effect.
      let groupData = null;
      if (updated.releaseGroupId) {
        const g = await db.doc(tenancy.releaseGroupDoc(updated.releaseGroupId, tid)).get();
        if (g.exists) groupData = g.data();
      }
      let settingsData = null;
      try {
        const s = await db.doc(tenancy.pickupSettingsDoc(tid)).get();
        if (s.exists) settingsData = s.data();
      } catch { settingsData = null; }
      const eff = effectiveGateStatus(updated, groupData, new Date(), settingsData);
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

    const snap = await termsRef.get();
    // Preload release groups once so per-terminal lookup is O(1).
    const groupsSnap = await db.collection(tenancy.releaseGroupsPath(tid)).get();
    const groupById = new Map();
    groupsSnap.docs.forEach((g) => groupById.set(g.id, g.data()));
    let settingsData = null;
    try {
      const s = await db.doc(tenancy.pickupSettingsDoc(tid)).get();
      if (s.exists) settingsData = s.data();
    } catch { settingsData = null; }
    const profiles = snap.docs.map((d) => {
      const t = d.data();
      if (t.enabled === false) return null;
      const groupData = t.releaseGroupId ? (groupById.get(t.releaseGroupId) || null) : null;
      const status = effectiveGateStatus(t, groupData, new Date(), settingsData);
      return {
        id: d.id,
        name: t.name || d.id,
        gates: [t.gateLabel || t.name || d.id],
        override: status.manualOverride,
        scheduled: status.scheduled,
        effective: { open: status.open, manualOverride: status.manualOverride, reason: status.reason, override: status.override || null },
      };
    }).filter(Boolean).sort((a, b) => terminalNaturalCompare(a.name, b.name));

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

export default withApi(handler, { methods: ['GET', 'POST'], permission: 'pickup_admin.gate_control' });
