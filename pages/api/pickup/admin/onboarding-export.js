/**
 * POST /api/pickup/admin/onboarding-export
 *
 * Generates a parameterised onboarding-forms export in CSV / XLSX / PDF.
 * Mirrors the pickup-report export endpoint but operates on the
 * pickup_onboarding collection.
 *
 * Body:
 *   {
 *     format: 'xlsx' | 'pdf' | 'csv',
 *     status?: 'all'|'pending'|'approved'|'rejected',
 *     grade?: number|string,
 *     homeroom?: string,
 *     studentId?: string,
 *     from?:'YYYY-MM-DD', to?:'YYYY-MM-DD',
 *     sections?: { summary, records, chaperones, audit },
 *     includeChaperonePhotos?: bool   // XLSX only
 *   }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { auditLogPath, logAudit } = require('../../../../lib/audit-log');

export const config = {
  api: { bodyParser: { sizeLimit: '256kb' }, responseLimit: false },
};

const DEFAULT_SECTIONS = { summary: true, records: true, chaperones: false, audit: true };

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function gradeOf(homeroom) {
  if (!homeroom) return null;
  const m = String(homeroom).match(/^(\d{1,2})/);
  return m ? parseInt(m[1], 10) : null;
}
function tsToIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  return null;
}
function safeStr(v, f = '') { return v == null ? f : String(v); }
function escCsv(v) {
  const s = safeStr(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function loadOnboardingRecords(db, tid, { status, grade, homeroom, studentId, from, to }) {
  let q = db.collection(tenancy.pickupOnboardingPath(tid));
  if (status && status !== 'all') q = q.where('status', '==', status);
  const snap = await q.limit(2000).get();
  const records = [];
  snap.forEach((d) => {
    const r = { id: d.id, ...d.data() };
    const submittedIso = tsToIso(r.submittedAt);
    if (from && submittedIso && submittedIso.slice(0, 10) < from) return;
    if (to   && submittedIso && submittedIso.slice(0, 10) > to)   return;
    const students = (r.students || []).map((s) => ({
      id: s.id, name: s.name, homeroom: s.homeroom || null,
    }));
    const matchStudent = students.some((s) => {
      if (studentId && s.id !== studentId) return false;
      if (homeroom && (s.homeroom || '').toUpperCase() !== homeroom) return false;
      if (grade != null && gradeOf(s.homeroom) !== Number(grade)) return false;
      return true;
    });
    if (!matchStudent && (studentId || homeroom || grade != null)) return;

    const allocMap = new Map();
    (r.allocatedChaperones || []).forEach((a, i) => allocMap.set(i, a.chaperoneId));

    const chaperones = (r.chaperones || []).map((c, i) => ({
      name: c.name, relation: c.relation,
      phone: c.phone || null, email: c.email || null,
      idNumber: c.idNumber || null,
      authorizedStudentIds: c.authorizedStudentIds || [],
      allocatedId: allocMap.get(i) || null,
      faceCount: (c.facePaths || []).length,
      facePaths: c.facePaths || [],
    }));

    records.push({
      id: r.id, status: r.status,
      submittedAt: submittedIso,
      guardian: r.guardian || null,
      students, chaperones,
      reviewedAt: tsToIso(r.reviewedAt),
      reviewedBy: r.reviewedBy || null,
      rejectionReason: r.rejectionReason || null,
    });
  });
  records.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
  return records;
}

async function loadAuditEntries(db, tid, { from, to }) {
  const snap = await db.collection(auditLogPath(tid)).orderBy('at', 'desc').limit(1000).get();
  const fromMs = from ? Date.parse(from + 'T00:00:00+07:00') : 0;
  const toMs   = to   ? Date.parse(to   + 'T23:59:59+07:00') : Date.now() + 86400000;
  const out = [];
  snap.forEach((d) => {
    const e = d.data() || {};
    const ts = e.at ? Date.parse(e.at) : NaN;
    if (Number.isNaN(ts) || ts < fromMs || ts > toMs) return;
    if (!/^(pickup_admin\.|chaperone\.|onboarding\.|user\.)/.test(e.kind || '')) return;
    out.push({
      at: e.at, kind: e.kind,
      actor: e.actor?.email || e.actor?.name || '—',
      target: e.target?.label || e.target?.id || '',
      summary: e.summary || '',
    });
  });
  return out;
}

async function fetchPhotoBuffer(bucket, path) {
  if (!bucket || !path) return null;
  try { const [buf] = await bucket.file(path).download(); return buf; }
  catch { return null; }
}

function flattenRecords(records) {
  const rows = [];
  records.forEach((r) => {
    const students   = r.students.length   ? r.students   : [{}];
    const chaperones = r.chaperones.length ? r.chaperones : [{}];
    students.forEach((s) => chaperones.forEach((c) => {
      rows.push([
        r.id, r.status, (r.submittedAt || '').slice(0,19).replace('T',' '),
        (r.reviewedAt || '').slice(0,19).replace('T',' '), r.reviewedBy || '',
        r.guardian?.name || '', r.guardian?.email || '', r.guardian?.phone || '',
        s.id || '', s.name || '', s.homeroom || '',
        c.name || '', c.relation || '', c.phone || '', c.email || '',
        c.idNumber || '', c.allocatedId || '', c.faceCount || 0,
        r.rejectionReason || '',
      ]);
    }));
  });
  return rows;
}

const FLAT_HEADERS = [
  'Form ID','Status','Submitted','Reviewed','Reviewer',
  'Guardian Name','Guardian Email','Guardian Phone',
  'Student ID','Student Name','Homeroom',
  'Chaperone Name','Relation','Chaperone Phone','Chaperone Email',
  'Chaperone ID#','Allocated EmployeeNo','Face Photos','Rejection Reason',
];

function summarize(records) {
  const t = { records: records.length, students: 0, chaperones: 0, pending: 0, approved: 0, rejected: 0, withFaces: 0 };
  records.forEach((r) => {
    t.students   += r.students.length;
    t.chaperones += r.chaperones.length;
    if (r.status === 'pending')  t.pending++;
    if (r.status === 'approved') t.approved++;
    if (r.status === 'rejected') t.rejected++;
    if ((r.chaperones || []).some((c) => c.faceCount > 0)) t.withFaces++;
  });
  return t;
}

// ── XLSX ────────────────────────────────────────────────────────────────────
async function buildXlsx({ records, audit, sections, includePhotos, meta, filters }) {
  const ExcelJS = (await import('exceljs')).default || require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BINUS Facial Attendance';
  wb.created = new Date();
  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } },
    alignment: { vertical: 'middle' },
  };

  const cover = wb.addWorksheet('Summary');
  cover.columns = [{ width: 30 }, { width: 30 }];
  cover.mergeCells('A1:B1');
  cover.getCell('A1').value = 'BINUS Onboarding Forms Report';
  cover.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FF047857' } };
  cover.addRow([]);
  cover.addRow(['Range',     `${filters.from || '—'} → ${filters.to || '—'}`]);
  cover.addRow(['Status',    filters.status || 'all']);
  if (filters.grade)     cover.addRow(['Grade',     filters.grade]);
  if (filters.homeroom)  cover.addRow(['Homeroom',  filters.homeroom]);
  if (filters.studentId) cover.addRow(['Student',   filters.studentId]);
  cover.addRow(['Generated', new Date().toISOString()]);
  cover.addRow(['Generated by', meta.actor]);
  cover.addRow(['Tenant',    meta.tenant]);

  if (sections.summary) {
    const t = summarize(records);
    cover.addRow([]);
    cover.addRow(['KPI', 'Value']).eachCell((c) => Object.assign(c, headerStyle));
    [
      ['Form records', t.records],
      ['Pending',      t.pending],
      ['Approved',     t.approved],
      ['Rejected',     t.rejected],
      ['Students',     t.students],
      ['Chaperones',   t.chaperones],
      ['Forms with face uploads', t.withFaces],
    ].forEach((r) => cover.addRow(r));
  }

  if (sections.records) {
    const ws = wb.addWorksheet('Records');
    ws.columns = FLAT_HEADERS.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));
    ws.getRow(1).eachCell((c) => Object.assign(c, headerStyle));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    flattenRecords(records).forEach((r) => ws.addRow(r));
  }

  if (sections.chaperones) {
    const ws = wb.addWorksheet('Chaperones');
    const headers = ['photo','formId','formStatus','chaperoneName','relation','phone','email','idNumber','allocated','faceCount','authorizedStudents'];
    ws.columns = headers.map((h) => ({ header: h, key: h, width: h === 'photo' ? 14 : Math.max(12, h.length + 2) }));
    ws.getRow(1).eachCell((c) => Object.assign(c, headerStyle));
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    let bucket = null;
    if (includePhotos) {
      try { bucket = admin.storage().bucket(); } catch { bucket = null; }
    }

    let rowIdx = 2;
    for (const r of records) {
      for (const c of (r.chaperones || [])) {
        ws.addRow(['', r.id, r.status, c.name, c.relation, c.phone, c.email, c.idNumber, c.allocatedId, c.faceCount, (c.authorizedStudentIds || []).join(', ')]);
        if (includePhotos && c.facePaths.length && bucket) {
          const buf = await fetchPhotoBuffer(bucket, c.facePaths[0]);
          if (buf) {
            try {
              const ext = (buf[0] === 0x89 && buf[1] === 0x50) ? 'png' : 'jpeg';
              const imgId = wb.addImage({ buffer: buf, extension: ext });
              ws.getRow(rowIdx).height = 64;
              ws.addImage(imgId, { tl: { col: 0.1, row: rowIdx - 1 + 0.05 }, ext: { width: 80, height: 80 } });
            } catch {}
          }
        }
        rowIdx++;
      }
    }
  }

  if (sections.audit && audit?.length) {
    const ws = wb.addWorksheet('Audit');
    const headers = ['at', 'kind', 'actor', 'target', 'summary'];
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(14, h.length + 2) }));
    ws.getRow(1).eachCell((c) => Object.assign(c, headerStyle));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    audit.forEach((a) => ws.addRow([a.at, a.kind, a.actor, a.target, a.summary]));
  }

  return wb.xlsx.writeBuffer();
}

// ── PDF ─────────────────────────────────────────────────────────────────────
async function buildPdf({ records, audit, sections, meta, filters }) {
  const React = (await import('react')).default || require('react');
  const reactPdf = await import('@react-pdf/renderer');
  const { Document, Page, Text, View, StyleSheet, renderToBuffer } = reactPdf;
  const e = React.createElement;

  const s = StyleSheet.create({
    page:   { padding: 28, fontSize: 9, fontFamily: 'Helvetica', color: '#0f172a' },
    h1:     { fontSize: 18, fontWeight: 700, color: '#047857', marginBottom: 4 },
    h2:     { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 6, color: '#047857', borderBottom: '1pt solid #cbd5e1', paddingBottom: 2 },
    meta:   { fontSize: 9, color: '#475569', marginBottom: 8 },
    kpiRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
    kpi:    { width: '25%', padding: 6, marginBottom: 6 },
    kpiVal: { fontSize: 14, fontWeight: 700, color: '#047857' },
    kpiLbl: { fontSize: 8, color: '#64748b', marginTop: 2 },
    table:  { display: 'table', width: 'auto' },
    tr:     { flexDirection: 'row' },
    th:     { backgroundColor: '#047857', color: '#fff', padding: 4, fontSize: 8, fontWeight: 700 },
    td:     { padding: 3, fontSize: 8, borderBottom: '0.5pt solid #e2e8f0' },
    footer: { position: 'absolute', bottom: 16, left: 28, right: 28, fontSize: 7, color: '#94a3b8', textAlign: 'center' },
  });

  const Table = (cols, rows, widths) => {
    const W = widths || cols.map(() => `${(100 / cols.length).toFixed(2)}%`);
    return e(View, { style: s.table },
      e(View, { style: s.tr }, ...cols.map((c, i) => e(View, { key: i, style: { width: W[i] } }, e(Text, { style: s.th }, c)))),
      ...rows.map((r, ri) => e(View, { key: ri, style: s.tr },
        ...r.map((cell, ci) => e(View, { key: ci, style: { width: W[ci] } }, e(Text, { style: s.td }, safeStr(cell))))))
    );
  };

  const children = [];
  children.push(e(View, { key: 'hdr' },
    e(Text, { style: s.h1 }, 'BINUS Onboarding Forms Report'),
    e(Text, { style: s.meta }, `${filters.from || '—'} → ${filters.to || '—'}  ·  status: ${filters.status || 'all'}${filters.grade ? `  ·  grade ${filters.grade}` : ''}${filters.homeroom ? `  ·  homeroom ${filters.homeroom}` : ''}  ·  generated ${new Date().toISOString().slice(0,19).replace('T',' ')} UTC  ·  by ${meta.actor}`),
  ));

  if (sections.summary) {
    const t = summarize(records);
    children.push(e(View, { key: 'kpis' },
      e(Text, { style: s.h2 }, 'Summary'),
      e(View, { style: s.kpiRow },
        ...[
          ['Records',    t.records],
          ['Pending',    t.pending],
          ['Approved',   t.approved],
          ['Rejected',   t.rejected],
          ['Students',   t.students],
          ['Chaperones', t.chaperones],
          ['With faces', t.withFaces],
        ].map(([lbl, v], i) => e(View, { key: i, style: s.kpi },
          e(Text, { style: s.kpiVal }, safeStr(v)),
          e(Text, { style: s.kpiLbl }, lbl),
        )),
      ),
    ));
  }

  if (sections.records && records.length) {
    children.push(e(View, { key: 'recs' },
      e(Text, { style: s.h2 }, `Records (${records.length})`),
      Table(
        ['Form','Status','Submitted','Guardian','Students','Chaperones','Faces'],
        records.slice(0, 60).map((r) => [
          r.id.slice(0, 12),
          r.status,
          (r.submittedAt || '').slice(0, 10),
          r.guardian?.name || '',
          r.students.map(st => `${st.name}${st.homeroom ? ` (${st.homeroom})` : ''}`).join(', '),
          r.chaperones.map(c => `${c.name} (${c.relation || '—'})`).join(', '),
          r.chaperones.reduce((n, c) => n + (c.faceCount || 0), 0),
        ]),
        ['11%','9%','11%','15%','22%','24%','8%']
      ),
    ));
    if (records.length > 60) {
      children.push(e(Text, { key: 'trunc', style: { fontSize: 8, color: '#94a3b8', marginTop: 4 } },
        `… ${records.length - 60} more records (use the XLSX export to see all)`));
    }
  }

  if (sections.audit && audit?.length) {
    children.push(e(View, { key: 'audit' },
      e(Text, { style: s.h2 }, `Audit Trail (${audit.length})`),
      Table(['When','Kind','Actor','Target','Summary'],
        audit.slice(0, 50).map(r => [(r.at||'').slice(0,19).replace('T',' '), r.kind, r.actor, r.target, r.summary]),
        ['18%', '20%', '18%', '18%', '26%']),
    ));
  }

  const doc = e(Document, null,
    e(Page, { size: 'A4', style: s.page },
      ...children,
      e(Text, { style: s.footer, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}  ·  BINUS Facial Attendance  ·  CONFIDENTIAL` }),
    )
  );

  return renderToBuffer(doc);
}

// ── CSV ─────────────────────────────────────────────────────────────────────
function buildCsv({ records, audit, sections, meta, filters }) {
  const lines = [];
  lines.push(`BINUS Onboarding Forms Report,${filters.from || ''} to ${filters.to || ''}`);
  lines.push(`Status,${filters.status || 'all'}`);
  if (filters.grade)     lines.push(`Grade,${filters.grade}`);
  if (filters.homeroom)  lines.push(`Homeroom,${filters.homeroom}`);
  if (filters.studentId) lines.push(`Student,${filters.studentId}`);
  lines.push(`Generated,${new Date().toISOString()}`);
  lines.push(`Generated by,${meta.actor}`);

  if (sections.summary) {
    const t = summarize(records);
    lines.push(''); lines.push('# Summary');
    Object.entries(t).forEach(([k, v]) => lines.push(`${k},${escCsv(v)}`));
  }
  if (sections.records) {
    lines.push(''); lines.push('# Records');
    lines.push(FLAT_HEADERS.join(','));
    flattenRecords(records).forEach((r) => lines.push(r.map(escCsv).join(',')));
  }
  if (sections.audit && audit?.length) {
    lines.push(''); lines.push('# Audit Trail');
    lines.push(['at','kind','actor','target','summary'].join(','));
    audit.forEach((a) => lines.push([a.at, a.kind, a.actor, a.target, a.summary].map(escCsv).join(',')));
  }

  return Buffer.from('\uFEFF' + lines.join('\n'), 'utf8');
}

// ── Handler ─────────────────────────────────────────────────────────────────
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body = req.body || {};
  const format = String(body.format || 'xlsx').toLowerCase();
  if (!['xlsx','pdf','csv'].includes(format)) {
    return res.status(400).json({ error: 'bad_format' });
  }
  const filters = {
    status:    body.status && body.status !== 'all' ? String(body.status) : 'all',
    grade:     body.grade != null && body.grade !== '' ? body.grade : null,
    homeroom:  body.homeroom ? String(body.homeroom).toUpperCase() : null,
    studentId: body.studentId || null,
    from:      isDate(body.from) ? body.from : null,
    to:        isDate(body.to)   ? body.to   : null,
  };
  const sections = { ...DEFAULT_SECTIONS, ...(body.sections || {}) };
  const includePhotos = !!body.includeChaperonePhotos;
  const tid = tenancy.getTenantId();

  try {
    initializeFirebase();
    const db = admin.firestore();
    const records = await loadOnboardingRecords(db, tid, filters);
    const audit = sections.audit ? await loadAuditEntries(db, tid, { from: filters.from, to: filters.to }) : [];

    const meta = { tenant: tid, actor: req.user?.email || req.user?.name || '—' };
    const baseName = `binus-onboarding-forms_${filters.from || 'any'}_to_${filters.to || 'any'}`;
    let buf, mime, filename;

    if (format === 'xlsx') {
      buf = await buildXlsx({ records, audit, sections, includePhotos, meta, filters });
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      filename = `${baseName}.xlsx`;
    } else if (format === 'pdf') {
      buf = await buildPdf({ records, audit, sections, meta, filters });
      mime = 'application/pdf';
      filename = `${baseName}.pdf`;
    } else {
      buf = buildCsv({ records, audit, sections, meta, filters });
      mime = 'text/csv; charset=utf-8';
      filename = `${baseName}.csv`;
    }

    await logAudit(db, {
      tenantId: tid,
      actor: req.user || null,
      kind: 'onboarding.export',
      target: { type: 'report', id: baseName, label: filename },
      summary: `Exported onboarding forms (${format.toUpperCase()}) — ${records.length} records`,
      metadata: { format, filters, sections, includePhotos, recordCount: records.length },
      req,
    });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch (err) {
    console.error('[pickup/admin/onboarding-export]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['POST'], permission: 'reports.export' });
