/**
 * /api/v2/presets — list & create saved report presets.
 *
 * GET  ?cardId=<id>?
 *   Lists presets owned by the caller PLUS presets where
 *   `sharedWithRoles` includes the caller's role.
 *   Optional `cardId` filter narrows to one card.
 *   Permission: any download key.
 *
 * POST { cardId, name, filters?, format?, from?, to?, range?, sharedWithRoles?, schedule? }
 *   Creates a new preset owned by the caller.
 *   Permission: downloads.manage_presets.
 *
 * Schedule shape (optional):
 *   { enabled: bool, cron: '0 6 * * *', format: 'xlsx', retentionDays: 90 }
 *   If enabled, server computes `nextRunAt` via lib/cron-parser.
 *
 * Audit kinds: presets.created.
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

function validatePayload(body) {
  const errors = [];
  const out = {};
  const cardId = String(body?.cardId || '').trim();
  if (!cardId || !getRunner(cardId)) errors.push('bad_cardId');
  out.cardId = cardId;

  const name = String(body?.name || '').trim();
  if (!name) errors.push('name_required');
  if (name.length > 80) errors.push('name_too_long');
  out.name = name;

  out.format = ['csv', 'xlsx', 'pdf'].includes(String(body?.format).toLowerCase())
    ? String(body.format).toLowerCase() : 'xlsx';

  out.filters = (body?.filters && typeof body.filters === 'object') ? body.filters : {};
  out.from = body?.from ? String(body.from).slice(0, 10) : null;
  out.to   = body?.to   ? String(body.to).slice(0, 10)   : null;
  out.range = body?.range ? String(body.range).slice(0, 20) : null;

  if (Array.isArray(body?.sharedWithRoles)) {
    out.sharedWithRoles = body.sharedWithRoles
      .map((r) => String(r).toLowerCase())
      .filter((r) => ALLOWED_ROLES.includes(r));
  } else {
    out.sharedWithRoles = [];
  }

  if (body?.schedule && typeof body.schedule === 'object') {
    const s = body.schedule;
    const sched = {
      enabled: !!s.enabled,
      cron: String(s.cron || '').trim(),
      format: ['csv', 'xlsx', 'pdf'].includes(String(s.format).toLowerCase())
        ? String(s.format).toLowerCase() : out.format,
      retentionDays: Math.max(1, Math.min(365, parseInt(s.retentionDays, 10) || 90)),
    };
    if (sched.enabled) {
      try {
        parseCron(sched.cron);
        sched.nextRunAt = nextCronAt(sched.cron) || null;
      } catch (e) {
        errors.push(`bad_cron:${e.message}`);
      }
    }
    out.schedule = sched;
  } else {
    out.schedule = null;
  }

  return { ok: errors.length === 0, errors, value: out };
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const actor = req.user || {};
  const myUid = actor.uid || actor.email || null;
  const myRole = String(actor.role || '').toLowerCase();
  const col = db.collection(tenancy.reportPresetsPath(tid));

  if (req.method === 'GET') {
    const cardId = String(req.query.cardId || '').trim();
    // Firestore can't OR on different fields cheaply — do two queries
    // (mine + shared) and merge.
    const mineQ = col.where('ownerUid', '==', myUid);
    const sharedQ = myRole ? col.where('sharedWithRoles', 'array-contains', myRole) : null;
    const [mineSnap, sharedSnap] = await Promise.all([
      mineQ.get(),
      sharedQ ? sharedQ.get() : Promise.resolve({ docs: [] }),
    ]);
    const seen = new Set();
    const presets = [];
    for (const d of [...mineSnap.docs, ...sharedSnap.docs]) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const data = d.data() || {};
      if (cardId && data.cardId !== cardId) continue;
      presets.push({
        id: d.id,
        ...data,
        createdAt: data.createdAt?.toMillis?.() || null,
        updatedAt: data.updatedAt?.toMillis?.() || null,
        schedule: data.schedule
          ? {
              ...data.schedule,
              nextRunAt: data.schedule.nextRunAt?.toMillis?.() || data.schedule.nextRunAt || null,
              lastRunAt: data.schedule.lastRunAt?.toMillis?.() || data.schedule.lastRunAt || null,
            }
          : null,
        isOwner: data.ownerUid === myUid,
      });
    }
    presets.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.status(200).json({ ok: true, presets });
  }

  if (req.method === 'POST') {
    // Permission check beyond withApi's anyPermission — POST requires manage_presets.
    const canManage = actor.superAdmin
      || (actor.permissions && actor.permissions['downloads.manage_presets'] === true);
    if (!canManage) return res.status(403).json({ error: 'forbidden_manage_presets' });

    const { ok, errors, value } = validatePayload(req.body || {});
    if (!ok) return res.status(400).json({ error: 'invalid', details: errors });

    const now = admin.firestore.FieldValue.serverTimestamp();
    const doc = {
      ...value,
      ownerUid: myUid,
      ownerEmail: actor.email || null,
      ownerName: actor.name || actor.email || null,
      createdAt: now,
      updatedAt: now,
    };
    const ref = await col.add(doc);

    try {
      await logAudit(db, {
        tenantId: tid, actor, kind: 'presets.created',
        target: { type: 'report_preset', id: ref.id, label: value.name },
        summary: `Saved preset "${value.name}" for ${value.cardId}`,
        metadata: { cardId: value.cardId, scheduled: !!value.schedule?.enabled, sharedWithRoles: value.sharedWithRoles },
        req,
      });
    } catch {}

    return res.status(201).json({ ok: true, id: ref.id });
  }

  return res.status(405).json({ error: 'method' });
}

export default withApi(handler, {
  methods: ['GET', 'POST'],
  anyPermission: DOWNLOAD_KEYS,
  rateLimit: 60,
});
