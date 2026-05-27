/**
 * POST /api/downloads/unknown-faces
 *
 * Faces detected by terminals/mobile but not matched to any enrolled
 * student — sourced from `tenants/{tid}/security_incidents` where
 * `type == 'unknown_face'`.
 *
 * Notes
 * ─────
 * The shared PDF renderer in lib/downloads-helpers.js renders a uniform
 * columns+rows table — it does not currently embed images. We therefore
 * surface `photoPath` as a plain Storage path string; operators can
 * resolve it via the Storage console or the existing signed-URL helper
 * if they need the thumbnail.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function toIso(v) {
  if (!v) return '';
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(ctx.from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(ctx.to   + 'T23:59:59+07:00').getTime();

  // Pull a generous slice of the most recent unknown_face incidents and
  // filter in-memory. Avoids a composite index requirement on
  // (type, createdAt) and is fine within MAX_ROWS.
  let snap = await db.collection(tenancy.securityIncidentsPath(tid))
    .where('type', '==', 'unknown_face')
    .limit(MAX_ROWS + 1).get().catch(() => null);

  // Fallback for legacy schemas that used `kind` instead of `type`.
  if (!snap || snap.empty) {
    snap = await db.collection(tenancy.securityIncidentsPath(tid))
      .where('kind', '==', 'unknown_face')
      .limit(MAX_ROWS + 1).get().catch(() => null);
  }

  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const r = d.data() || {};
      const createdIso = toIso(r.createdAt || r.timestamp);
      const createdMs = createdIso ? Date.parse(createdIso) : NaN;
      if (Number.isNaN(createdMs) || createdMs < fromMs || createdMs > toMs) return;
      rows.push({
        createdAt:  createdIso ? createdIso.slice(0, 19).replace('T', ' ') : '\u2014',
        source:     r.terminalId || r.terminal || r.source || r.gate || '\u2014',
        confidence: r.confidence != null ? Number(r.confidence).toFixed(2) : '',
        photoPath:  r.photoPath || r.photo_path || r.image || '',
        gate:       r.gate || '',
        notes:      r.notes || r.summary || '',
        _hour:      Number.isNaN(createdMs) ? -1 : new Date(createdMs + 7 * 3600 * 1000).getUTCHours(),
      });
    });
  }

  return { rows, meta: { truncated, notes: [
    'Photos are stored in Firebase Storage; this export emits the path only.',
    'Type filter: security_incidents.type == "unknown_face".',
  ] } };
}

function kpis(rows, ctx) {
  const terminals = new Set();
  const byHour = new Map();
  for (const r of rows) {
    if (r.source && r.source !== '\u2014') terminals.add(r.source);
    if (r._hour >= 0) byHour.set(r._hour, (byHour.get(r._hour) || 0) + 1);
  }
  let peakHour = '\u2014';
  let peakCount = 0;
  for (const [h, c] of byHour.entries()) {
    if (c > peakCount) { peakHour = String(h).padStart(2, '0') + ':00'; peakCount = c; }
  }
  return [
    ['Total unknown faces', rows.length.toLocaleString()],
    ['Distinct terminals',  terminals.size.toLocaleString()],
    ['Peak hour',           peakHour + (peakCount ? ` (${peakCount})` : '')],
    ['Days covered',        ctx.days],
  ];
}

export default withApi(runDownload({
  cardId: 'unknown-faces',
  title: 'Unknown Faces',
  subtitle: 'Faces detected but not matched to any enrolled student',
  theme: 'red',
  sheetName: 'Unknown Faces',
  maxDays: 365,
  needsRange: true,
  columns: [
    { id: 'createdAt',  label: 'When',       width: 13 },
    { id: 'source',     label: 'Terminal',   width: 12 },
    { id: 'confidence', label: 'Confidence', width: 8  },
    { id: 'photoPath',  label: 'Photo Path', width: 28 },
    { id: 'gate',       label: 'Gate',       width: 8  },
    { id: 'notes',      label: 'Notes',      width: 18 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_security', rateLimit: 30 });
