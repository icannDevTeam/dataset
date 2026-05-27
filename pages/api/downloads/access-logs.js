/**
 * POST /api/downloads/access-logs
 * Dashboard sign-ins from root `access_logs` collection. Thin wrapper
 * over `lib/download-runner` — see that file for the shared mechanics
 * (re-auth, preview, dry-run, audit, async dispatch).
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const fromMs = new Date(ctx.from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(ctx.to   + 'T23:59:59+07:00').getTime();

  // Read root `access_logs` (legacy schema). The tenant copy is
  // dual-written, so a future migration can swap the source without
  // changing the row shape.
  const snap = await db.collection('access_logs').orderBy('timestamp', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const r = d.data() || {};
      const tsObj = r.timestamp?.toDate ? r.timestamp.toDate() : null;
      const tsIso = tsObj ? tsObj.toISOString() : (typeof r.timestamp === 'string' ? r.timestamp : null);
      if (!tsIso) return;
      const ms = Date.parse(tsIso);
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;
      const wibHour = ((ms + 7 * 3600 * 1000) / 3600000) % 24 | 0;
      rows.push({
        timestamp: tsIso.slice(0, 19).replace('T', ' '),
        email:   r.email || '\u2014',
        name:    r.name || '',
        ip:      r.ip || '\u2014',
        device:  r.device || '',
        browser: r.browser || '',
        os:      r.os || '',
        action:  r.action || 'login',
        _offHours: wibHour < 6 || wibHour >= 21,
      });
    });
  }
  return { rows, meta: { truncated, notes: [
    'Off-hours threshold: any sign-in between 21:00 and 06:00 WIB.',
    'Source: root collection `access_logs` (mirrored to tenant collection).',
  ] } };
}

function kpis(rows, ctx) {
  const userSet = new Set(), ipSet = new Set();
  let offHours = 0;
  for (const r of rows) { userSet.add(r.email); ipSet.add(r.ip); if (r._offHours) offHours++; }
  return [
    ['Total sign-ins',          rows.length.toLocaleString()],
    ['Unique users',            userSet.size.toLocaleString()],
    ['Unique IPs',              ipSet.size.toLocaleString()],
    ['Off-hours (9pm\u20136am WIB)', offHours.toLocaleString()],
    ['Days covered',            ctx.days],
    ['Avg per day',             ctx.days ? Math.round(rows.length / ctx.days) : 0],
  ];
}

export default withApi(runDownload({
  cardId: 'access-logs',
  title: 'Dashboard Access Log',
  subtitle: 'Sign-in events across the admin console',
  theme: 'green',
  sheetName: 'Access Logs',
  maxDays: 365,
  columns: [
    { id: 'timestamp', label: 'Timestamp', width: 13 },
    { id: 'email',     label: 'Email',     width: 18 },
    { id: 'name',      label: 'Name',      width: 14 },
    { id: 'ip',        label: 'IP',        width: 11 },
    { id: 'device',    label: 'Device',    width: 9 },
    { id: 'browser',   label: 'Browser',   width: 11 },
    { id: 'os',        label: 'OS',        width: 10 },
    { id: 'action',    label: 'Action',    width: 8 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_security', rateLimit: 30 });
