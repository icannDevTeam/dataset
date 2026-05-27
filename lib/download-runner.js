/**
 * lib/download-runner.js — Shared engine for /api/downloads/* endpoints.
 *
 * Every download endpoint reduces to:
 *
 *   const { runDownload } = require('../../../lib/download-runner');
 *   module.exports = withApi(runDownload({
 *     cardId:    'attendance',
 *     permission:'downloads.download_operational',
 *     maxDays:   365,
 *     theme:     'teal',
 *     title:     'Attendance Report',
 *     subtitle:  'Facial recognition attendance scans',
 *     filenamePrefix: 'binus-attendance',
 *     columns:   [{ id: 'date', label: 'Date', width: 9 }, ...],
 *     fetcher:   async (ctx) => ({ rows, meta }),
 *     kpis:      (rows, ctx) => [{ label, value }],
 *   }), { methods:['POST'], permission:'...', rateLimit:30 });
 *
 * Behaviour
 * ─────────
 * 1. Validates HTTP method (POST only).
 * 2. `verifyReauth(req, { maxAgeSec: 300 })` — caller can override via
 *    `reauthMaxAge`. Skips re-auth for preview / dryRun (read-only).
 * 3. Date range: validateExportRequest with the configured `maxDays`.
 *    For cards with `needsRange === false`, we still validate format
 *    but skip the date check.
 * 4. `preview === true` → cap to 25 rows, return JSON, no Storage write,
 *    audit kind `downloads.<card>.preview`.
 * 5. `dryRun === true` → fetch once, return `{ rowCount }`, no file,
 *    audit kind `downloads.<card>.dry_run`.
 * 6. Otherwise → run fetcher → render via downloads-helpers
 *    (CSV / XLSX / PDF). If rowCount ≥ ASYNC_THRESHOLD the runner
 *    delegates to the background job system instead of streaming.
 * 7. Sync path writes the file body as the response with
 *    `Content-Disposition: attachment; filename="..."`.
 * 8. `reportRuns` doc is appended on successful sync (M1 stub — M2
 *    will extend the shape).
 * 9. Audit kinds:
 *      downloads.<card>.export        (sync success)
 *      downloads.<card>.preview       (preview)
 *      downloads.<card>.dry_run       (dry run)
 *      downloads.<card>.reauth_failed (re-auth rejected)
 *      downloads.<card>.failed        (fetcher / renderer threw)
 *
 * The runner also exports a RUNNERS registry keyed by cardId so the
 * background job system (pages/api/downloads/_jobs/*) can look up the
 * exact same config when running a queued export.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from './firebase-admin';
const { renderDownload, validateExportRequest, buildPreview } = require('./downloads-helpers');
const tenancy = require('./tenancy');
const { logAudit } = require('./audit-log');
const { verifyReauth } = require('./reauth');

// rows >= this triggers the async/Storage path. Today the per-endpoint
// fetcher caps at MAX_ROWS (5000) before truncation, so the async path
// is effectively unreachable from a live endpoint — but the job-runner
// uses the same threshold and can be invoked directly via /_jobs/start.
const ASYNC_THRESHOLD = 5000;
const PREVIEW_SAMPLE = 25;

// Card audit-kind compatibility: existing kinds use underscores
// (`downloads.access_logs.export`), card ids use dashes (`access-logs`).
function kindSlug(cardId) { return String(cardId || '').replace(/-/g, '_'); }

// ── Registry ─────────────────────────────────────────────────────────
//
// Each endpoint registers its config so background jobs can re-execute
// the same fetcher / renderer without duplicating the wiring.
const RUNNERS = new Map();
function registerRunner(cardId, config) { RUNNERS.set(cardId, config); }
function getRunner(cardId)              { return RUNNERS.get(cardId); }

// ── Helpers ──────────────────────────────────────────────────────────

function objectRowsToArrays(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  // Detect already-arrayed rows (legacy fetcher shape) and pass through.
  if (Array.isArray(rows[0])) return rows;
  return rows.map((r) => columns.map((c) => {
    const v = r ? r[c.id] : '';
    return c.format ? c.format(v, r) : (v == null ? '' : v);
  }));
}

function todayStampWIB() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

function defaultRange() {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const past = new Date(Date.now() + 7 * 3600 * 1000);
  past.setUTCDate(past.getUTCDate() - 29);
  return { from: past.toISOString().slice(0, 10), to: today, days: 30 };
}

function buildPayload(config, fetched, ctx, truncated) {
  const labels = config.columns.map((c) => c.label);
  const widths = config.columns.map((c) => c.width).filter((w) => typeof w === 'number');
  const colWidths = widths.length === config.columns.length ? widths : undefined;
  const kpiList = typeof config.kpis === 'function' ? (config.kpis(fetched.rows, ctx) || []) : [];
  const kpis = kpiList.map((k) => Array.isArray(k) ? k : [k.label, k.value]);

  return {
    format: ctx.format,
    kind: config.cardId,
    dateStamp: todayStampWIB(),
    title: config.title,
    subtitle: config.subtitle,
    theme: config.theme || 'teal',
    range: ctx.needsRange === false
      ? (config.snapshotLabel || `Snapshot · ${new Date().toISOString().slice(0, 10)}`)
      : `${ctx.from} → ${ctx.to} (${ctx.days} days)`,
    actor: ctx.actor?.email || '—',
    tenant: ctx.tenantId,
    kpis,
    columns: labels,
    colWidths,
    rows: objectRowsToArrays(fetched.rows || [], config.columns),
    truncated: !!truncated,
    sheetName: config.sheetName || config.title,
    notes: fetched.meta?.notes || config.notes || [],
  };
}

// Best-effort audit — never throws into the request path.
async function audit(db, ctx, cardId, kind, summary, metadata) {
  try {
    await logAudit(db, {
      tenantId: ctx.tenantId,
      actor: ctx.actor || null,
      kind: `downloads.${kindSlug(cardId)}.${kind}`,
      target: { type: 'report', id: cardId },
      summary,
      metadata,
      req: ctx.req,
    });
  } catch {}
}

async function writeReportRun(db, ctx, config, extra = {}) {
  try {
    const tdoc = tenancy.tenantDoc(ctx.tenantId);
    await db.collection(`${tdoc}/reportRuns`).add({
      cardId: config.cardId,
      byUid: ctx.actor?.email || ctx.actor?.uid || null,
      from: ctx.from || null,
      to:   ctx.to || null,
      format: ctx.format,
      rowCount: extra.rowCount || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      durationMs: extra.durationMs || 0,
      storagePath: extra.storagePath || null,
      mode: extra.mode || 'sync',
    });
  } catch (err) {
    console.warn('[download-runner] reportRuns write failed:', err.message);
  }
}

// ── Main entry — handler factory ─────────────────────────────────────

function runDownload(config) {
  if (!config || !config.cardId) throw new Error('runDownload: cardId required');
  if (!Array.isArray(config.columns)) throw new Error('runDownload: columns[] required');
  if (typeof config.fetcher !== 'function') throw new Error('runDownload: fetcher() required');

  registerRunner(config.cardId, config);

  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    initializeFirebase();
    const db = admin.firestore();
    const tenantId = tenancy.getTenantId();
    const actor = req.user || null;

    const body = req.body || {};
    const isPreview = body.preview === true;
    const isDryRun  = body.dryRun === true;
    const needsRange = config.needsRange !== false;

    // ── Validate range / format ──────────────────────────────────────
    let from, to, days, format;
    if (needsRange) {
      const v = validateExportRequest(body, { maxDays: config.maxDays || 365 });
      if (v.error) return res.status(v.error.status).json(v.error.body);
      ({ from, to, days, format } = v);
    } else {
      format = String(body.format || 'xlsx').toLowerCase();
      if (!['xlsx', 'pdf', 'csv'].includes(format)) {
        return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" });
      }
      ({ from, to, days } = defaultRange());
    }

    const filters = body.filters || {};
    const ctx = { req, db, tenantId, actor, from, to, days, format, filters, needsRange };

    // ── Step-up re-auth (sensitive ops require fresh password) ──────
    // Preview + dryRun are read-only and don't need re-auth — they let
    // owners inspect the data shape before committing to the full pull.
    if (!isPreview && !isDryRun) {
      req.user = actor; // verifyReauth reads req.user
      const reauth = await verifyReauth(req, { maxAgeSec: config.reauthMaxAge || 300 });
      if (!reauth.ok) {
        await audit(db, ctx, config.cardId, 'reauth_failed',
          `Re-auth failed for ${config.cardId} download: ${reauth.error}`,
          { error: reauth.error, format, from, to });
        if (reauth.retryAfterSec) res.setHeader('Retry-After', reauth.retryAfterSec);
        return res.status(reauth.status).json({
          error: reauth.error,
          message: reauth.message,
          retryAfter: reauth.retryAfterSec,
        });
      }
      ctx.reauthAuthTime = reauth.authTime;
    }

    // ── Fetch ────────────────────────────────────────────────────────
    const startedAt = Date.now();
    let fetched;
    try {
      fetched = await config.fetcher(ctx);
      if (!fetched || !Array.isArray(fetched.rows)) {
        fetched = { rows: [], meta: {} };
      }
    } catch (err) {
      console.error(`[download-runner:${config.cardId}] fetcher failed:`, err);
      await audit(db, ctx, config.cardId, 'failed', 'Fetcher threw',
        { error: err.message, format, from, to });
      return res.status(500).json({ error: 'fetcher_failed' });
    }

    const rowCount = fetched.rows.length;
    const truncated = !!fetched.meta?.truncated;

    // ── Dry-run: just the count, no file. ────────────────────────────
    if (isDryRun) {
      await audit(db, ctx, config.cardId, 'dry_run',
        `Dry-run for ${config.cardId} (${rowCount} rows)`,
        { format, from, to, rowCount, filters });
      return res.status(200).json({ ok: true, dryRun: true, rowCount });
    }

    const payload = buildPayload(config, fetched, ctx, truncated);

    // ── Preview: sample + kpis + JSON. ───────────────────────────────
    if (isPreview) {
      const preview = buildPreview(payload, { sampleSize: PREVIEW_SAMPLE });
      await audit(db, ctx, config.cardId, 'preview',
        `Previewed ${config.cardId} (${rowCount} rows)`,
        { format, from, to, rowCount, filters });
      // The hub PreviewModal consumes `columns` + `sampleRows`; we also
      // expose `rowCount` + `kpis` per the M1 contract so callers that
      // don't render the modal can read a stable shape.
      return res.status(200).json({
        ok: true,
        preview: true,
        ...preview,
        rowCount,
        rows: preview.sampleRows,
      });
    }

    // ── Async / job branch (≥ ASYNC_THRESHOLD rows) ─────────────────
    //
    // The per-endpoint fetcher caps at MAX_ROWS (5000) so this branch
    // is effectively unreachable today. It stays here so removing the
    // fetcher-side cap (M2) transparently flips the endpoint into the
    // job system without changing call sites.
    if (rowCount >= ASYNC_THRESHOLD) {
      // Delegate: write a queued job doc + return a status URL. The
      // actual rendering will happen on the next poll from
      // /api/downloads/_jobs/start which re-runs the same fetcher.
      const jobRef = await db
        .collection(`${tenancy.tenantDoc(tenantId)}/exportJobs`)
        .add({
          status: 'queued',
          byUid: actor?.email || null,
          cardId: config.cardId,
          format, from, to, filters,
          rowCount,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      await audit(db, ctx, config.cardId, 'queued',
        `Queued ${config.cardId} export (${rowCount} rows)`,
        { format, from, to, jobId: jobRef.id });
      return res.status(200).json({
        ok: true,
        async: true,
        jobId: jobRef.id,
        statusUrl: `/api/downloads/_jobs/status?jobId=${jobRef.id}`,
      });
    }

    // ── Sync render + stream. ────────────────────────────────────────
    let out;
    try {
      out = await renderDownload(payload);
    } catch (err) {
      console.error(`[download-runner:${config.cardId}] render failed:`, err);
      await audit(db, ctx, config.cardId, 'failed', 'Renderer threw',
        { error: err.message, format, rowCount });
      return res.status(500).json({ error: 'render_failed' });
    }
    const durationMs = Date.now() - startedAt;

    await audit(db, ctx, config.cardId, 'export',
      `Downloaded ${config.cardId} report (${format.toUpperCase()})`,
      { format, from, to, filters, rows: rowCount, truncated,
        reauthAuthTime: ctx.reauthAuthTime, durationMs });
    await writeReportRun(db, ctx, config, { rowCount, durationMs, mode: 'sync' });

    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
  };
}

// ── Background job execution helper ──────────────────────────────────
//
// Used by /api/downloads/_jobs/start.js to render and upload to Storage.
// `actor` is the dashboard user that queued the job.
//
// Storage layout: exports/{tenantId}/{jobId}.{ext}
// Bucket lifecycle: operators MUST configure a rule that expires objects
// under `exports/**` after 30 days. We do NOT auto-delete here.
async function runJob({ jobId, cardId, format, from, to, filters, actor, tenantId }) {
  const config = getRunner(cardId);
  if (!config) throw new Error(`unknown_card:${cardId}`);

  initializeFirebase();
  const db = admin.firestore();
  const startedAt = Date.now();

  const ctx = {
    req: null, db, tenantId: tenantId || tenancy.getTenantId(), actor,
    from, to, days: 0, format, filters: filters || {},
    needsRange: config.needsRange !== false,
  };
  if (ctx.needsRange && from && to) {
    ctx.days = Math.ceil(
      (new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000,
    ) + 1;
  }

  const fetched = await config.fetcher(ctx);
  const rows = Array.isArray(fetched?.rows) ? fetched.rows : [];
  const payload = buildPayload(config, { rows, meta: fetched?.meta || {} }, ctx, !!fetched?.meta?.truncated);
  const out = await renderDownload(payload);

  const ext = format === 'xlsx' ? 'xlsx' : (format === 'pdf' ? 'pdf' : 'csv');
  const storagePath = `exports/${ctx.tenantId}/${jobId}.${ext}`;

  const storage = getFirebaseStorage();
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  await file.save(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf), {
    contentType: out.mime,
    resumable: false,
    metadata: { metadata: { cardId, jobId, queuedBy: actor?.email || '' } },
  });

  const durationMs = Date.now() - startedAt;
  await writeReportRun(db, ctx, config, {
    rowCount: rows.length, durationMs, mode: 'async', storagePath,
  });
  await audit(db, ctx, cardId, 'job_completed',
    `Completed background export ${cardId} (${rows.length} rows)`,
    { jobId, format, from, to, rowCount: rows.length, storagePath, durationMs });

  return {
    rowCount: rows.length,
    storagePath,
    contentType: out.mime,
    filename: out.filename,
    durationMs,
  };
}

module.exports = {
  runDownload,
  runJob,
  getRunner,
  RUNNERS,
  ASYNC_THRESHOLD,
  PREVIEW_SAMPLE,
};
module.exports.default = runDownload;
