/**
 * POST /api/downloads/daily-brief
 *
 * One-page-style operations brief for a date range (defaults to a single
 * day if from==to). Pulls a thin slice from every operational surface
 * and stacks the results as a single flattened table of:
 *
 *   [ section, key, value, detail ]
 *
 * Sections (in order):
 *   1. Attendance Summary         — counts per status
 *   2. Attendance by Grade        — counts per homeroom/grade
 *   3. Late >2 days               — students late on >2 days in range
 *   4. No-Shows (most recent day) — enrolled students with no scan on the latest date
 *   5. Terminal Uptime            — terminals whose last heartbeat is >1h old
 *   6. Pickups per Day            — daily pickup totals + distinct chaperones
 *   7. Top Exceptions             — security incidents in range
 *
 * Format
 * ──────
 * `runDownload` renders all three formats from the same payload. PDF is
 * the primary deliverable; CSV / XLSX simply emit the flattened table.
 * The shared PDF builder paginates the rows automatically — fine for a
 * brief whose row count is small by construction.
 *
 * Reads
 *   tenants/{tid}/attendance/{YYYY-MM-DD}/records/*  (with legacy fallback)
 *   tenants/{tid}/students                           (with student_metadata fallback)
 *   tenants/{tid}/terminals
 *   tenants/{tid}/pickup_events
 *   tenants/{tid}/security_incidents
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_DETAIL_ROWS = 25;       // per-section cap to keep the brief skim-able

function dateRange(from, to) {
  const out = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) { out.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}

function toIso(v) {
  if (!v) return '';
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function fetchAttendanceForDate(db, tid, date) {
  // Tenant path first; fall back to legacy root collection.
  let snap = await db.collection(`${tenancy.tenantDoc(tid)}/attendance/${date}/records`)
    .get().catch(() => null);
  if (!snap || snap.empty) {
    snap = await db.collection(`attendance/${date}/records`).get().catch(() => null);
  }
  const records = [];
  if (snap) snap.forEach((d) => records.push({ id: d.id, ...(d.data() || {}) }));
  return records;
}

async function buildStudentLookup(db, tid) {
  const map = {}; // empNo → { name, homeroom, grade }
  try {
    const tenantSnap = await db.collection(tenancy.studentsPath(tid)).get();
    tenantSnap.forEach((d) => {
      const s = d.data() || {};
      const key = s.binusId || s.binusianId || s.studentId || d.id;
      map[String(key)] = {
        name: s.name || s.fullName || '',
        homeroom: s.homeroom || s.class || '',
        grade: s.gradeCode || s.grade || '',
      };
    });
  } catch {}
  if (Object.keys(map).length === 0) {
    try {
      const legacy = await db.collection('student_metadata').get();
      legacy.forEach((d) => {
        const s = d.data() || {};
        map[d.id] = {
          name: s.name || '',
          homeroom: s.homeroom || '',
          grade: s.grade || s.gradeCode || '',
        };
      });
    } catch {}
  }
  return map;
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const dates = dateRange(ctx.from, ctx.to);
  const fromMs = new Date(ctx.from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(ctx.to   + 'T23:59:59+07:00').getTime();
  const nowMs  = Date.now();

  const studentMap = await buildStudentLookup(db, tid);

  // ── Attendance scans across the range ─────────────────────────────
  const scansByDate = new Map();           // date → records[]
  const lateDaysByStudent = new Map();     // empNo → Set<date>
  const statusTotals = { Present: 0, Late: 0, Absent: 0 };
  const byGrade = new Map();               // homeroom → count
  for (const date of dates) {
    const recs = await fetchAttendanceForDate(db, tid, date);
    scansByDate.set(date, recs);
    for (const r of recs) {
      const status = r.status || (r.late ? 'Late' : 'Present');
      statusTotals[status] = (statusTotals[status] || 0) + 1;
      const empNo = r.employeeNo || r.studentId || r.id;
      const meta = studentMap[empNo] || {};
      const homeroom = r.homeroom || meta.homeroom || 'Unknown';
      byGrade.set(homeroom, (byGrade.get(homeroom) || 0) + 1);
      if (status === 'Late' && empNo) {
        if (!lateDaysByStudent.has(empNo)) lateDaysByStudent.set(empNo, new Set());
        lateDaysByStudent.get(empNo).add(date);
      }
    }
  }

  // ── No-shows on the most-recent day ───────────────────────────────
  const latestDate = dates[dates.length - 1];
  const latestScans = scansByDate.get(latestDate) || [];
  const presentToday = new Set(latestScans.map((r) => String(r.employeeNo || r.studentId || r.id)));
  const noShows = [];
  for (const [empNo, meta] of Object.entries(studentMap)) {
    if (!presentToday.has(String(empNo))) {
      noShows.push({ empNo, name: meta.name, homeroom: meta.homeroom });
      if (noShows.length >= MAX_DETAIL_ROWS) break;
    }
  }

  // ── Terminals: flag heartbeats older than 1h ──────────────────────
  const terminalsSnap = await db.collection(tenancy.terminalsPath(tid))
    .get().catch(() => null);
  const staleTerminals = [];
  let terminalCount = 0;
  if (terminalsSnap) {
    terminalsSnap.forEach((d) => {
      terminalCount++;
      const t = d.data() || {};
      const lastIso = toIso(t.lastHeartbeat || t.lastSeen || t.updatedAt);
      const lastMs = lastIso ? Date.parse(lastIso) : 0;
      const drift = lastMs ? nowMs - lastMs : Infinity;
      if (drift > ONE_HOUR_MS) {
        staleTerminals.push({
          id: d.id,
          name: t.name || t.label || '\u2014',
          last: lastIso ? lastIso.slice(0, 19).replace('T', ' ') : 'never',
          driftMin: drift === Infinity ? '\u221e' : Math.round(drift / 60000),
        });
      }
    });
  }

  // ── Pickups per day + distinct chaperones ─────────────────────────
  const pickupsSnap = await db.collection(tenancy.pickupEventsPath(tid))
    .orderBy('createdAt', 'desc').limit(2000).get().catch(() => null);
  const pickupsByDate = new Map();         // date → { count, chaperones:Set }
  if (pickupsSnap) {
    pickupsSnap.forEach((d) => {
      const e = d.data() || {};
      const iso = toIso(e.createdAt || e.ts || e.timestamp);
      const ms = iso ? Date.parse(iso) : NaN;
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;
      const date = iso.slice(0, 10);
      if (!pickupsByDate.has(date)) pickupsByDate.set(date, { count: 0, chaperones: new Set() });
      const bucket = pickupsByDate.get(date);
      bucket.count++;
      const chap = e.chaperoneId || e.chaperoneName;
      if (chap) bucket.chaperones.add(String(chap));
    });
  }

  // ── Security incidents (top exceptions) ───────────────────────────
  const incSnap = await db.collection(tenancy.securityIncidentsPath(tid))
    .limit(1000).get().catch(() => null);
  const topIncidents = [];
  if (incSnap) {
    incSnap.forEach((d) => {
      const r = d.data() || {};
      const iso = toIso(r.timestamp || r.createdAt);
      const ms = iso ? Date.parse(iso) : NaN;
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;
      topIncidents.push({
        at: iso.slice(0, 19).replace('T', ' '),
        type: r.type || r.kind || 'unknown',
        source: r.terminalId || r.gate || r.source || '\u2014',
        note: r.notes || r.summary || '',
      });
    });
  }
  topIncidents.sort((a, b) => (a.at < b.at ? 1 : -1));

  // ── Flatten ───────────────────────────────────────────────────────
  const rows = [];
  const push = (section, key, value, detail = '') =>
    rows.push({ section, key, value: String(value), detail: String(detail) });

  // 1. Attendance Summary
  for (const [k, v] of Object.entries(statusTotals)) push('Attendance Summary', k, v, '');
  push('Attendance Summary', 'Total scans',
    (statusTotals.Present || 0) + (statusTotals.Late || 0), `${dates.length} day(s)`);

  // 2. Attendance by Grade
  const grades = [...byGrade.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DETAIL_ROWS);
  for (const [hr, count] of grades) push('Attendance by Grade', hr, count, '');
  if (!grades.length) push('Attendance by Grade', '—', 0, 'no scans in range');

  // 3. Late list (>2 days)
  const lateMulti = [...lateDaysByStudent.entries()]
    .filter(([, set]) => set.size > 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, MAX_DETAIL_ROWS);
  for (const [empNo, set] of lateMulti) {
    const meta = studentMap[empNo] || {};
    push('Late >2 Days', meta.name || empNo, `${set.size} days`, meta.homeroom || '');
  }
  if (!lateMulti.length) push('Late >2 Days', '—', 0, 'none');

  // 4. No-Shows
  for (const s of noShows) push('No-Shows (latest day)', s.name || s.empNo, s.homeroom || '', latestDate);
  if (!noShows.length) push('No-Shows (latest day)', '—', 0, latestDate);

  // 5. Terminal Uptime
  push('Terminal Uptime', 'Total terminals', terminalCount, '');
  push('Terminal Uptime', 'Stale (>1h)', staleTerminals.length, '');
  for (const t of staleTerminals.slice(0, MAX_DETAIL_ROWS)) {
    push('Terminal Uptime', t.name, `${t.driftMin} min`, `${t.id} · last ${t.last}`);
  }

  // 6. Pickups per Day
  const pickupDates = [...pickupsByDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [date, b] of pickupDates) {
    push('Pickups', date, b.count, `${b.chaperones.size} chaperones`);
  }
  if (!pickupDates.length) push('Pickups', '—', 0, 'no pickups in range');

  // 7. Top Exceptions
  for (const i of topIncidents.slice(0, MAX_DETAIL_ROWS)) {
    push('Top Exceptions', i.type, i.source, `${i.at} · ${i.note}`.trim());
  }
  if (!topIncidents.length) push('Top Exceptions', '—', 0, 'no incidents');

  return { rows, meta: { truncated: false, notes: [
    `Range: ${ctx.from} → ${ctx.to} (${dates.length} day(s))`,
    `Per-section detail rows capped at ${MAX_DETAIL_ROWS}.`,
  ] } };
}

function kpis(rows) {
  // Surface the headline counts from the flattened table.
  const get = (section, key) => {
    const r = rows.find((x) => x.section === section && x.key === key);
    return r ? r.value : '0';
  };
  return [
    ['Present',          get('Attendance Summary', 'Present')],
    ['Late',             get('Attendance Summary', 'Late')],
    ['Total scans',      get('Attendance Summary', 'Total scans')],
    ['No-shows (today)', String(rows.filter((r) => r.section === 'No-Shows (latest day)' && r.key !== '\u2014').length)],
    ['Stale terminals',  get('Terminal Uptime', 'Stale (>1h)')],
    ['Late >2 days',     String(rows.filter((r) => r.section === 'Late >2 Days' && r.key !== '\u2014').length)],
  ];
}

export default withApi(runDownload({
  cardId: 'daily-brief',
  title: 'Daily Operations Brief',
  subtitle: 'Attendance, lates, no-shows, uptime, pickups, exceptions',
  theme: 'indigo',
  sheetName: 'Daily Brief',
  maxDays: 31,
  needsRange: true,
  columns: [
    { id: 'section', label: 'Section', width: 22 },
    { id: 'key',     label: 'Item',    width: 28 },
    { id: 'value',   label: 'Value',   width: 14 },
    { id: 'detail',  label: 'Detail',  width: 36 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
