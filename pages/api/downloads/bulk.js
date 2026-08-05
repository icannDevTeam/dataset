/**
 * POST /api/downloads/bulk
 *
 * Run multiple Downloads-Hub cards in one shot and stream a ZIP back.
 *
 * Body: { cardIds: string[], format: 'csv'|'xlsx', from?: string, to?: string,
 *         filters?: object }
 *
 * Behaviour
 * ─────────
 *   1. Resolve each cardId against the in-process RUNNERS registry —
 *      reject the whole request if any id is unknown.
 *   2. Permission check: caller must satisfy ALL per-card permission
 *      keys (intersection). 403 on any miss.
 *   3. Step-up re-auth: same window as a single export (300 s).
 *   4. For each card: call config.fetcher → render via downloads-helpers
 *      → push into a ZIP entry named "<cardId>.<ext>".
 *   5. Stream the ZIP buffer as `bulk_<from>_<to>.zip`.
 *   6. One audit event `downloads.bulk.export` describes the whole
 *      bundle. Each card also gets its own `reportRuns` doc tagged
 *      `mode:'bulk'` with a shared `bulkRunId` field.
 *
 * Important: this endpoint never streams XLSX/PDF directly. PDF is
 * intentionally rejected until the renderer can size-cap the inputs.
 */
import admin from 'firebase-admin';
import JSZip from 'jszip';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const crypto = require('crypto');
const { RUNNERS, writeReportRun } = require('../../../lib/download-runner');
const { renderDownload, validateExportRequest } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { canAll, canAny } = require('../../../lib/rbac');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

const MUST_HAVE_CARD_IDS = new Set([
  'attendance',
  'pickup-events',
  'students-roster',
  'class-directory',
  'security-incidents',
  'audit-log',
]);

// Force-load every per-card endpoint module so its `runDownload(...)` side
// effect registers the runner with the in-process RUNNERS map. In a
// serverless cold start this file would otherwise see an empty registry.
require('./attendance');
require('./chaperone-roster');
require('./pickup-events');
require('./onboarding-forms');
require('./students-roster');
require('./terminals');
require('./system-health');
require('./security-incidents');
require('./access-logs');
require('./audit-log');
require('./chaperone-audit');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

// Match the per-endpoint `withApi({ permission: ... })` declarations so
// the bulk gate matches what each single-card endpoint enforces.
const CARD_PERMISSIONS = {
  'attendance':         ['downloads.download_operational'],
  'chaperone-roster':   ['downloads.download_compliance'],
  'pickup-events':      ['downloads.download_operational'],
  'onboarding-forms':   ['downloads.download_directory'],
  'students-roster':    ['downloads.download_operational', 'downloads.download_directory'], // ANY
  'terminals':          ['downloads.download_operational'],
  'system-health':      ['downloads.download_operational'],
  'security-incidents': ['downloads.download_security'],
  'access-logs':        ['downloads.download_security'],
  'audit-log':          ['downloads.download_compliance'],
  'chaperone-audit':    ['downloads.download_compliance'],
};
// Cards declared with multiple permissions in the table above use ANY
// semantics; the single-entry cards use a hard requirement.
const ANY_PERMISSION_CARDS = new Set(['students-roster']);

function defaultRange() {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const past  = new Date(Date.now() + 7 * 3600 * 1000);
  past.setUTCDate(past.getUTCDate() - 29);
  return { from: past.toISOString().slice(0, 10), to: today, days: 30 };
}

function todayStampWIB() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

