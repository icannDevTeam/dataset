/**
 * POST /api/downloads/device-sync
 *
 * Snapshot per-terminal sync status: when each terminal last checked in
 * (`lastHeartbeat`), seconds of drift vs. server `now`, and a derived
 * status bucket.
 *
 *   online  : drift < 10 min
 *   stale   : 10 min ≤ drift ≤ 1 h
 *   offline : drift > 1 h   (or never heartbeat'd)
 *
 * `studentsEnrolled` is best-effort: only populated when student docs
 * carry a `terminalId` / `terminals[]` scope; otherwise blank.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

const ONLINE_SEC = 10 * 60;       // < 10 min  → online
const STALE_SEC  = 60 * 60;       // 10-60 min → stale, else → offline

function toIso(v) {
  if (!v) return '';
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

function statusOf(driftSec) {
  if (driftSec == null || driftSec < 0) return 'offline';
  if (driftSec < ONLINE_SEC) return 'online';
  if (driftSec <= STALE_SEC) return 'stale';
  return 'offline';
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();

  // Best-effort enrolment counts per terminal id.
  const enrolByTerminal = new Map();
  try {
    const stuSnap = await db.collection(tenancy.studentsPath(tid))
      .limit(MAX_ROWS + 1).get();
    stuSnap.forEach((d) => {
      const s = d.data() || {};
      const ids = new Set();
      if (s.terminalId) ids.add(String(s.terminalId));
      if (Array.isArray(s.terminals)) s.terminals.forEach((t) => ids.add(String(t)));
      if (Array.isArray(s.enrolledTerminals)) s.enrolledTerminals.forEach((t) => ids.add(String(t)));
      for (const tid2 of ids) {
        enrolByTerminal.set(tid2, (enrolByTerminal.get(tid2) || 0) + 1);
      }
    });
  } catch { /* leave map empty */ }

  const snap = await db.collection(tenancy.terminalsPath(tid))
    .limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  const nowSec = Math.floor(Date.now() / 1000);

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const t = d.data() || {};
      const lastIso = toIso(t.lastHeartbeat || t.lastSeen || t.updatedAt);
      const lastSec = lastIso ? Math.floor(Date.parse(lastIso) / 1000) : 0;
      const driftSec = lastSec ? Math.max(0, nowSec - lastSec) : null;
      const enrolled = enrolByTerminal.get(d.id);
      rows.push({
        id:               d.id,
        name:             t.name || t.label || '\u2014',
        type:             t.type || t.kind || '',
        location:         t.location || t.gate || '',
        ip:               t.ip || '',
        firmware:         t.firmware || t.version || '',
        lastSync:         lastIso ? lastIso.slice(0, 19).replace('T', ' ') : '\u2014',
        driftSec:         driftSec == null ? '\u2014' : driftSec,
        status:           statusOf(driftSec),
        studentsEnrolled: enrolled != null ? enrolled : '',
      });
    });
  }

  return { rows, meta: { truncated, notes: [
    `online < ${ONLINE_SEC}s drift  ·  stale ≤ ${STALE_SEC}s  ·  offline > ${STALE_SEC}s`,
    enrolByTerminal.size === 0
      ? 'studentsEnrolled is blank: no student docs in this tenant carry a terminalId scope.'
      : 'studentsEnrolled counts students whose terminalId/terminals[] includes the given terminal.',
  ] } };
}

function kpis(rows) {
  let online = 0, stale = 0, offline = 0;
  for (const r of rows) {
    if (r.status === 'online') online++;
    else if (r.status === 'stale') stale++;
    else offline++;
  }
  return [
    ['Total terminals', rows.length.toLocaleString()],
    ['Online',          online.toLocaleString()],
    ['Stale',           stale.toLocaleString()],
    ['Offline',         offline.toLocaleString()],
    ['Online rate',     rows.length ? `${((online / rows.length) * 100).toFixed(1)}%` : '\u2014'],
  ];
}

export default withApi(runDownload({
  cardId: 'device-sync',
  title: 'Device Sync Report',
  subtitle: 'Per-terminal: enrolled count, last sync, drift, status',
  theme: 'sky',
  sheetName: 'Device Sync',
  needsRange: false,
  columns: [
    { id: 'id',               label: 'ID',         width: 10 },
    { id: 'name',             label: 'Name',       width: 16 },
    { id: 'type',             label: 'Type',       width: 9  },
    { id: 'location',         label: 'Location',   width: 12 },
    { id: 'ip',               label: 'IP',         width: 12 },
    { id: 'firmware',         label: 'Firmware',   width: 9  },
    { id: 'lastSync',         label: 'Last Sync',  width: 17 },
    { id: 'driftSec',         label: 'Drift (s)',  width: 8  },
    { id: 'status',           label: 'Status',     width: 8  },
    { id: 'studentsEnrolled', label: 'Enrolled',   width: 9  },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
