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
const crypto = require('crypto');
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
  // Single source of truth for `tenants/{tid}/reportRuns/{runId}` writes —
  // sync, preview, dryRun and async (runJob / _jobs/start) all funnel here
  // so the doc shape stays consistent and M2 history + M4 PDF replay can
  // rely on the same fields.
  try {
    const tdoc = tenancy.tenantDoc(ctx.tenantId);
    const actor = ctx.actor || {};
    const filters = ctx.filters || {};
    const filtersHash = hashFilters(filters);
    const filtersRedacted = redactFilters(filters);
    const doc = {
      cardId: config.cardId,
      // `byUid` is the stable id we filter "mine only" by. Our auth layer
      // doesn't expose a Firebase uid on req.user, so we fall back to the
      // email — same id used by the sync path historically.
      byUid:   actor.uid || actor.email || null,
      byEmail: actor.email || null,
      byName:  actor.name || actor.displayName || null,
      from: ctx.from || null,
      to:   ctx.to || null,
      format: ctx.format,
      filters: filtersRedacted,
      filtersHash,
      rowCount: extra.rowCount || 0,
      bytesOut: extra.bytesOut || 0,
      mode: extra.mode || 'sync',
      status: extra.status || 'completed',
      storagePath: extra.storagePath || null,
      storageObjectPath: extra.storagePath
        ? `gs://${extra.bucketName || ''}/${extra.storagePath}`
        : null,
      redactionsApplied: extra.redactionsApplied || [],
      sha256: extra.sha256 || null,
      verifyToken: extra.verifyToken || null,
      errorMessage: extra.errorMessage || null,
      errorAt: extra.errorMessage ? admin.firestore.FieldValue.serverTimestamp() : null,
      durationMs: extra.durationMs || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (extra.runId) {
      await db.collection(`${tdoc}/reportRuns`).doc(extra.runId).set(doc);
      return extra.runId;
    }
    const ref = await db.collection(`${tdoc}/reportRuns`).add(doc);
    return ref.id;
  } catch (err) {
    console.warn('[download-runner] reportRuns write failed:', err.message);
    return null;
  }
}

