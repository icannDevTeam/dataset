/**
 * POST /api/downloads/system-health
 *
 * Operational snapshot — terminals online/offline + 24h attendance volume +
 * 24h pickup volume + last audit activity. Always "now"; no range UI.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

const ONLINE_WINDOW_SEC = 5 * 60;
const DAY_SEC = 24 * 60 * 60;

function toIso(v) {
  if (!v) return '';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const fmt = String(req.body?.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();
  const nowSec = Math.floor(Date.now() / 1000);
  const since24hMs = (nowSec - DAY_SEC) * 1000;

  // Terminals snapshot — one row per terminal with online state.
  const tSnap = await db.collection(tenancy.terminalsPath(tid))
    .limit(MAX_ROWS)
    .get()
    .catch(() => null);

  const rows = [];
  let onlineCount = 0, offlineCount = 0;

  if (tSnap) {
    tSnap.forEach((d) => {
      const t = d.data() || {};
      const lastIso = toIso(t.lastHeartbeat || t.lastSeen || t.updatedAt);
      const lastSec = lastIso ? Math.floor(new Date(lastIso).getTime() / 1000) : 0;
      const isOnline = lastSec && (nowSec - lastSec) <= ONLINE_WINDOW_SEC;
      if (isOnline) onlineCount++; else offlineCount++;
      const ageSec = lastSec ? (nowSec - lastSec) : 0;
      const ageStr = !lastSec ? 'never'
        : ageSec < 60 ? `${ageSec}s ago`
        : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago`
        : ageSec < DAY_SEC ? `${Math.floor(ageSec / 3600)}h ago`
        : `${Math.floor(ageSec / DAY_SEC)}d ago`;
      rows.push([
        'terminal',
        d.id,
        t.name || t.label || '—',
        t.type || (t.ip ? 'hikvision' : 'unknown'),
        t.location || t.gate || '',
        isOnline ? 'ONLINE' : 'OFFLINE',
        ageStr,
        lastIso ? lastIso.slice(0, 19).replace('T', ' ') : '—',
      ]);
    });
  }

  // 24-hour activity counts — keep cheap with count() aggregation if
  // available; fall back to a bounded read if not.
  async function countSince(path, field = 'createdAt') {
    try {
      const ref = db.collection(path).where(field, '>=', admin.firestore.Timestamp.fromMillis(since24hMs));
      const agg = await ref.count().get();
      return agg.data().count;
    } catch {
      try {
        const snap = await db.collection(path)
          .where(field, '>=', admin.firestore.Timestamp.fromMillis(since24hMs))
          .limit(MAX_ROWS)
          .get();
        return snap.size;
      } catch { return 0; }
    }
  }

  // Attendance is stored per-day under `attendance/{YYYY-MM-DD}/records/*`
  // so we count today's records directly instead of doing a 24h sweep.
  async function attendanceTodayCount() {
    try {
      const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      const path = `${tenancy.attendanceDayDoc(today, tid)}/records`;
      const agg = await db.collection(path).count().get();
      return agg.data().count;
    } catch { return 0; }
  }

  const [attendanceToday, pickup24h, onboarding24h] = await Promise.all([
    attendanceTodayCount(),
    countSince(tenancy.pickupEventsPath(tid)),
    countSince(tenancy.pickupOnboardingPath(tid)),
  ]);

  // Activity row right after terminal block so the report tells a story.
  rows.push(['activity', 'attendance-today', 'Attendance scans (today)', 'metric', '', '—', '—', String(attendanceToday)]);
  rows.push(['activity', '24h-pickup',       'Pickup releases (24h)',    'metric', '', '—', '—', String(pickup24h)]);
  rows.push(['activity', '24h-onboarding',   'Onboarding forms (24h)',   'metric', '', '—', '—', String(onboarding24h)]);

  const totalTerminals = onlineCount + offlineCount;
  const onlinePct = totalTerminals ? `${((onlineCount / totalTerminals) * 100).toFixed(1)}%` : '—';

  const payload = {
    format: fmt,
    kind: 'system-health',
    dateStamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    title: 'System Health Snapshot',
    subtitle: 'Terminal status + 24-hour activity volumes',
    theme: 'red',
    range: `Snapshot · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Terminals total',  String(totalTerminals)],
      ['Online',           String(onlineCount)],
      ['Offline',          String(offlineCount)],
      ['Online rate',      onlinePct],
      ['Attendance today', String(attendanceToday)],
      ['Pickups / 24h',    String(pickup24h)],
    ],
    columns: ['Kind', 'ID', 'Name', 'Type', 'Location', 'Status', 'Last Seen', 'Value / Heartbeat'],
    colWidths: [9, 16, 22, 9, 12, 8, 12, 22],
    rows,
    truncated: false,
    sheetName: 'Health',
    notes: [`"Online" = terminal heartbeat within last ${Math.round(ONLINE_WINDOW_SEC / 60)} minutes.`],
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid, actor: req.user || null,
        kind: 'downloads.system_health.reauth_failed',
        target: { type: 'report', id: 'system-health' },
        summary: `Re-auth failed for system health download: ${reauth.error}`,
        metadata: { error: reauth.error, format: fmt },
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
      kind: 'downloads.system_health.export',
      target: { type: 'report', id: 'system-health', label: out.filename },
      summary: `Downloaded system health snapshot (${fmt.toUpperCase()})`,
      metadata: { format: fmt, onlineCount, offlineCount, attendanceToday, pickup24h, onboarding24h, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
