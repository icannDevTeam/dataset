/**
 * POST /api/downloads/late-absence-trend
 *
 * Weekly per-student lateness/absence trend across a date range.
 * Late comes from the attendance record status; absence = no record
 * on a school day (Mon–Fri) while present in the roster.
 *
 * Reads:
 *   • tenants/{tid}/students  +  legacy student_metadata    (roster)
 *   • tenants/{tid}/attendance/{date}/records  (per day)    (with legacy fallback)
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function dateRange(from, to) {
  const out = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) { out.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}
function isWeekend(dateStr) {
  // UTC noon avoids any TZ drift around midnight.
  const d = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return d === 0 || d === 6;
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const delta = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

async function buildRoster(db, tid) {
  const map = new Map(); // sid -> { name, homeroom }
  try {
    const snap = await db.collection(tenancy.studentsPath(tid)).get();
    snap.forEach((d) => {
      const s = d.data() || {};
      const sid = String(s.binusId || s.binusianId || s.studentId || d.id);
      map.set(sid, {
        name:     s.name || s.fullName || '',
        homeroom: s.homeroom || s.class || '',
      });
    });
  } catch {}
  if (map.size === 0) {
    try {
      const legacy = await db.collection('student_metadata').get();
      legacy.forEach((d) => {
        const s = d.data() || {};
        map.set(String(d.id), {
          name:     s.name || '',
          homeroom: s.homeroom || '',
        });
      });
    } catch {}
  }
  return map;
}

async function fetchAttendance(db, tid, date) {
  let snap = await db.collection(`${tenancy.tenantDoc(tid)}/attendance/${date}/records`)
    .get().catch(() => null);
  if (!snap || snap.empty) {
    snap = await db.collection(`attendance/${date}/records`).get().catch(() => null);
  }
  const out = new Map(); // sid -> status string
  if (snap) {
    snap.forEach((d) => {
      const r = d.data() || {};
      const sid = String(r.employeeNo || r.studentId || d.id);
      const status = r.status || (r.late ? 'Late' : 'Present');
      out.set(sid, status);
    });
  }
  return out;
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();

  const allDays = dateRange(ctx.from, ctx.to);
  const schoolDays = allDays.filter((d) => !isWeekend(d));

  const roster = await buildRoster(db, tid);

  // sid -> Map<date, 'Late' | 'Present' | 'Absent'>
  const status = new Map();
  for (const sid of roster.keys()) status.set(sid, new Map());

  for (const date of schoolDays) {
    const today = await fetchAttendance(db, tid, date);
    // Mark statuses for known students.
    for (const sid of roster.keys()) {
      const s = today.get(sid);
      let lbl;
      if (s) lbl = /late/i.test(s) ? 'Late' : 'Present';
      else   lbl = 'Absent';
      status.get(sid).set(date, lbl);
    }
    // Students appearing in attendance but not in roster — track too.
    for (const [sid, s] of today.entries()) {
      if (roster.has(sid)) continue;
      roster.set(sid, { name: '', homeroom: '' });
      const m = new Map();
      // Backfill prior school days as Absent so streak math is consistent.
      for (const d of schoolDays) {
        if (d > date) break;
        m.set(d, d === date ? (/late/i.test(s) ? 'Late' : 'Present') : 'Absent');
      }
      status.set(sid, m);
    }
  }

  // Group school days by week (Monday key).
  const weeksOrder = [];
  const daysByWeek = new Map(); // monday -> [dates]
  for (const d of schoolDays) {
    const wk = mondayOf(d);
    if (!daysByWeek.has(wk)) { daysByWeek.set(wk, []); weeksOrder.push(wk); }
    daysByWeek.get(wk).push(d);
  }

  const rows = [];
  let truncated = false;
  let totalLate = 0, totalAbsent = 0;
  const lateHeavyStudents = new Set();
  const absentHeavyStudents = new Set();

  for (const [sid, info] of roster.entries()) {
    const perDay = status.get(sid) || new Map();
    for (const wk of weeksOrder) {
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      const days = daysByWeek.get(wk);
      let lateCount = 0, absenceCount = 0, hasAny = false;
      for (const d of days) {
        const s = perDay.get(d);
        if (s === 'Late')   { lateCount++; hasAny = true; }
        if (s === 'Absent') { absenceCount++; hasAny = true; }
        if (s === 'Present') hasAny = true;
      }
      if (!hasAny) continue; // skip weeks completely outside the student's data
      // Streak of consecutive school days late ending at last school day of
      // the week within range. Walk back from the last day.
      let streakLate = 0;
      for (let i = days.length - 1; i >= 0; i--) {
        if (perDay.get(days[i]) === 'Late') streakLate++;
        else break;
      }
      const escalate = (lateCount >= 3) || (streakLate >= 3);
      if (lateCount === 0 && absenceCount === 0 && streakLate === 0) continue;
      totalLate    += lateCount;
      totalAbsent  += absenceCount;
      if (lateCount    >= 3) lateHeavyStudents.add(sid);
      if (absenceCount >= 3) absentHeavyStudents.add(sid);
      rows.push({
        studentId:       sid,
        name:            info.name || '',
        homeroom:        info.homeroom || '',
        weekStart:       wk,
        lateCount,
        absenceCount,
        streakLate,
        escalationFlag:  escalate ? 'YES' : '',
      });
    }
    if (truncated) break;
  }

  rows.sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 :
                       (a.homeroom || '').localeCompare(b.homeroom || '') ||
                       (a.name     || '').localeCompare(b.name     || '')));

  const notes = [
    'Absence = no attendance record on a school day (Mon–Fri) for a roster student.',
    'Holidays are not excluded — verify weeks against the school calendar.',
    'streakLate = consecutive school days late ending at the last in-range school day of the week.',
  ];
  return {
    rows,
    meta: {
      truncated,
      notes,
      _kpi: {
        lateHeavy:    lateHeavyStudents.size,
        absentHeavy:  absentHeavyStudents.size,
        totalLate,
        totalAbsent,
      },
    },
  };
}

function kpis(rows, ctx) {
  // Recompute defensively — fetcher's meta is opaque to the runner.
  let totalLate = 0, totalAbsent = 0;
  const lateHeavy = new Set(), absentHeavy = new Set();
  const lateByStudent = new Map(), absentByStudent = new Map();
  for (const r of rows) {
    totalLate    += Number(r.lateCount    || 0);
    totalAbsent  += Number(r.absenceCount || 0);
    lateByStudent.set(r.studentId,   (lateByStudent.get(r.studentId)   || 0) + Number(r.lateCount    || 0));
    absentByStudent.set(r.studentId, (absentByStudent.get(r.studentId) || 0) + Number(r.absenceCount || 0));
  }
  for (const [sid, n] of lateByStudent.entries())   if (n >= 3) lateHeavy.add(sid);
  for (const [sid, n] of absentByStudent.entries()) if (n >= 3) absentHeavy.add(sid);
  return [
    ['Students late ≥ 3',    lateHeavy.size.toLocaleString()],
    ['Students absent ≥ 3',  absentHeavy.size.toLocaleString()],
    ['Total late events',    totalLate.toLocaleString()],
    ['Total absence events', totalAbsent.toLocaleString()],
    ['Days covered',         ctx.days],
  ];
}

export default withApi(runDownload({
  cardId: 'late-absence-trend',
  title: 'Late & Absence Trend',
  subtitle: 'Weekly per-student streaks and escalation flags',
  theme: 'orange',
  sheetName: 'Late & Absence',
  maxDays: 365,
  columns: [
    { id: 'studentId',      label: 'Student ID',      width: 12 },
    { id: 'name',           label: 'Name',            width: 22 },
    { id: 'homeroom',       label: 'Homeroom',        width: 10 },
    { id: 'weekStart',      label: 'Week Start (Mon)', width: 12 },
    { id: 'lateCount',      label: 'Late (wk)',       width: 9 },
    { id: 'absenceCount',   label: 'Absent (wk)',     width: 10 },
    { id: 'streakLate',     label: 'Streak Late',     width: 10 },
    { id: 'escalationFlag', label: 'Escalate?',       width: 9 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
