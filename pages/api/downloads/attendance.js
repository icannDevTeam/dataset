/**
 * POST /api/downloads/attendance
 *
 * Branded export of facial-attendance scans across a date range.
 * Pulls from root `attendance/{YYYY-MM-DD}/records/*` (legacy schema).
 *
 * Body: { format, from, to, filters?: { class, status }, preview?, dryRun? }
 *
 * All cross-cutting concerns (re-auth, audit, preview, dry-run, async job
 * dispatch, render + stream) live in lib/download-runner.js — this file is
 * just the fetcher + column config for the attendance dataset.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function dateRange(from, to) {
  const out = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) { out.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return out;
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const filterClass  = ctx.filters?.class  ? String(ctx.filters.class).trim()  : null;
  const filterStatus = ctx.filters?.status ? String(ctx.filters.status).trim() : null;

  // Build the studentId → { homeroom, grade, name } lookup once. We merge
  // the legacy `student_metadata` collection with the canonical `students`
  // collection so newly enrolled students still resolve a homeroom.
  const [metaSnap, studentsSnap] = await Promise.all([
    db.collection('student_metadata').get(),
    db.collection('students').get().catch(() => ({ forEach: () => {} })),
  ]);
  const metaMap = {};
  metaSnap.forEach((d) => {
    const x = d.data() || {};
    metaMap[d.id] = { homeroom: x.homeroom || '', grade: x.grade || x.gradeCode || '', name: x.name || '' };
  });
  studentsSnap.forEach((d) => {
    const x = d.data() || {};
    if (!metaMap[d.id]) metaMap[d.id] = { homeroom: x.homeroom || '', grade: x.gradeCode || x.grade || '', name: x.name || '' };
  });

  const rows = [];
  let truncated = false;
  for (const date of dateRange(ctx.from, ctx.to)) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const snap = await db.collection('attendance').doc(date).collection('records').get().catch(() => null);
    if (!snap) continue;
    snap.forEach((doc) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const r = doc.data() || {};
      const empNo = r.employeeNo || r.studentId || '';
      const meta = metaMap[empNo] || {};
      const homeroom = r.homeroom || meta.homeroom || '';
      const grade = r.grade || meta.grade || '';
      const status = r.status || (r.late ? 'Late' : 'Present');
      if (filterClass  && homeroom !== filterClass)  return;
      if (filterStatus && status   !== filterStatus) return;
      const ts = (r.timestamp || '').slice(0, 19).replace('T', ' ');
      rows.push({
        date,
        time:       ts || '\u2014',
        student:    r.name || meta.name || '\u2014',
        empNo:      empNo || '\u2014',
        homeroom:   homeroom || '\u2014',
        grade:      grade || '\u2014',
        status,
        source:     r.source || r.terminal || '\u2014',
        confidence: r.confidence != null ? Number(r.confidence).toFixed(2) : '',
      });
    });
  }
  const notes = [
    filterClass  ? `Filtered by homeroom: ${filterClass}`  : null,
    filterStatus ? `Filtered by status: ${filterStatus}`   : null,
  ].filter(Boolean);
  return { rows, meta: { truncated, notes } };
}

function kpis(rows, ctx) {
  const total = rows.length;
  let late = 0; const studentSet = new Set();
  for (const r of rows) {
    if (r.status === 'Late') late++;
    studentSet.add(r.empNo || r.student);
  }
  const onTime = total - late;
  const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '\u2014';
  return [
    ['Total scans',     total.toLocaleString()],
    ['Unique students', studentSet.size.toLocaleString()],
    ['On-time',         `${onTime.toLocaleString()} (${pct(onTime, total)})`],
    ['Late',            `${late.toLocaleString()} (${pct(late, total)})`],
    ['Days covered',    ctx.days],
    ['Avg scans / day', ctx.days ? Math.round(total / ctx.days) : 0],
  ];
}

export default withApi(runDownload({
  cardId: 'attendance',
  title: 'Attendance Report',
  subtitle: 'Facial recognition attendance scans',
  theme: 'teal',
  sheetName: 'Attendance',
  maxDays: 365,
  columns: [
    { id: 'date',       label: 'Date',        width: 9 },
    { id: 'time',       label: 'Time',        width: 11 },
    { id: 'student',    label: 'Student',     width: 22 },
    { id: 'empNo',      label: 'Employee No', width: 10 },
    { id: 'homeroom',   label: 'Homeroom',    width: 10 },
    { id: 'grade',      label: 'Grade',       width: 8 },
    { id: 'status',     label: 'Status',      width: 9 },
    { id: 'source',     label: 'Source',      width: 12 },
    { id: 'confidence', label: 'Confidence',  width: 9 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
