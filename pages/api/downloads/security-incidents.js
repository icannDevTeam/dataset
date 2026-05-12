/**
 * POST /api/downloads/security-incidents
 * Spoofing detections + liveness failures from
 * `tenants/{tid}/security_incidents`.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, validateExportRequest, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const v = validateExportRequest(req.body || {}, { maxDays: 365 });
  if (v.error) return res.status(v.error.status).json(v.error.body);

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const fromMs = new Date(v.from + 'T00:00:00+07:00').getTime();
  const toMs = new Date(v.to + 'T23:59:59+07:00').getTime();

  const snap = await db.collection(tenancy.securityIncidentsPath(tid))
    .orderBy('timestamp', 'desc')
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  let spoof = 0, liveness = 0, lowConf = 0;
  const studentSet = new Set();
  let truncated = false;

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const r = d.data() || {};
      const tsRaw = r.timestamp?.toDate ? r.timestamp.toDate().toISOString()
        : (typeof r.timestamp === 'string' ? r.timestamp : null);
      if (!tsRaw) return;
      const ms = Date.parse(tsRaw);
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;

      const type = String(r.type || r.kind || 'unknown');
      if (/spoof/i.test(type)) spoof++;
      else if (/liveness/i.test(type)) liveness++;
      else if (/low.?conf/i.test(type)) lowConf++;

      const subject = r.student || r.chaperone || r.target || '—';
      studentSet.add(typeof subject === 'string' ? subject : (subject.id || subject.name || '—'));

      rows.push([
        tsRaw.slice(0, 19).replace('T', ' '),
        type,
        typeof subject === 'string' ? subject : (subject.name || subject.id || '—'),
        r.gate || r.terminalId || r.source || '—',
        r.confidence != null ? Number(r.confidence).toFixed(2) : '',
        r.livenessScore != null ? Number(r.livenessScore).toFixed(2) : '',
        r.photoPath || r.photo_path || r.image || '',
        r.notes || r.summary || '',
      ]);
    });
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const payload = {
    format: v.format,
    kind: 'security-incidents',
    dateStamp,
    title: 'Security Incidents Report',
    subtitle: 'Spoofing detections, liveness failures & low-confidence events',
    theme: 'teal',
    range: `${v.from} → ${v.to} (${v.days} days)`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total incidents',     rows.length.toLocaleString()],
      ['Spoof attempts',      spoof.toLocaleString()],
      ['Liveness failures',   liveness.toLocaleString()],
      ['Low-confidence',      lowConf.toLocaleString()],
      ['Subjects affected',   studentSet.size.toLocaleString()],
      ['Days covered',        v.days],
    ],
    columns: ['Timestamp', 'Type', 'Subject', 'Source', 'Confidence', 'Liveness', 'Photo Path', 'Notes'],
    colWidths: [13, 10, 18, 10, 8, 8, 18, 15],
    rows,
    truncated,
    sheetName: 'Incidents',
    notes: [
      'Photos referenced in "Photo Path" are stored in Firebase Storage.',
      'For incidents older than 90 days, narrow the date range to retrieve archived records.',
    ],
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid, actor: req.user || null,
        kind: 'downloads.security_incidents.reauth_failed',
        target: { type: 'report', id: 'security-incidents' },
        summary: `Re-auth failed for security incidents download: ${reauth.error}`,
        metadata: { error: reauth.error, format: v.format, from: v.from, to: v.to },
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
      kind: 'downloads.security_incidents.export',
      target: { type: 'report', id: 'security-incidents', label: out.filename },
      summary: `Downloaded security incidents report (${v.format.toUpperCase()})`,
      metadata: { format: v.format, from: v.from, to: v.to, rows: rows.length, truncated, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_security', rateLimit: 30 });
