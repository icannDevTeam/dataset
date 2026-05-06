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
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
const tenancy = require('../../../../lib/tenancy');

function stableTerminalId(name) {
  return crypto.createHash('sha1').update(String(name || '')).digest('hex').slice(0, 12);
}

function publicTerminal(id, data) {
  if (!data) return null;
  const tsIso = (ts) => {
    if (!ts) return null;
    if (typeof ts === 'string') return ts;
    if (ts.toDate) return ts.toDate().toISOString();
    if (ts instanceof Date) return ts.toISOString();
    return null;
  };
  return {
    id,
    terminalId: data.terminalId || id,
    name: data.name || id,
    ip: data.ip || null,
    deviceName: data.deviceName || data.name || null,
    gradeLabel: data.gradeLabel || null,
    gateLabel: data.gateLabel || null,
    releaseGroupId: data.releaseGroupId || null,
    gateOverride: data.gateOverride || null,    // 'open' | 'closed' | null
    enabled: data.enabled !== false,
    lastSeenAt: tsIso(data.lastSeenAt),
    createdAt: tsIso(data.createdAt),
    updatedAt: tsIso(data.updatedAt),
  };
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const colRef = db.collection(tenancy.terminalsPath(tid));

  try {
    if (req.method === 'GET') {
      const snap = await colRef.orderBy('name').get();
      const terminals = snap.docs.map((d) => publicTerminal(d.id, d.data()));
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
        gateLabel: req.body?.gateLabel != null ? String(req.body.gateLabel).trim() || null : (existing.data()?.gateLabel || null),
        releaseGroupId: req.body?.releaseGroupId != null
          ? (req.body.releaseGroupId ? String(req.body.releaseGroupId) : null)
          : (existing.data()?.releaseGroupId || null),
        gateOverride: ['open', 'closed', null].includes(req.body?.gateOverride)
          ? req.body.gateOverride
          : (existing.data()?.gateOverride || null),
        enabled: req.body?.enabled !== undefined ? !!req.body.enabled : (existing.data()?.enabled !== false),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (!existing.exists) patch.createdAt = admin.firestore.FieldValue.serverTimestamp();
      await ref.set(patch, { merge: true });
      const updated = (await ref.get()).data();
      return res.status(existing.exists ? 200 : 201).json({ ok: true, terminal: publicTerminal(id, updated) });
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
      if (req.body?.gateLabel !== undefined) patch.gateLabel = String(req.body.gateLabel).trim() || null;
      if (req.body?.releaseGroupId !== undefined) {
        patch.releaseGroupId = req.body.releaseGroupId ? String(req.body.releaseGroupId) : null;
      }
      if (req.body?.gateOverride !== undefined) {
        if (![null, 'open', 'closed'].includes(req.body.gateOverride)) {
          return res.status(400).json({ error: 'gateOverride must be open|closed|null' });
        }
        patch.gateOverride = req.body.gateOverride;
      }
      if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;
      await ref.set(patch, { merge: true });
      const updated = (await ref.get()).data();
      return res.status(200).json({ ok: true, terminal: publicTerminal(id, updated) });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      if (req.query.hard === '1') {
        await ref.delete();
      } else {
        await ref.set({
          enabled: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[pickup/admin/terminals]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withAuth(handler, { methods: ['GET', 'POST', 'PUT', 'DELETE'] });
