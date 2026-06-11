/**
 * GET /api/pickup/admin/devices-status
 *
 * Combined registry of all paired/known devices across three collections:
 *   - tv_devices      (FireTV / kiosk screens at each gate)
 *   - tablet_devices  (iPads / Android tablets for teacher release flow)
 *   - terminals       (Hikvision face terminals — hardware scanners)
 *
 * Returns one unified list sorted by device type then name.
 *
 * Response:
 * {
 *   ok: true,
 *   generatedAt: ISO,
 *   summary: { tvTotal, tvPaired, tabletTotal, tabletPaired, terminalTotal, terminalEnabled },
 *   devices: [{
 *     id, type: 'tv'|'tablet'|'terminal',
 *     name, gate, grade,
 *     status: 'paired'|'unpaired'|'enabled'|'disabled'|'revoked',
 *     heartbeatAt: ISO|null,     // last seen / last heartbeat
 *     msSinceHeartbeat: number|null,
 *     online: boolean,           // heartbeat < 2 minutes
 *     profileId: string|null,    // TV kiosk profile
 *     profileName: string|null,
 *     releaseGroupId: string|null, // tablet release group
 *     releaseGroupName: string|null,
 *     ip: string|null,           // terminal IP
 *     hardware: string|null,     // terminal model
 *   }]
 * }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

function tsIso(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  return null;
}
function tsMs(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'string') return Date.parse(v);
  return null;
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId(req.query.tenant);
  const now = Date.now();
  const ONLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

  const devices = [];
  const summary = {
    tvTotal: 0, tvPaired: 0,
    tabletTotal: 0, tabletPaired: 0,
    terminalTotal: 0, terminalEnabled: 0,
  };

  // ── 1. TV devices ──────────────────────────────────────────────────────────
  // Load kiosk profiles for name lookup
  const profileNames = {};
  try {
    const kpSnap = await db.collection(`${tenancy.tenantDoc(tid)}/kiosk_profiles`).get();
    kpSnap.forEach((d) => { profileNames[d.id] = d.data()?.name || d.id; });
  } catch { /* non-critical */ }

  try {
    const tvSnap = await db.collection(tenancy.tvDevicesPath ? tenancy.tvDevicesPath(tid) : `${tenancy.tenantDoc(tid)}/tv_devices`).get();
    summary.tvTotal = tvSnap.size;
    tvSnap.forEach((doc) => {
      const d = doc.data();
      const hbMs = tsMs(d.lastHeartbeat || d.lastSeenAt || d.updatedAt);
      const msSince = hbMs ? now - hbMs : null;
      const status = d.status || 'unpaired';
      if (status === 'paired') summary.tvPaired++;

      devices.push({
        id: doc.id,
        type: 'tv',
        name: d.name || d.profileId || doc.id,
        gate: d.gate || d.gateLabel || null,
        grade: d.grade || d.gradeLabel || null,
        status,
        heartbeatAt: tsIso(d.lastHeartbeat || d.lastSeenAt || d.updatedAt),
        msSinceHeartbeat: msSince,
        online: msSince !== null && msSince < ONLINE_THRESHOLD_MS,
        profileId: d.profileId || null,
        profileName: d.profileId ? (profileNames[d.profileId] || d.profileId) : null,
        releaseGroupId: null,
        releaseGroupName: null,
        ip: null,
        hardware: 'FireTV / Kiosk Display',
      });
    });
  } catch (e) { /* tv_devices may not exist yet */ }

  // ── 2. Tablet devices ──────────────────────────────────────────────────────
  const releaseGroupNames = {};
  try {
    const rgSnap = await db.collection(tenancy.releaseGroupsPath(tid)).get();
    rgSnap.forEach((d) => { releaseGroupNames[d.id] = d.data()?.name || d.id; });
  } catch { /* non-critical */ }

  try {
    const tabSnap = await db.collection(tenancy.tabletDevicesPath(tid)).get();
    summary.tabletTotal = tabSnap.size;
    tabSnap.forEach((doc) => {
      const d = doc.data();
      const hbMs = tsMs(d.lastSeenAt || d.updatedAt);
      const msSince = hbMs ? now - hbMs : null;
      const status = d.status || 'unpaired';
      if (status === 'paired') summary.tabletPaired++;

      devices.push({
        id: doc.id,
        type: 'tablet',
        name: d.name || d.deviceName || doc.id,
        gate: d.gate || null,
        grade: d.grade || d.gradeLabel || null,
        status,
        heartbeatAt: tsIso(d.lastSeenAt || d.updatedAt),
        msSinceHeartbeat: msSince,
        online: msSince !== null && msSince < ONLINE_THRESHOLD_MS,
        profileId: null,
        profileName: null,
        releaseGroupId: d.releaseGroupId || null,
        releaseGroupName: d.releaseGroupId ? (releaseGroupNames[d.releaseGroupId] || d.releaseGroupId) : null,
        ip: null,
        hardware: 'iPad / Android Tablet',
      });
    });
  } catch { /* tablet_devices may not exist yet */ }

  // ── 3. Hikvision terminals ─────────────────────────────────────────────────
  try {
    const termSnap = await db.collection(tenancy.terminalsPath(tid)).get();
    summary.terminalTotal = termSnap.size;
    termSnap.forEach((doc) => {
      const d = doc.data();
      const hbMs = tsMs(d.lastSeenAt);
      const msSince = hbMs ? now - hbMs : null;
      const enabled = d.enabled !== false;
      if (enabled) summary.terminalEnabled++;

      devices.push({
        id: doc.id,
        type: 'terminal',
        name: d.name || doc.id,
        gate: d.gateLabel || d.gateOverride || null,
        grade: d.gradeLabel || null,
        status: enabled ? 'enabled' : 'disabled',
        heartbeatAt: tsIso(d.lastSeenAt),
        msSinceHeartbeat: msSince,
        online: msSince !== null && msSince < 10 * 60 * 1000, // terminal: 10min threshold
        profileId: null,
        profileName: null,
        releaseGroupId: null,
        releaseGroupName: null,
        ip: d.ip || null,
        hardware: d.hardware || d.deviceName || 'DS-K1T3xx',
      });
    });
  } catch { /* terminals may not exist yet */ }

  // Sort: terminals → TVs → tablets, then by name
  const TYPE_ORDER = { terminal: 0, tv: 1, tablet: 2 };
  devices.sort((a, b) => {
    const to = (TYPE_ORDER[a.type] || 9) - (TYPE_ORDER[b.type] || 9);
    if (to !== 0) return to;
    return (a.name || '').localeCompare(b.name || '');
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    generatedAt: new Date().toISOString(),
    summary,
    devices,
  });
}

export default withApi(handler, { methods: ['GET'], permission: 'analytics.view' });
