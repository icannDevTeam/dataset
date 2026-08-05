import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const {
  deriveGradeBucket,
  normalizeClassLabel,
  splitRowsByGrade,
  compareGradeBucket,
} = require('../../../../lib/grade-utils');

const SHEET_ORDER = ['EY1', 'EY2', 'EY3', '1', '2', '3', '4', '5', 'UNASSIGNED'];

function tsToIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  return null;
}

function statusLabel(status) {
  if (status === 'changes_requested') return 'awaiting_parent';
  return String(status || 'pending');
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const status = String(req.query.status || 'all');
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;
  const fetchCap = Math.max(50, Math.min(2000, parseInt(req.query.fetchCap || '1000', 10)));
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

  if (!['all', 'pending', 'approved', 'rejected', 'archived', 'changes_requested'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();

    let q = db.collection(tenancy.pickupOnboardingPath(tid));
    if (status !== 'all') q = q.where('status', '==', status);

    const snap = await q.limit(fetchCap).get();

    const rows = [];
    const studentIds = new Set();
    const records = [];

    snap.forEach((d) => {
      const rec = { id: d.id, ...d.data() };
      records.push(rec);
      (rec.students || []).forEach((s) => {
        if (s && s.id) studentIds.add(String(s.id));
      });
    });

    const studentDocs = await Promise.all([...studentIds].map(async (sid) => {
      try {
        const s = await db.doc(`${tenancy.studentsPath(tid)}/${sid}`).get();
        if (s.exists) return [sid, s.data() || {}];
        const legacy = await db.doc(`students/${sid}`).get();
        return [sid, legacy.exists ? (legacy.data() || {}) : null];
      } catch {
        return [sid, null];
      }
    }));
    const studentMap = new Map(studentDocs);

    for (const rec of records) {
      const submittedAt = tsToIso(rec.submittedAt);
      if (from && submittedAt && submittedAt.slice(0, 10) < from) continue;
      if (to && submittedAt && submittedAt.slice(0, 10) > to) continue;

      for (const student of (rec.students || [])) {
        const sid = String(student?.id || '').trim();
        const dbStudent = sid ? (studentMap.get(sid) || null) : null;
        const effectiveHomeroom = dbStudent?.homeroom || student?.homeroom || null;
        const gradeBucket = deriveGradeBucket({
          gradeSelection: student?.gradeSelection,
          grade: dbStudent?.grade || student?.grade,
          className: student?.className,
          homeroom: effectiveHomeroom,
        });
        const classLabel = normalizeClassLabel({ homeroom: effectiveHomeroom });

        rows.push({
          submissionId: rec.id,
          formNumber: rec.formNumber || '',
          status: statusLabel(rec.status),
          statusRaw: String(rec.status || 'pending'),
          submittedAt: submittedAt || '',
          guardianName: rec?.guardian?.name || '',
          guardianPhone: rec?.guardian?.phone || '',
          guardianEmail: rec?.guardian?.email || '',
          studentId: sid,
          studentName: student?.name || dbStudent?.name || '',
          sourceHomeroom: student?.homeroom || '',
          effectiveHomeroom: effectiveHomeroom || '',
          gradeBucket,
          classLabel,
        });
      }
    }

    rows.sort((a, b) => {
      const g = compareGradeBucket(a.gradeBucket, b.gradeBucket);
      if (g !== 0) return g;
      const c = String(a.classLabel || '').localeCompare(String(b.classLabel || ''));
      if (c !== 0) return c;
      return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
    });

    // Lightweight JSON mode — used by the dashboard tracker so the on-screen
    // "forms by class" view covers ALL statuses (not just the active tab).
    if (String(req.query.format || '') === 'json') {
      return res.status(200).json({ ok: true, tenantId: tid, count: rows.length, rows });
    }

    const buckets = splitRowsByGrade(rows, (r) => r.gradeBucket);
    const ExcelJS = (await import('exceljs')).default || require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'BINUS School Simprug — Attendance Monitoring';
    wb.created = new Date();

    // Shared professional styling — clean navy header, bordered cells.
    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    const THIN_BORDER = {
      top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
    };
    function styleSheet(ws) {
      const header = ws.getRow(1);
      header.font = HEADER_FONT;
      header.alignment = { vertical: 'middle' };
      header.height = 22;
      header.eachCell((cell) => {
        cell.fill = HEADER_FILL;
        cell.border = THIN_BORDER;
      });
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n === 1) return;
        row.eachCell((cell) => { cell.border = THIN_BORDER; });
      });
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }

    const summary = wb.addWorksheet('Summary');
    summary.columns = [
      { header: 'Grade', key: 'grade', width: 18 },
      { header: 'Rows', key: 'rows', width: 10 },
      { header: 'Unique Forms', key: 'forms', width: 14 },
      { header: 'Unique Students', key: 'students', width: 16 },
    ];

    SHEET_ORDER.forEach((grade) => {
      const data = buckets[grade] || [];
      const formSet = new Set(data.map((r) => r.submissionId));
      const studentSet = new Set(data.map((r) => `${r.studentId || ''}:${r.studentName || ''}`));
      summary.addRow({
        grade,
        rows: data.length,
        forms: formSet.size,
        students: studentSet.size,
      });
    });
    summary.addRow({ grade: 'TOTAL', rows: rows.length, forms: new Set(rows.map((r) => r.submissionId)).size, students: new Set(rows.map((r) => `${r.studentId || ''}:${r.studentName || ''}`)).size });
    summary.getRow(summary.rowCount).font = { bold: true };
    styleSheet(summary);

    for (const grade of SHEET_ORDER) {
      const data = buckets[grade] || [];
      // Skip empty buckets so the workbook stays clean (Unassigned only
      // appears when something genuinely needs attention).
      if (data.length === 0 && grade === 'UNASSIGNED') continue;
      const name = grade === 'UNASSIGNED' ? 'Unassigned' : (grade.startsWith('EY') ? grade : `Grade ${grade}`);
      const ws = wb.addWorksheet(name);
      ws.columns = [
        { header: 'Submitted At', key: 'submittedAt', width: 22 },
        { header: 'Status', key: 'status', width: 18 },
        { header: 'Form Number', key: 'formNumber', width: 18 },
        { header: 'Submission ID', key: 'submissionId', width: 24 },
        { header: 'Guardian Name', key: 'guardianName', width: 24 },
        { header: 'Guardian Phone', key: 'guardianPhone', width: 18 },
        { header: 'Guardian Email', key: 'guardianEmail', width: 28 },
        { header: 'Student ID', key: 'studentId', width: 16 },
        { header: 'Student Name', key: 'studentName', width: 24 },
        { header: 'Source Homeroom', key: 'sourceHomeroom', width: 18 },
        { header: 'Effective Homeroom', key: 'effectiveHomeroom', width: 20 },
        { header: 'Grade Bucket', key: 'gradeBucket', width: 14 },
      ];
      (buckets[grade] || []).forEach((row) => ws.addRow(row));
      styleSheet(ws);
    }

    const buffer = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="BINUS-pickup-forms-by-class-${stamp}.xlsx"`);
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('[pickup/admin/onboarding-grade-workbook]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['GET'], permission: 'pickup_admin.view' });
