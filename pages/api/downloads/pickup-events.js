/**
 * POST /api/downloads/pickup-events
 *
 * Pickup event ledger — every release event recorded by gate officers /
 * FR matchers in `tenants/{tid}/pickup_events`.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, validateExportRequest, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function toIso(v) {
  if (!v) return '';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const v = validateExportRequest(req.body || {}, { maxDays: 365 });
  if (v.error) return res.status(v.error.status).json(v.error.body);
  const { from, to, format: fmt } = v;
  const filters = req.body?.filters || {};
  const classFilter = filters.class ? String(filters.class).toLowerCase() : null;

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const fromMs = new Date(`${from}T00:00:00.000Z`).getTime();
  const toMs   = new Date(`${to}T23:59:59.999Z`).getTime();

  // Query by createdAt server-side so we read at most ~MAX_ROWS docs even
  // on a busy day. We still range-filter client-side because the doc may
  // store the timestamp under different field names across versions.
  let q = db.collection(tenancy.pickupEventsPath(tid))
    .orderBy('createdAt', 'desc')
    .limit(MAX_ROWS + 1);

  const snap = await q.get().catch(() => null);

  const rows = [];
  let viaFr = 0, viaOverride = 0, viaManual = 0;
  const byGate = new Map();
  let truncated = false;

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const e = d.data() || {};
      const createdIso = toIso(e.createdAt || e.ts || e.timestamp);
      const createdMs = createdIso ? new Date(createdIso).getTime() : 0;
      if (createdMs && (createdMs < fromMs || createdMs > toMs)) return;
      const cls = (e.studentHomeroom || e.studentClass || '').toString();
      if (classFilter && cls.toLowerCase() !== classFilter) return;

      const method = String(e.method || e.matchMethod || (e.officerOverride ? 'override' : 'fr')).toLowerCase();
      if (method.includes('override')) viaOverride++;
      else if (method.includes('manual')) viaManual++;
      else viaFr++;

      const gate = e.gate || e.terminal || e.terminalId || '—';
      byGate.set(gate, (byGate.get(gate) || 0) + 1);

      rows.push([
        createdIso ? createdIso.slice(0, 19).replace('T', ' ') : '—',
        e.studentName || '—',
        e.studentBinusId || e.studentId || '',
        cls,
        e.chaperoneName || '—',
        e.chaperoneRelation || '',
        gate,
        method,
        typeof e.confidence === 'number' ? `${(e.confidence * 100).toFixed(1)}%` : '',
        e.officer || e.releasedBy || '',
        e.notes || '',
      ]);
    });
  }

  const gateBreakdown = Array.from(byGate.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => [`Gate · ${k}`, String(v)]);

  const payload = {
    format: fmt,
    kind: 'pickup-events',
    dateStamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    title: 'Pickup Events Report',
    subtitle: 'Every student release at the gate — chaperone, method, officer.',
    theme: 'orange',
    range: `${from} → ${to}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total releases',   rows.length.toLocaleString()],
      ['Face match',       viaFr.toLocaleString()],
      ['Officer override', viaOverride.toLocaleString()],
      ['Manual',           viaManual.toLocaleString()],
      ['FR success rate',  rows.length ? `${((viaFr / rows.length) * 100).toFixed(1)}%` : '—'],
      ...gateBreakdown,
    ],
    columns: ['Time', 'Student', 'Binusian ID', 'Class', 'Chaperone', 'Relation', 'Gate', 'Method', 'Confidence', 'Officer', 'Notes'],
    colWidths: [17, 16, 12, 7, 16, 9, 9, 9, 9, 12, 14],
    rows,
    truncated,
    sheetName: 'Pickup Events',
    notes: classFilter ? [`Filtered by class: ${classFilter.toUpperCase()}`] : [],
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid, actor: req.user || null,
        kind: 'downloads.pickup_events.reauth_failed',
        target: { type: 'report', id: 'pickup-events' },
        summary: `Re-auth failed for pickup events download: ${reauth.error}`,
        metadata: { error: reauth.error, format: fmt, range: `${from}..${to}` },
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
      kind: 'downloads.pickup_events.export',
      target: { type: 'report', id: 'pickup-events', label: out.filename },
      summary: `Downloaded pickup events (${fmt.toUpperCase()})`,
      metadata: { format: fmt, rows: rows.length, range: `${from}..${to}`, classFilter, truncated, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