function objectRowsToArrays(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (Array.isArray(rows[0])) return rows;
  return rows.map((r) => columns.map((c) => {
    const v = r ? r[c.id] : '';
    return c.format ? c.format(v, r) : (v == null ? '' : v);
  }));
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tenantId = tenancy.getTenantId();
  const actor = req.user || {};

  const body = req.body || {};
  const cardIds = Array.isArray(body.cardIds) ? body.cardIds.filter((s) => typeof s === 'string') : [];
  const format  = String(body.format || 'xlsx').toLowerCase();

  if (cardIds.length === 0) return res.status(400).json({ error: 'no_cards' });
  if (cardIds.length > 12) return res.status(400).json({ error: 'too_many_cards', limit: 12 });
  if (!['csv', 'xlsx'].includes(format)) {
    return res.status(400).json({ error: 'bad_format', message: 'Bulk export supports csv or xlsx only' });
  }

  // ── Validate every card up front ─────────────────────────────────
  const configs = [];
  for (const id of cardIds) {
    if (!MUST_HAVE_CARD_IDS.has(id)) {
      return res.status(403).json({ error: 'export_not_allowed', cardId: id });
    }
    const cfg = RUNNERS.get(id);
    if (!cfg) return res.status(400).json({ error: 'unknown_card', cardId: id });
    if (!CARD_PERMISSIONS[id]) return res.status(400).json({ error: 'unmapped_card', cardId: id });
    configs.push({ id, cfg });
  }

  // ── Permission intersection ──────────────────────────────────────
  if (!actor.superAdmin) {
    for (const id of cardIds) {
      const keys = CARD_PERMISSIONS[id];
      const ok = ANY_PERMISSION_CARDS.has(id)
        ? canAny(actor.permissions, keys)
        : canAll(actor.permissions, keys);
      if (!ok) {
        return res.status(403).json({ error: 'forbidden', cardId: id, need: keys });
      }
    }
  }

  // ── Date range (only applied to cards that need it) ──────────────
  let from, to, days;
  const anyNeedsRange = configs.some((c) => c.cfg.needsRange !== false);
  if (anyNeedsRange) {
    const v = validateExportRequest({ ...body, format }, { maxDays: 365 });
    if (v.error) return res.status(v.error.status).json(v.error.body);
    ({ from, to, days } = v);
  } else {
    ({ from, to, days } = defaultRange());
  }

  // ── Step-up re-auth ──────────────────────────────────────────────
  req.user = actor;
  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    if (reauth.retryAfterSec) res.setHeader('Retry-After', reauth.retryAfterSec);
    return res.status(reauth.status).json({
      error: reauth.error, message: reauth.message,
      retryAfter: reauth.retryAfterSec,
    });
  }

  const bulkRunId = (typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : db.collection('_ids').doc().id;
  const ext = format === 'xlsx' ? 'xlsx' : 'csv';
  const zip = new JSZip();
  const startedAt = Date.now();

  let totalRows = 0;
  const perCard = [];

  for (const { id, cfg } of configs) {
    const cardStart = Date.now();
    const needsRange = cfg.needsRange !== false;
    const ctx = {
      req, db, tenantId, actor,
      from: needsRange ? from : null,
      to:   needsRange ? to : null,
      days: needsRange ? days : 0,
      format, filters: body.filters || {},
      needsRange,
    };

    let fetched, out;
    try {
      fetched = await cfg.fetcher(ctx);
      if (!fetched || !Array.isArray(fetched.rows)) fetched = { rows: [], meta: {} };
    } catch (err) {
      console.error(`[downloads/bulk] ${id} fetcher failed:`, err.message);
      // Persist the failure but keep going so the user still gets a ZIP.
      await writeReportRun(db, ctx, cfg, {
        mode: 'bulk', status: 'failed',
        errorMessage: err.message, durationMs: Date.now() - cardStart,
      });
      perCard.push({ cardId: id, status: 'failed', error: err.message });
      continue;
    }

    const rows = fetched.rows;
    totalRows += rows.length;

    const labels = cfg.columns.map((c) => c.label);
    const widths = cfg.columns.map((c) => c.width).filter((w) => typeof w === 'number');
    const colWidths = widths.length === cfg.columns.length ? widths : undefined;

    const payload = {
      format,
      kind: cfg.cardId,
      dateStamp: todayStampWIB(),
      title: cfg.title,
      subtitle: cfg.subtitle,
      theme: cfg.theme || 'teal',
      range: needsRange
        ? `${from} → ${to} (${days} days)`
        : (cfg.snapshotLabel || `Snapshot · ${new Date().toISOString().slice(0, 10)}`),
      actor: actor?.email || '—',
      tenant: tenantId,
      kpis: typeof cfg.kpis === 'function' ? (cfg.kpis(rows, ctx) || []).map((k) => Array.isArray(k) ? k : [k.label, k.value]) : [],
      columns: labels,
      colWidths,
      rows: objectRowsToArrays(rows, cfg.columns),
      truncated: !!fetched.meta?.truncated,
      sheetName: cfg.sheetName || cfg.title,
      notes: fetched.meta?.notes || cfg.notes || [],
    };

    try {
      out = await renderDownload(payload);
    } catch (err) {
      console.error(`[downloads/bulk] ${id} render failed:`, err.message);
      await writeReportRun(db, ctx, cfg, {
        mode: 'bulk', status: 'failed',
        errorMessage: err.message, durationMs: Date.now() - cardStart,
        rowCount: rows.length, bulkRunId,
      });
      perCard.push({ cardId: id, status: 'failed', error: err.message });
      continue;
    }

    const buf = Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf);
    zip.file(`${id}.${ext}`, buf);

    await writeReportRun(db, ctx, cfg, {
      mode: 'bulk', status: 'completed',
      rowCount: rows.length, bytesOut: buf.length,
      durationMs: Date.now() - cardStart, bulkRunId,
    });
    perCard.push({ cardId: id, status: 'completed', rowCount: rows.length, bytes: buf.length });
  }

  if (perCard.every((p) => p.status === 'failed')) {
    return res.status(500).json({ error: 'all_cards_failed', perCard });
  }

  // Surface partial failures inside the zip so the user sees exactly
  // which cards came back empty without having to crack open the audit
  // log. The companion `downloads.bulk.export` audit event still carries
  // the full perCard breakdown for compliance review.
  const failures = perCard.filter((p) => p.status === 'failed');
  if (failures.length > 0) {
    zip.file(
      '__bulk_errors.json',
      Buffer.from(JSON.stringify(
        failures.map((p) => ({ cardId: p.cardId, error: p.error })),
        null, 2,
      ), 'utf8'),
    );
  }

  const zipBuf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // Best-effort audit — never block the response.
  try {
    await logAudit(db, {
      tenantId, actor,
      kind: 'downloads.bulk.export',
      target: { type: 'report', id: bulkRunId },
      summary: `Bulk-exported ${cardIds.length} reports (${totalRows} total rows)`,
      metadata: {
        cardIds, format, from, to,
        count: cardIds.length, totalRows,
        bulkRunId, durationMs: Date.now() - startedAt,
        perCard,
      },
      req,
    });
  } catch {}

  const stamp = `${from || todayStampWIB()}_${to || todayStampWIB()}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="bulk_${stamp}.zip"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(zipBuf);
}

export default withApi(handler, {
  methods: ['POST'],
  // Generic gate — per-card permissions are enforced inside the handler.
  anyPermission: [
    'downloads.download_operational',
    'downloads.download_directory',
    'downloads.download_security',
    'downloads.download_compliance',
  ],
  rateLimit: 10,
});