// ── Filter redaction ─────────────────────────────────────────────────
//
// Filter values may contain obvious PII (e.g. a `studentId` used to scope
// a report to one student). We never want raw PII sitting in the
// `reportRuns` log. The allow-list below passes through known-safe keys
// (date ranges, status enums, homeroom names) and hashes anything that
// looks like a personal identifier.
const PII_FILTER_KEYS = new Set([
  'studentId', 'employeeNo', 'binusId', 'email', 'phone', 'parentEmail',
  'parentPhone', 'cardNo', 'chaperoneId', 'parentName', 'guardianName',
]);
function hashFilters(filters) {
  try {
    return crypto.createHash('sha256')
      .update(JSON.stringify(filters || {}))
      .digest('hex').slice(0, 32);
  } catch { return null; }
}
function redactFilters(filters) {
  if (!filters || typeof filters !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === '') continue;
    if (PII_FILTER_KEYS.has(k)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      out[k] = 'sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── M7: row-level PII redaction ──────────────────────────────────────
//
// Columns may declare `pii: 'name' | 'binusId' | 'email' | 'phone'` in
// their config. When the caller passes `redact: true` on the request
// body we transform those values in-place before rendering. The set of
// redaction kinds actually applied is recorded on `reportRuns` so an
// auditor can confirm a given export was sanitised.
//
// Transformations:
//   name    → initials ("Alice Wonderland" → "A. W.")
//   binusId → last 3 digits ("BN20240012345" → "•••2345")
//   email   → first char + domain ("alice@b.edu" → "a***@b.edu")
//   phone   → last 4 digits ("+62 812 3456 7890" → "•••• •••• 7890")
function redactName(v) {
  if (v == null) return '';
  const parts = String(v).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map((p) => p[0].toUpperCase() + '.').join(' ');
}
function redactBinusId(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.length <= 3) return s;
  return '•••' + s.slice(-3);
}
function redactEmail(v) {
  if (v == null) return '';
  const s = String(v);
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return s[0] + '***' + s.slice(at);
}
function redactPhone(v) {
  if (v == null) return '';
  const digits = String(v).replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  return '•••• ' + digits.slice(-4);
}
const REDACTORS = {
  name:    redactName,
  binusId: redactBinusId,
  email:   redactEmail,
  phone:   redactPhone,
};
function applyRedaction(rows, columns) {
  const piiCols = columns
    .map((c, idx) => ({ idx, kind: c.pii, key: c.id }))
    .filter((c) => c.kind && REDACTORS[c.kind]);
  if (piiCols.length === 0) return { rows, applied: [] };
  const applied = Array.from(new Set(piiCols.map((c) => c.kind)));
  const isArrayShape = Array.isArray(rows[0]);
  const next = rows.map((r) => {
    if (isArrayShape) {
      const copy = r.slice();
      for (const c of piiCols) copy[c.idx] = REDACTORS[c.kind](copy[c.idx]);
      return copy;
    }
    const copy = { ...r };
    for (const c of piiCols) copy[c.key] = REDACTORS[c.kind](copy[c.key]);
    return copy;
  });
  return { rows: next, applied };
}

// ── M7: deterministic content hash of the rendered row set ───────────
//
// Used as the human-readable verification token on the file footer
// ("verify:abc12345"). Computed over the row payload BEFORE rendering
// so a recipient can recompute it from the data alone. The full
// sha256 of the rendered file bytes is separately stored on
// `reportRuns.sha256` for binary-level verification.
function rowsContentHash(rows, columns) {
  try {
    const colIds = columns.map((c) => c.id);
    const norm = rows.map((r) => {
      if (Array.isArray(r)) return r;
      return colIds.map((id) => (r && r[id] != null ? r[id] : ''));
    });
    return crypto.createHash('sha256')
      .update(JSON.stringify(norm))
      .digest('hex');
  } catch { return null; }
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
    const redact = body.redact === true;
    const ctx = { req, db, tenantId, actor, from, to, days, format, filters, needsRange, redact };

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
      await writeReportRun(db, ctx, config, {
        mode: isPreview ? 'preview' : (isDryRun ? 'dry_run' : 'sync'),
        status: 'failed', errorMessage: err.message,
      });
      return res.status(500).json({ error: 'fetcher_failed' });
    }

    const rowCount = fetched.rows.length;
    const truncated = !!fetched.meta?.truncated;

    // ── M7: PII redaction (opt-in per request via body.redact) ──────
    let redactionsApplied = [];
    if (ctx.redact) {
      const r = applyRedaction(fetched.rows, config.columns);
      fetched.rows = r.rows;
      redactionsApplied = r.applied;
    }

    // ── Dry-run: just the count, no file. ────────────────────────────
    if (isDryRun) {
      await audit(db, ctx, config.cardId, 'dry_run',
        `Dry-run for ${config.cardId} (${rowCount} rows)`,
        { format, from, to, rowCount, filters });
      await writeReportRun(db, ctx, config, {
        rowCount, mode: 'dry_run', status: 'completed',
        durationMs: Date.now() - startedAt,
      });
      return res.status(200).json({ ok: true, dryRun: true, rowCount });
    }

    const payload = buildPayload(config, fetched, ctx, truncated);

    // ── M7: watermark + verification token on every rendered file ───
    // `verifyToken` = first 12 hex chars of sha256(normalized-rows).
    // Appended as a footer note so recipients can recompute it from
    // the raw data. Binary sha256 is computed after render below.
    const verifyToken = (rowsContentHash(fetched.rows, config.columns) || '').slice(0, 12);
    const watermark = `Generated by ${ctx.actor?.email || '—'} · ${new Date().toISOString()} · verify:${verifyToken || 'n/a'}`;
    payload.notes = Array.isArray(payload.notes) ? payload.notes.slice() : [];
    payload.notes.push(watermark);
    if (redactionsApplied.length > 0) {
      payload.notes.push(`PII redacted: ${redactionsApplied.join(', ')}.`);
    }

    // ── Preview: sample + kpis + JSON. ───────────────────────────────
    if (isPreview) {
      const preview = buildPreview(payload, { sampleSize: PREVIEW_SAMPLE });
      await audit(db, ctx, config.cardId, 'preview',
        `Previewed ${config.cardId} (${rowCount} rows)`,
        { format, from, to, rowCount, filters });
      await writeReportRun(db, ctx, config, {
        rowCount, mode: 'preview', status: 'completed',
        durationMs: Date.now() - startedAt,
      });
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
      await writeReportRun(db, ctx, config, {
        rowCount, mode: 'sync', status: 'failed',
        errorMessage: err.message, durationMs: Date.now() - startedAt,
      });
      return res.status(500).json({ error: 'render_failed' });
    }
    const durationMs = Date.now() - startedAt;
    const buf = Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf);
    // M7: full SHA-256 over rendered bytes — stored on reportRuns so an
    // auditor can later verify a re-downloaded artifact matches the
    // original. The verifyToken in the footer is the short prefix of
    // a data-only hash (independent of binary format).
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    // Persist sync result to Storage so:
    //   • M2: hub "Recently run" rail can re-download without re-running.
    //   • M4: PDF replay can rebuild without re-fetching the raw rows.
    // Fire-and-forget: never block the user's response on Storage.
    const ext = format === 'xlsx' ? 'xlsx' : (format === 'pdf' ? 'pdf' : 'csv');
    const runId = db.collection('_ids').doc().id; // pre-allocate so storagePath + reportRuns share it
    const storagePath = `exports/${ctx.tenantId}/${runId}.${ext}`;
    let bucketName = '';
    try {
      const bucket = getFirebaseStorage().bucket();
      bucketName = bucket.name;
      // Fire-and-forget; swallow + log on failure.
      bucket.file(storagePath).save(buf, {
        contentType: out.mime,
        resumable: false,
        metadata: { metadata: { cardId: config.cardId, runId, mode: 'sync',
          byEmail: ctx.actor?.email || '' } },
      }).catch((err) => {
        console.warn(`[download-runner:${config.cardId}] storage tee failed:`, err.message);
      });
    } catch (err) {
      console.warn(`[download-runner:${config.cardId}] storage tee init failed:`, err.message);
    }

    await audit(db, ctx, config.cardId, 'export',
      `Downloaded ${config.cardId} report (${format.toUpperCase()})`,
      { format, from, to, filters, rows: rowCount, truncated,
        reauthAuthTime: ctx.reauthAuthTime, durationMs, runId,
        sha256, verifyToken, redactionsApplied });
    await writeReportRun(db, ctx, config, {
      runId, rowCount, durationMs, mode: 'sync', status: 'completed',
      storagePath, bucketName, bytesOut: buf.length,
      sha256, verifyToken, redactionsApplied,
    });

    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
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
async function runJob({ jobId, cardId, format, from, to, filters, actor, tenantId, redact }) {
  const config = getRunner(cardId);
  if (!config) throw new Error(`unknown_card:${cardId}`);

  initializeFirebase();
  const db = admin.firestore();
  const startedAt = Date.now();

  const ctx = {
    req: null, db, tenantId: tenantId || tenancy.getTenantId(), actor,
    from, to, days: 0, format, filters: filters || {},
    needsRange: config.needsRange !== false, redact: redact === true,
  };
  if (ctx.needsRange && from && to) {
    ctx.days = Math.ceil(
      (new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000,
    ) + 1;
  }

  const fetched = await config.fetcher(ctx);
  let rows = Array.isArray(fetched?.rows) ? fetched.rows : [];
  let redactionsApplied = [];
  if (ctx.redact) {
    const r = applyRedaction(rows, config.columns);
    rows = r.rows;
    redactionsApplied = r.applied;
  }
  const payload = buildPayload(config, { rows, meta: fetched?.meta || {} }, ctx, !!fetched?.meta?.truncated);
  const verifyToken = (rowsContentHash(rows, config.columns) || '').slice(0, 12);
  payload.notes = Array.isArray(payload.notes) ? payload.notes.slice() : [];
  payload.notes.push(`Generated by ${actor?.email || '—'} · ${new Date().toISOString()} · verify:${verifyToken || 'n/a'}`);
  if (redactionsApplied.length > 0) {
    payload.notes.push(`PII redacted: ${redactionsApplied.join(', ')}.`);
  }
  const out = await renderDownload(payload);

  const ext = format === 'xlsx' ? 'xlsx' : (format === 'pdf' ? 'pdf' : 'csv');
  const storagePath = `exports/${ctx.tenantId}/${jobId}.${ext}`;

  const storage = getFirebaseStorage();
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const buf = Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  await file.save(buf, {
    contentType: out.mime,
    resumable: false,
    metadata: { metadata: { cardId, jobId, queuedBy: actor?.email || '', sha256 } },
  });

  const durationMs = Date.now() - startedAt;
  await writeReportRun(db, ctx, config, {
    runId: jobId, rowCount: rows.length, durationMs, mode: 'async',
    status: 'completed', storagePath, bucketName: bucket.name,
    bytesOut: buf.length, sha256, verifyToken, redactionsApplied,
  });
  await audit(db, ctx, cardId, 'job_completed',
    `Completed background export ${cardId} (${rows.length} rows)`,
    { jobId, format, from, to, rowCount: rows.length, storagePath, durationMs,
      sha256, verifyToken, redactionsApplied });

  return {
    rowCount: rows.length,
    storagePath,
    contentType: out.mime,
    filename: out.filename,
    durationMs,
    sha256,
    verifyToken,
    redactionsApplied,
  };
}

module.exports = {
  runDownload,
  runJob,
  getRunner,
  writeReportRun,
  RUNNERS,
  ASYNC_THRESHOLD,
  PREVIEW_SAMPLE,
};
module.exports.default = runDownload;
