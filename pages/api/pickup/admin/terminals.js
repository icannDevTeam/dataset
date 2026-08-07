/**
 * Admin endpoint for the terminal (Hikvision face terminal) registry.
 *
 *   GET    /api/pickup/admin/terminals                  → list all terminals
 *   POST   /api/pickup/admin/terminals                  → create/upsert terminal
 *            body: { terminalId?, name, ip?, deviceName?, gradeLabel?, gateLabel?,
 *                    releaseGroupId?, gateOverride?, enabled? }
 *   PUT    /api/pickup/admin/terminals?id=<terminalId>  → patch fields
 *   DELETE /api/pickup/admin/terminals?id=<terminalId>  → soft delete (enabled=false)
 *   DELETE /api/pickup/admin/terminals?id=<id>&hard=1   → hard delete
 *
 * terminalId convention: sha1(name)[:12] — stable across listener restarts so
 * the Pandora backend can compute the same id from devices.json without a
 * separate lookup table.
 */
import admin from 'firebase-admin';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi, can } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const { isValidHHMM } = require('../../../../lib/terminal-gate');

function deny(res) {
  return res.status(403).json({ error: 'forbidden' });
}

function stableTerminalId(name) {
  return crypto.createHash('sha1').update(String(name || '')).digest('hex').slice(0, 12);
}

function tsMs(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  if (ts instanceof Date) return ts.getTime();
  return null;
}

function terminalNaturalSort(a, b) {
  const aName = String(a?.name || '').trim();
  const bName = String(b?.name || '').trim();
  const aMatch = aName.match(/^Terminal\s+(\d+)$/i);
  const bMatch = bName.match(/^Terminal\s+(\d+)$/i);

  // Keep "Terminal N" ordered numerically when both names match that format.
  if (aMatch && bMatch) {
    const an = parseInt(aMatch[1], 10);
    const bn = parseInt(bMatch[1], 10);
    if (an !== bn) return an - bn;
  }

  // If only one side is "Terminal N", prefer it first.
  if (aMatch && !bMatch) return -1;
  if (!aMatch && bMatch) return 1;

  return aName.localeCompare(bName);
}

function resolveListenerLogPath() {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, '..', 'listeners.log'),
    path.join(cwd, '..', 'backend', 'listeners.log'),
    path.join('/home/pandora/Downloads/final-face', 'listeners.log'),
    path.join('/home/pandora/Downloads/final-face/backend', 'listeners.log'),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

