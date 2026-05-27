/**
 * Vercel Cron route — runs every 15 minutes to execute due preset
 * schedules. Skips `withApi` entirely so it can be invoked without
 * a signed-in user.
 *
 * Auth:
 *   - In production: requires `Authorization: Bearer ${CRON_SECRET}`.
 *     Vercel Cron automatically sets this header when CRON_SECRET is
 *     configured as an env var on the deployment.
 *   - Vercel also sends `x-vercel-cron: 1` for verified cron invocations;
 *     we honour that as a fallback so the route still works on Pro plans
 *     that don't surface CRON_SECRET.
 *   - Any other request is rejected with 401.
 *
 * Behaviour:
 *   - Iterates every tenant under root `tenants/*` collection.
 *   - For each tenant, scans `reportPresets` where `schedule.enabled === true`
 *     AND `schedule.nextRunAt <= now`.
 *   - For each due preset:
 *       1. Resolves date window (preset.range → today-relative; else
 *          preset.from/to; else fallback to yesterday/today).
 *       2. Writes `exportJobs/{jobId}` doc.
 *       3. Calls `runJob` synchronously (5min Vercel Pro budget).
 *       4. Updates preset.schedule.{lastRunAt, lastRunStatus, nextRunAt}.
 *       5. Marks reportRuns older than retentionDays as `expiredAt = now`
 *          (does NOT delete Storage — bucket lifecycle handles that).
 *
 * Failures inside the loop are swallowed; the route always returns
 * `{ ok: true, processed, errors }` so Vercel doesn't mark the cron
 * unhealthy on a single bad preset.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
const tenancy = require('../../../lib/tenancy');
const { runJob } = require('../../../lib/download-runner');
const { nextCronAt } = require('../../../lib/cron-parser');
const { logAudit } = require('../../../lib/audit-log');

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

function authorize(req) {
  // Trim to defend against env vars accidentally saved with trailing
  // whitespace/newline (a common Vercel UI paste hazard).
  const secret = (process.env.CRON_SECRET || '').trim();
  const header = String(req.headers['authorization'] || '').trim();
  if (secret) {
    if (header === `Bearer ${secret}`) return true;
    // Also accept the bare token (some cron callers strip the scheme).
    if (header === secret) return true;
  }
  if (String(req.headers['x-vercel-cron'] || '').trim() === '1') return true;
  if (process.env.NODE_ENV !== 'production' && req.query?.dev === '1') return true;
  return false;
}

function resolveWindow(preset) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // Static from/to overrides everything.
  if (preset.from && preset.to) return { from: preset.from, to: preset.to };
  // range:'last7' → 7-day rolling window ending today.
  const range = String(preset.range || '').toLowerCase();
  if (range === 'today') return { from: today, to: today };
  if (range === 'yesterday') return { from: yesterday, to: yesterday };
  if (range.startsWith('last')) {
    const n = parseInt(range.slice(4), 10);
    if (Number.isFinite(n) && n > 0) {
      const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      return { from, to: today };
    }
  }
  // Default: yesterday-only (good for daily morning briefs).
  return { from: yesterday, to: yesterday };
}

async function listTenantIds(db) {
  const snap = await db.collection('tenants').get();
  const ids = snap.docs.map((d) => d.id).filter(Boolean);
  if (ids.length === 0) ids.push(tenancy.getTenantId());
  return ids;
}

async function applyRetention(db, tid, preset, retentionDays) {
  if (!retentionDays) return 0;
  const cutoff = Date.now() - retentionDays * 86400000;
  const runs = await db.collection(tenancy.reportRunsPath(tid))
    .where('cardId', '==', preset.cardId)
    .where('byUid', '==', preset.ownerUid)
    .get();
  let marked = 0;
  const batch = db.batch();
  for (const d of runs.docs) {
    const r = d.data();
    const created = r.createdAt?.toMillis?.() || 0;
    if (created && created < cutoff && !r.expiredAt) {
      batch.update(d.ref, { expiredAt: admin.firestore.FieldValue.serverTimestamp() });
      marked += 1;
    }
  }
  if (marked > 0) await batch.commit();
  return marked;
}

async function runOnePreset(db, tid, presetDoc) {
  const preset = presetDoc.data();
  const presetRef = presetDoc.ref;
  const sched = preset.schedule || {};
  const window = resolveWindow(preset);
  const fmt = sched.format || preset.format || 'xlsx';
  const jobRef = await db.collection(`${tenancy.tenantDoc(tid)}/exportJobs`).add({
    status: 'queued',
    cardId: preset.cardId,
    format: fmt,
    from: window.from,
    to: window.to,
    filters: preset.filters || {},
    byUid: preset.ownerUid,
    byEmail: preset.ownerEmail,
    source: 'cron',
    presetId: presetDoc.id,
    presetName: preset.name,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let outcome = 'success';
  let errorMessage = null;
  try {
    const result = await runJob({
      jobId: jobRef.id,
      cardId: preset.cardId,
      format: fmt,
      from: window.from,
      to: window.to,
      filters: preset.filters || {},
      actor: {
        uid: preset.ownerUid,
        email: preset.ownerEmail,
        name: preset.ownerName,
        role: 'system-cron',
        permissions: {},
      },
      tenantId: tid,
    });
    await jobRef.update({
      status: 'completed',
      rowCount: result.rowCount,
      storagePath: result.storagePath,
      contentType: result.contentType,
      filename: result.filename,
      durationMs: result.durationMs,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  } catch (err) {
    outcome = 'failed';
    errorMessage = String(err?.message || err);
    console.error(`[cron] preset ${presetDoc.id} (${preset.cardId}) failed:`, errorMessage);
    await jobRef.update({
      status: 'failed',
      error: errorMessage,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  const next = nextCronAt(sched.cron, new Date());
  await presetRef.update({
    'schedule.lastRunAt': admin.firestore.FieldValue.serverTimestamp(),
    'schedule.lastRunStatus': outcome,
    'schedule.lastRunJobId': jobRef.id,
    'schedule.lastRunError': errorMessage,
    'schedule.nextRunAt': next ? admin.firestore.Timestamp.fromDate(next) : null,
  }).catch(() => {});

  try {
    await applyRetention(db, tid, preset, sched.retentionDays);
  } catch (e) {
    console.warn(`[cron] retention sweep failed for ${presetDoc.id}:`, e.message);
  }

  try {
    await logAudit(db, {
      tenantId: tid,
      actor: { email: preset.ownerEmail, name: preset.ownerName, role: 'system-cron' },
      kind: `presets.scheduled_run.${outcome}`,
      target: { type: 'report_preset', id: presetDoc.id, label: preset.name },
      summary: `Scheduled run of "${preset.name}" (${preset.cardId}) ${outcome}`,
      metadata: { jobId: jobRef.id, cardId: preset.cardId, window, errorMessage },
    });
  } catch {}

  return { ok: outcome === 'success', jobId: jobRef.id, presetId: presetDoc.id };
}

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  initializeFirebase();
  const db = admin.firestore();
  const startedAt = Date.now();
  const now = admin.firestore.Timestamp.now();

  let processed = 0;
  let errors = 0;
  let scanned = 0;
  let tenants = 0;

  try {
    const tenantIds = await listTenantIds(db);
    tenants = tenantIds.length;
    for (const tid of tenantIds) {
      let dueSnap;
      try {
        dueSnap = await db.collection(tenancy.reportPresetsPath(tid))
          .where('schedule.enabled', '==', true)
          .where('schedule.nextRunAt', '<=', now)
          .get();
      } catch (e) {
        // Most likely a missing composite index on a tenant that has
        // never used schedules — safe to skip.
        console.warn(`[cron] tenant ${tid} due-query failed:`, e.message);
        continue;
      }
      scanned += dueSnap.size;
      for (const doc of dueSnap.docs) {
        try {
          const r = await runOnePreset(db, tid, doc);
          if (r.ok) processed += 1; else errors += 1;
        } catch (e) {
          errors += 1;
          console.error(`[cron] runOnePreset crashed for ${doc.id}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[cron] top-level error:', e.message);
    return res.status(500).json({ error: 'cron_failed', message: e.message });
  }

  return res.status(200).json({
    ok: true,
    tenants,
    scanned,
    processed,
    errors,
    durationMs: Date.now() - startedAt,
  });
}

export default handler;
