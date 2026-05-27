/**
 * /api/v2/presets/[id] — get/update/delete a saved preset.
 *
 * GET     — owner OR sharedWithRoles match.
 * PUT     — owner OR caller has downloads.download_compliance.
 *           Body accepts the same fields as POST (partial).
 * DELETE  — owner OR caller has downloads.download_compliance.
 *
 * All mutating verbs require `downloads.manage_presets`.
 *
 * Audit kinds: presets.updated, presets.deleted, presets.scheduled
 * (the last one only if `schedule` was added or its `enabled` flipped).
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');
const { getRunner } = require('../../../../lib/download-runner');
const { parseCron, nextCronAt } = require('../../../../lib/cron-parser');

export const config = { api: { bodyParser: { sizeLimit: '32kb' } } };

const DOWNLOAD_KEYS = [
  'downloads.download_operational',
  'downloads.download_directory',
  'downloads.download_security',
  'downloads.download_compliance',
];
const ALLOWED_ROLES = ['owner', 'admin', 'viewer', 'guard'];

function canSeePreset(data, actor) {
  const myUid = actor.uid || actor.email || null;
  const myRole = String(actor.role || '').toLowerCase();
  if (data.ownerUid === myUid) return true;
  if (Array.isArray(data.sharedWithRoles) && data.sharedWithRoles.includes(myRole)) return true;
  return false;
}

function canMutatePreset(data, actor) {
  const myUid = actor.uid || actor.email || null;
  if (data.ownerUid === myUid) return true;
  if (actor.superAdmin) return true;
  if (actor.permissions && actor.permissions['downloads.download_compliance'] === true) return true;
  return false;
}

function buildPatch(body, prev) {
  const out = {};
  const errors = [];
  if (typeof body.name === 'string') {
    const n = body.name.trim();
    if (!n) errors.push('name_required');
    if (n.length > 80) errors.push('name_too_long');
    out.name = n;
  }
  if (body.cardId) {
    const c = String(body.cardId);
    if (!getRunner(c)) errors.push('bad_cardId');
    out.cardId = c;
  }
  if (typeof body.format === 'string') {
    out.format = ['csv', 'xlsx', 'pdf'].includes(body.format.toLowerCase())
      ? body.format.toLowerCase() : 'xlsx';
  }
  if (body.filters && typeof body.filters === 'object') out.filters = body.filters;
  if (body.from !== undefined) out.from = body.from ? String(body.from).slice(0, 10) : null;
  if (body.to !== undefined) out.to = body.to ? String(body.to).slice(0, 10) : null;
  if (body.range !== undefined) out.range = body.range ? String(body.range).slice(0, 20) : null;
  if (Array.isArray(body.sharedWithRoles)) {
    out.sharedWithRoles = body.sharedWithRoles
      .map((r) => String(r).toLowerCase())
      .filter((r) => ALLOWED_ROLES.includes(r));
  }
  if (body.schedule !== undefined) {
    if (body.schedule === null) {
      out.schedule = null;
    } else if (typeof body.schedule === 'object') {
      const s = body.schedule;
      const sched = {
        enabled: !!s.enabled,
        cron: String(s.cron || prev?.schedule?.cron || '').trim(),
        format: ['csv', 'xlsx', 'pdf'].includes(String(s.format).toLowerCase())
          ? String(s.format).toLowerCase() : (prev?.schedule?.format || out.format || 'xlsx'),
        retentionDays: Math.max(1, Math.min(365, parseInt(s.retentionDays, 10) || prev?.schedule?.retentionDays || 90)),
      };
      if (sched.enabled) {
        try {
          parseCron(sched.cron);
          sched.nextRunAt = nextCronAt(sched.cron) || null;
        } catch (e) {
          errors.push(`bad_cron:${e.message}`);
        }
      }
      // preserve last-run history fields
      if (prev?.schedule?.lastRunAt) sched.lastRunAt = prev.schedule.lastRunAt;
      if (prev?.schedule?.lastRunStatus) sched.lastRunStatus = prev.schedule.lastRunStatus;
      out.schedule = sched;
    }
  }
  return { ok: errors.length === 0, errors, patch: out };
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const actor = req.user || {};
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'bad_id' });

  const ref = db.collection(tenancy.reportPresetsPath(tid)).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'not_found' });
  const data = snap.data() || {};

  if (req.method === 'GET') {
    if (!canSeePreset(data, actor)) return res.status(403).json({ error: 'forbidden' });
    return res.status(200).json({
      ok: true,
      preset: {
        id,
        ...data,
        createdAt: data.createdAt?.toMillis?.() || null,
        updatedAt: data.updatedAt?.toMillis?.() || null,
        schedule: data.schedule ? {
          ...data.schedule,
          nextRunAt: data.schedule.nextRunAt?.toMillis?.() || data.schedule.nextRunAt || null,
          lastRunAt: data.schedule.lastRunAt?.toMillis?.() || data.schedule.lastRunAt || null,
        } : null,
        isOwner: data.ownerUid === (actor.uid || actor.email),
      },
    });
  }

  // Mutating verbs require manage_presets
  const canManage = actor.superAdmin
    || (actor.permissions && actor.permissions['downloads.manage_presets'] === true);
  if (!canManage) return res.status(403).json({ error: 'forbidden_manage_presets' });
  if (!canMutatePreset(data, actor)) return res.status(403).json({ error: 'forbidden_not_owner' });

  if (req.method === 'PUT') {
    const { ok, errors, patch } = buildPatch(req.body || {}, data);
    if (!ok) return res.status(400).json({ error: 'invalid', details: errors });
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.update(patch);

    try {
      await logAudit(db, {
        tenantId: tid, actor, kind: 'presets.updated',
        target: { type: 'report_preset', id, label: data.name },
        summary: `Updated preset "${data.name}"`,
        metadata: { fields: Object.keys(patch) },
        req,
      });
      // Separately audit schedule changes — easier to alert on.
      const prevEnabled = !!data.schedule?.enabled;
      const nextEnabled = !!patch.schedule?.enabled;
      if ('schedule' in patch && prevEnabled !== nextEnabled) {
        await logAudit(db, {
          tenantId: tid, actor, kind: 'presets.scheduled',
          target: { type: 'report_preset', id, label: data.name },
          summary: nextEnabled
            ? `Enabled schedule on "${data.name}" (${patch.schedule?.cron})`
            : `Disabled schedule on "${data.name}"`,
          metadata: { cron: patch.schedule?.cron || null, enabled: nextEnabled },
          req,
        });
      }
    } catch {}

    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    await ref.delete();
    try {
      await logAudit(db, {
        tenantId: tid, actor, kind: 'presets.deleted',
        target: { type: 'report_preset', id, label: data.name },
        summary: `Deleted preset "${data.name}"`,
        metadata: { cardId: data.cardId },
        req,
      });
    } catch {}
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method' });
}

export default withApi(handler, {
  methods: ['GET', 'PUT', 'DELETE'],
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 60,
});