function loadLatestListenerStatusByTerminal() {
  const p = resolveListenerLogPath();
  if (!p) return new Map();
  try {
    const stat = fs.statSync(p);
    const tailBytes = 128 * 1024;
    let raw = '';
    if (stat.size > tailBytes) {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(tailBytes);
      fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } else {
      raw = fs.readFileSync(p, 'utf8');
    }

    const lines = raw.split('\n').filter((l) => l && l.trim());
    const statusHeaderRegex = /Listener Manager Status/i;
    const runningRegex = /\[([^\]]+)\]\s*✓\s*Running\s*\|\s*PID\s*(\d+)\s*\(up\s*([^\)]+)\)/i;
    const stoppedRegex = /\[([^\]]+)\]\s*Stopped/i;

    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (statusHeaderRegex.test(lines[i])) {
        start = i;
        break;
      }
    }
    if (start < 0) return new Map();

    const map = new Map();
    for (let i = start; i < Math.min(lines.length, start + 80); i++) {
      const line = lines[i];
      const mRun = line.match(runningRegex);
      if (mRun) {
        map.set(mRun[1].trim(), {
          running: true,
          pid: Number(mRun[2]),
          uptime: mRun[3].trim(),
        });
        continue;
      }
      const mStop = line.match(stoppedRegex);
      if (mStop) {
        map.set(mStop[1].trim(), {
          running: false,
          pid: null,
          uptime: null,
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function publicTerminal(id, data, listenerStatusByTerminal = new Map()) {
  if (!data) return null;
  const tsIso = (ts) => {
    if (!ts) return null;
    if (typeof ts === 'string') return ts;
    if (ts.toDate) return ts.toDate().toISOString();
    if (ts instanceof Date) return ts.toISOString();
    return null;
  };
  const lastSeenIso = tsIso(data.lastSeenAt);
  const lastSeenMs = tsMs(lastSeenIso);
  const downThresholdMinutes = Number(process.env.TERMINAL_DOWN_THRESHOLD_MINUTES || 10);
  const downThresholdMs = Math.max(1, downThresholdMinutes) * 60 * 1000;
  const msSinceLastSeen = lastSeenMs ? (Date.now() - lastSeenMs) : null;
  const enabled = data.enabled !== false;
  const listener = listenerStatusByTerminal.get(data.name || id) || null;
  let healthStatus = 'unknown';
  if (!enabled) healthStatus = 'disabled';
  else if (listener && typeof listener.running === 'boolean') healthStatus = listener.running ? 'up' : 'down';
  else if (msSinceLastSeen == null) healthStatus = 'unknown';
  else healthStatus = msSinceLastSeen > downThresholdMs ? 'down' : 'up';

  return {
    id,
    terminalId: data.terminalId || id,
    name: data.name || id,
    ip: data.ip || null,
    deviceName: data.deviceName || data.name || null,
    gradeLabel: data.gradeLabel || null,
    gradeScopes: Array.isArray(data.gradeScopes)
      ? data.gradeScopes.map(String).map((s) => s.trim()).filter(Boolean)
      : [],
    gateLabel: data.gateLabel || null,
    releaseGroupId: data.releaseGroupId || null,
    gateOverride: data.gateOverride || null,    // 'open' | 'closed' | null
    windowOpen:  typeof data.windowOpen  === 'string' && /^\d{2}:\d{2}$/.test(data.windowOpen)  ? data.windowOpen  : null,
    windowClose: typeof data.windowClose === 'string' && /^\d{2}:\d{2}$/.test(data.windowClose) ? data.windowClose : null,
    gateOverrideAt: tsIso(data.gateOverrideAt),
    enabled,
    archived: data.archived === true,
    archivedAt: tsIso(data.archivedAt),
    lastSeenAt: lastSeenIso,
    msSinceLastSeen,
    healthStatus,
    healthSource: listener && typeof listener.running === 'boolean' ? 'listener' : 'heartbeat',
    listenerRunning: listener && typeof listener.running === 'boolean' ? listener.running : null,
    listenerPid: listener?.pid ?? null,
    listenerUptime: listener?.uptime ?? null,
    online: healthStatus === 'up',
    downThresholdMinutes,
    createdAt: tsIso(data.createdAt),
    updatedAt: tsIso(data.updatedAt),
  };
}

async function detachTerminalFromReleaseGroups(db, tid, terminalId) {
  const groupsRef = db.collection(tenancy.releaseGroupsPath(tid));
  const snap = await groupsRef.where('terminalIds', 'array-contains', terminalId).get();
  if (snap.empty) return 0;

  const batch = db.batch();
  let updated = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const terminalIds = Array.isArray(data.terminalIds) ? data.terminalIds.map(String) : [];
    const next = terminalIds.filter((id) => id !== terminalId);
    if (next.length === terminalIds.length) continue;
    batch.set(doc.ref, {
      terminalIds: next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    updated += 1;
  }

  if (updated > 0) await batch.commit();
  return updated;
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const colRef = db.collection(tenancy.terminalsPath(tid));
  const perms = req.user?.permissions || {};
  const canView = req.user?.superAdmin || can(perms, 'pickup_admin.view');
  const canManage = req.user?.superAdmin || can(perms, 'pickup_admin.manage_terminals');

  if (req.method === 'GET' && !canView) return deny(res);
  if (req.method !== 'GET' && !canManage) return deny(res);

  try {
    if (req.method === 'GET') {
      const listenerStatusByTerminal = loadLatestListenerStatusByTerminal();
      const snap = await colRef.get();
      const terminals = snap.docs
        .map((d) => publicTerminal(d.id, d.data(), listenerStatusByTerminal))
        .sort(terminalNaturalSort);
      return res.status(200).json({ ok: true, terminals });
    }

    if (req.method === 'POST') {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      const id = String(req.body?.terminalId || stableTerminalId(name));

      const ref = colRef.doc(id);
      const existing = await ref.get();
      const patch = {
        terminalId: id,
        name,
        ip: req.body?.ip ? String(req.body.ip).trim() : (existing.data()?.ip || null),
        deviceName: req.body?.deviceName ? String(req.body.deviceName).trim() : (existing.data()?.deviceName || name),
        gradeLabel: req.body?.gradeLabel != null ? String(req.body.gradeLabel).trim() || null : (existing.data()?.gradeLabel || null),
        gradeScopes: Array.isArray(req.body?.gradeScopes)
          ? req.body.gradeScopes.map(String).map((s) => s.trim()).filter(Boolean)
          : (existing.data()?.gradeScopes || []),
        gateLabel: req.body?.gateLabel != null ? String(req.body.gateLabel).trim() || null : (existing.data()?.gateLabel || null),
        releaseGroupId: req.body?.releaseGroupId != null
          ? (req.body.releaseGroupId ? String(req.body.releaseGroupId) : null)
          : (existing.data()?.releaseGroupId || null),
        gateOverride: ['open', 'closed', null].includes(req.body?.gateOverride)
          ? req.body.gateOverride
          : (existing.data()?.gateOverride || null),
        windowOpen:  req.body?.windowOpen  !== undefined
          ? (req.body.windowOpen  ? (isValidHHMM(req.body.windowOpen)  ? req.body.windowOpen  : null) : null)
          : (existing.data()?.windowOpen  || null),
        windowClose: req.body?.windowClose !== undefined
          ? (req.body.windowClose ? (isValidHHMM(req.body.windowClose) ? req.body.windowClose : null) : null)
          : (existing.data()?.windowClose || null),
        enabled: req.body?.enabled !== undefined ? !!req.body.enabled : (existing.data()?.enabled !== false),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (!existing.exists) patch.createdAt = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(patch, { merge: true });
      const updated = (await ref.get()).data();
      const listenerStatusByTerminal = loadLatestListenerStatusByTerminal();
      return res.status(existing.exists ? 200 : 201).json({ ok: true, terminal: publicTerminal(id, updated, listenerStatusByTerminal) });
    }

    if (req.method === 'PUT') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'terminal not found' });

      const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
      if (req.body?.ip !== undefined) patch.ip = String(req.body.ip).trim() || null;
      if (req.body?.deviceName !== undefined) patch.deviceName = String(req.body.deviceName).trim() || null;
      if (req.body?.gradeLabel !== undefined) patch.gradeLabel = String(req.body.gradeLabel).trim() || null;
      if (req.body?.gradeScopes !== undefined) {
        if (req.body.gradeScopes !== null && !Array.isArray(req.body.gradeScopes)) {
          return res.status(400).json({ error: 'gradeScopes must be an array of grade strings' });
        }
        patch.gradeScopes = Array.isArray(req.body.gradeScopes)
          ? req.body.gradeScopes.map(String).map((s) => s.trim()).filter(Boolean)
          : [];
      }
      if (req.body?.gateLabel !== undefined) patch.gateLabel = String(req.body.gateLabel).trim() || null;
      if (req.body?.releaseGroupId !== undefined) {
        patch.releaseGroupId = req.body.releaseGroupId ? String(req.body.releaseGroupId) : null;
      }
      if (req.body?.gateOverride !== undefined) {
        if (![null, 'open', 'closed'].includes(req.body.gateOverride)) {
          return res.status(400).json({ error: 'gateOverride must be open|closed|null' });
        }
        patch.gateOverride = req.body.gateOverride;
        patch.gateOverrideAt = admin.firestore.FieldValue.serverTimestamp();
      }
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
      if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
      if (req.body?.enabled !== undefined && req.body.enabled === true) {
        patch.archived = false;
        patch.archivedAt = null;
      }

      const existing = snap.data() || {};
      const finalWindowOpen = patch.windowOpen !== undefined ? patch.windowOpen : (existing.windowOpen || null);
      const finalWindowClose = patch.windowClose !== undefined ? patch.windowClose : (existing.windowClose || null);
      if ((finalWindowOpen && !finalWindowClose) || (!finalWindowOpen && finalWindowClose)) {
        return res.status(400).json({ error: 'windowOpen and windowClose must both be set or both empty' });
      }

      await ref.set(patch, { merge: true });
      const updated = (await ref.get()).data();
      const listenerStatusByTerminal = loadLatestListenerStatusByTerminal();
      return res.status(200).json({ ok: true, terminal: publicTerminal(id, updated, listenerStatusByTerminal) });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);

      // Keep release-groups consistent: remove this terminal from any bound group.
      const groupsUpdated = await detachTerminalFromReleaseGroups(db, tid, id);

      if (req.query.hard === '1') {
        await ref.delete();
      } else {
        await ref.set({
          enabled: false,
          archived: true,
          releaseGroupId: null,
          archivedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return res.status(200).json({ ok: true, id, groupsUpdated });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[pickup/admin/terminals]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  requireUser: true,
});
