/**
 * POST /api/downloads/terminals
 * Inventory of Hikvision / mobile / web terminals registered in this tenant.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

const ONLINE_WINDOW_SEC = 5 * 60; // 5 minutes since last heartbeat = online

function toIso(v) {
  if (!v) return '';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const fmt = String(req.body?.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const snap = await db.collection(tenancy.terminalsPath(tid))
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  let online = 0, offline = 0;
  const byType = new Map();
  let truncated = false;
  const nowSec = Math.floor(Date.now() / 1000);

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const t = d.data() || {};
      const lastHeartbeatIso = toIso(t.lastHeartbeat || t.lastSeen || t.updatedAt);
      const lastSec = lastHeartbeatIso ? Math.floor(new Date(lastHeartbeatIso).getTime() / 1000) : 0;
      const isOnline = lastSec && (nowSec - lastSec) <= ONLINE_WINDOW_SEC;
      if (isOnline) online++; else offline++;
      const type = t.type || t.kind || (t.ip ? 'hikvision' : 'unknown');
      byType.set(type, (byType.get(type) || 0) + 1);
      rows.push([
        d.id,
        t.name || t.label || '—',
        type,
        t.location || t.gate || '',
        t.ip || '',
        t.firmware || t.version || '',
        isOnline ? 'ONLINE' : 'OFFLINE',
        lastHeartbeatIso ? lastHeartbeatIso.slice(0, 19).replace('T', ' ') : '—',
        toIso(t.createdAt).slice(0, 10),
      ]);
    });
  }

  const typeBreakdown = Array.from(byType.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => [`Type · ${k}`, String(v)]);

  const payload = {
    format: fmt,
    kind: 'terminals',
    dateStamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    title: 'Terminals & Devices',
    subtitle: 'Hikvision face terminals, mobile tablets, and gate devices',
    theme: 'indigo',
    range: `Snapshot · ${new Date().toISOString().slice(0, 10)}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total terminals',  rows.length.toLocaleString()],
      ['Online now',       online.toLocaleString()],
      ['Offline',          offline.toLocaleString()],
      ['Online rate',      rows.length ? `${((online / rows.length) * 100).toFixed(1)}%` : '—'],
      ...typeBreakdown,
    ],
    columns: ['ID', 'Name', 'Type', 'Location', 'IP', 'Firmware', 'Status', 'Last Heartbeat', 'Added'],
    colWidths: [10, 16, 9, 12, 13, 10, 8, 17, 9],
    rows,
    truncated,
    sheetName: 'Terminals',
    notes: [`"Online" = heartbeat within last ${Math.round(ONLINE_WINDOW_SEC / 60)} minutes.`],
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid, actor: req.user || null,
        kind: 'downloads.terminals.reauth_failed',
        target: { type: 'report', id: 'terminals' },
        summary: `Re-auth failed for terminals download: ${reauth.error}`,
        metadata: { error: reauth.error, format: fmt },
        req,
      });
    } catch {}
    if (reauth.retryAfterSec) res.setHeader('Retry-After', reauth.retryAfterSec);
    return res.status(reauth.status).json({ error: reauth.error, message: reauth.message, retryAfter: reauth.retryAfterSec });
  }

  const out = await renderDownload(payload);

  try {
    await logAudit(db, {
      tenantId: tid,
      actor: req.user || null,
      kind: 'downloads.terminals.export',
      target: { type: 'report', id: 'terminals', label: out.filename },
      summary: `Downloaded terminals inventory (${fmt.toUpperCase()})`,
      metadata: { format: fmt, rows: rows.length, online, offline, truncated, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
