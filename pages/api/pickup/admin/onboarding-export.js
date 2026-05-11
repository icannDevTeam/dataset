/**
 * POST /api/pickup/admin/onboarding-export
 *
 * Generates a parameterised onboarding-forms export in CSV / XLSX / PDF / HTML.
 * Mirrors the pickup-report export endpoint but operates on the
 * pickup_onboarding collection.
 *
 * Body:
 *   {
 *     format: 'xlsx' | 'pdf' | 'csv' | 'print',
 *     status?: 'all'|'pending'|'approved'|'rejected',
 *     grade?: number|string,
 *     homeroom?: string,
 *     studentId?: string,
 *     from?:'YYYY-MM-DD', to?:'YYYY-MM-DD',
 *     sections?: { summary, records, chaperones, audit },
 *     includeChaperonePhotos?: bool   // PDF + XLSX
 *   }
 *
 * 'print' returns a self-printing HTML document (text/html, inline) that
 * mirrors the on-screen PrintFormModal letterhead in /v2/pickup-admin so
 * the operator can do Ctrl+P or Save-As-PDF directly from the browser.
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
const REL_LABEL = {
  parent: 'Parent', mother: 'Mother', father: 'Father',
  guardian: 'Guardian', driver: 'Driver', nanny: 'Nanny',
  grandparent: 'Grandparent', sibling: 'Sibling', other: 'Other',
};
function relLabel(r) { return REL_LABEL[r] || (r || '').toString() || '—'; }
function fmtDateTime(iso) {
  if (!iso) return '—';
  return iso.slice(0, 19).replace('T', ' ') + ' UTC';
}

/**
 * Pre-fetch the FIRST face photo for every chaperone in `records` and
 * attach `_facePngBuf` (Buffer | null). Used by the PDF and HTML
 * letterhead renderers so each form page can embed the chaperone's face.
 */
async function attachChaperoneFaces(records) {
  let bucket = null;
  try { bucket = admin.storage().bucket(); } catch { bucket = null; }
  if (!bucket) return;
  for (const r of records) {
    for (const c of (r.chaperones || [])) {
      c._facePngBuf = null;
      const p = (c.facePaths || [])[0];
      if (!p) continue;
      c._facePngBuf = await fetchPhotoBuffer(bucket, p);
    }
  }
}

async function buildPdf({ records, audit, sections, meta, filters, includePhotos }) {
  const React = (await import('react')).default || require('react');
  const reactPdf = await import('@react-pdf/renderer');
  const { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } = reactPdf;
  const e = React.createElement;

  if (includePhotos && sections.records) await attachChaperoneFaces(records);

  const s = StyleSheet.create({
    page:        { padding: 32, fontSize: 9, fontFamily: 'Helvetica', color: '#0f172a' },
    coverH1:     { fontSize: 20, fontWeight: 700, color: '#047857', marginBottom: 4 },
    coverMeta:   { fontSize: 9, color: '#475569', marginBottom: 12 },
    h2:          { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 6, color: '#047857', borderBottom: '1pt solid #cbd5e1', paddingBottom: 2 },
    kpiRow:      { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
    kpi:         { width: '25%', padding: 6, marginBottom: 6 },
    kpiVal:      { fontSize: 14, fontWeight: 700, color: '#047857' },
    kpiLbl:      { fontSize: 8, color: '#64748b', marginTop: 2 },
    table:       { display: 'table', width: 'auto' },
    tr:          { flexDirection: 'row' },
    th:          { backgroundColor: '#047857', color: '#fff', padding: 4, fontSize: 8, fontWeight: 700 },
    td:          { padding: 3, fontSize: 8, borderBottom: '0.5pt solid #e2e8f0' },
    footer:      { position: 'absolute', bottom: 16, left: 32, right: 32, fontSize: 7, color: '#94a3b8', textAlign: 'center' },

    // Per-form letterhead
    letterTop:   { borderBottomWidth: 2, borderBottomColor: '#0f172a', borderBottomStyle: 'solid', paddingBottom: 8, marginBottom: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    schoolKey:   { fontSize: 8, color: '#c2410c', fontWeight: 700, letterSpacing: 1.5, marginBottom: 2 },
    formTitle:   { fontSize: 17, fontWeight: 700, color: '#0f172a' },
    metaRight:   { fontSize: 8, color: '#475569', textAlign: 'right' },
    sectionTitle:{ fontSize: 9, fontWeight: 700, color: '#c2410c', letterSpacing: 1, marginTop: 12, marginBottom: 4, textTransform: 'uppercase' },
    fieldRow:    { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e2e8f0', borderBottomStyle: 'solid', paddingTop: 3, paddingBottom: 3 },
    fieldLabel:  { width: 140, fontSize: 8, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.6 },
    fieldValue:  { flex: 1, fontSize: 10, color: '#0f172a', fontWeight: 600 },
    studentRow:  { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e2e8f0', borderBottomStyle: 'solid', paddingTop: 3, paddingBottom: 3 },
    chapBox:     { borderWidth: 0.7, borderColor: '#cbd5e1', borderStyle: 'solid', borderRadius: 4, padding: 8, marginBottom: 6, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    chapName:    { fontSize: 11, fontWeight: 700 },
    chapRel:     { fontSize: 8, color: '#c2410c', fontWeight: 700, marginLeft: 4, textTransform: 'uppercase', letterSpacing: 0.6 },
    chapMeta:    { fontSize: 8.5, color: '#334155', marginTop: 3 },
    chapPhoto:   { width: 64, height: 64, borderRadius: 3, borderWidth: 0.5, borderColor: '#cbd5e1', borderStyle: 'solid' },
    consent:     { fontSize: 8.5, color: '#334155', lineHeight: 1.4, marginBottom: 6 },
  });

  const Table = (cols, rows, widths) => {
    const W = widths || cols.map(() => `${(100 / cols.length).toFixed(2)}%`);
    return e(View, { style: s.table },
      e(View, { style: s.tr }, ...cols.map((c, i) => e(View, { key: i, style: { width: W[i] } }, e(Text, { style: s.th }, c)))),
      ...rows.map((r, ri) => e(View, { key: ri, style: s.tr },
        ...r.map((cell, ci) => e(View, { key: ci, style: { width: W[ci] } }, e(Text, { style: s.td }, safeStr(cell))))))
    );
  };

  // Cover page (summary + filter context + audit)
  const coverChildren = [
    e(Text, { key: 'h', style: s.coverH1 }, 'BINUS Onboarding Forms Report'),
    e(Text, { key: 'm', style: s.coverMeta },
      `${filters.from || '—'} → ${filters.to || '—'}  ·  status: ${filters.status || 'all'}`
      + `${filters.grade ? `  ·  grade ${filters.grade}` : ''}`
      + `${filters.homeroom ? `  ·  homeroom ${filters.homeroom}` : ''}`
      + `  ·  generated ${new Date().toISOString().slice(0,19).replace('T',' ')} UTC  ·  by ${meta.actor}`),
  ];

  if (sections.summary) {
    const t = summarize(records);
    coverChildren.push(e(View, { key: 'kpis' },
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

  if (sections.audit && audit?.length) {
    coverChildren.push(e(View, { key: 'audit' },
      e(Text, { style: s.h2 }, `Audit Trail (${audit.length})`),
      Table(['When','Kind','Actor','Target','Summary'],
        audit.slice(0, 50).map(r => [(r.at||'').slice(0,19).replace('T',' '), r.kind, r.actor, r.target, r.summary]),
        ['18%', '20%', '18%', '18%', '26%']),
    ));
  }

  const pages = [
    e(Page, { key: 'cover', size: 'A4', style: s.page },
      ...coverChildren,
      e(Text, { style: s.footer, fixed: true, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}  ·  BINUS Facial Attendance  ·  CONFIDENTIAL` }),
    ),
  ];

  // One letterhead page per record (mirrors PrintFormModal)
  if (sections.records && records.length) {
    records.forEach((r, idx) => {
      const studentRows = [
        e(View, { key: 'h', style: s.studentRow },
          e(View, { style: { width: '8%' } },  e(Text, { style: s.fieldLabel }, '#')),
          e(View, { style: { width: '42%' } }, e(Text, { style: s.fieldLabel }, 'Name')),
          e(View, { style: { width: '30%' } }, e(Text, { style: s.fieldLabel }, 'Student ID')),
          e(View, { style: { width: '20%' } }, e(Text, { style: s.fieldLabel }, 'Class')),
        ),
        ...r.students.map((st, i) =>
          e(View, { key: i, style: s.studentRow },
            e(View, { style: { width: '8%' } },  e(Text, { style: { fontSize: 9 } }, String(i + 1))),
            e(View, { style: { width: '42%' } }, e(Text, { style: { fontSize: 10, fontWeight: 700 } }, st.name || '—')),
            e(View, { style: { width: '30%' } }, e(Text, { style: { fontSize: 9, fontFamily: 'Courier' } }, st.id || '—')),
            e(View, { style: { width: '20%' } }, e(Text, { style: { fontSize: 9 } }, st.homeroom || '—')),
          )
        ),
      ];

      const chapBoxes = r.chaperones.map((c, i) => {
        const allowed = (c.authorizedStudentIds || [])
          .map((sid) => r.students.find((x) => x.id === sid)?.name || sid)
          .join(', ') || '—';
        const leftKids = [
          e(View, { key: 'n', style: { flexDirection: 'row', alignItems: 'baseline' } },
            e(Text, { style: s.chapName }, `${i + 1}. ${c.name || '—'}`),
            e(Text, { style: s.chapRel }, `(${relLabel(c.relation)})`),
          ),
          e(Text, { key: 'p', style: s.chapMeta }, `Phone: ${c.phone || '—'}`),
        ];
        if (c.email)    leftKids.push(e(Text, { key: 'e',  style: s.chapMeta }, `Email: ${c.email}`));
        if (c.idNumber) leftKids.push(e(Text, { key: 'id', style: s.chapMeta }, `Government ID: ${c.idNumber}`));
        leftKids.push(e(Text, { key: 'a', style: { ...s.chapMeta, marginTop: 4 } }, `Authorised to pick up: ${allowed}`));
        if (c.allocatedId) leftKids.push(e(Text, { key: 'al', style: { ...s.chapMeta, color: '#047857', marginTop: 2 } }, `Chaperone ID: #${c.allocatedId}`));

        const left = e(View, { style: { flex: 1, paddingRight: 8 } }, ...leftKids);
        const photoView = (includePhotos && c._facePngBuf)
          ? e(Image, { style: s.chapPhoto, src: c._facePngBuf })
          : null;
        return e(View, { key: i, style: s.chapBox, wrap: false }, left, photoView);
      });

      const consentKids = [
        e(Text, { key: 'c', style: s.consent },
          'By submitting this form the guardian consents to BINUS Simprug processing the facial biometric data of the listed adults strictly for the purpose of verifying authorised pickup at school exits. Face images are stored for 12 months and may be revoked at any time by contacting the school.'),
        e(View, { key: 'sa', style: s.fieldRow }, e(Text, { style: s.fieldLabel }, 'Submitted at'), e(Text, { style: s.fieldValue }, fmtDateTime(r.submittedAt))),
      ];
      if (r.reviewedAt) consentKids.push(
        e(View, { key: 'ra', style: s.fieldRow },
          e(Text, { style: s.fieldLabel }, r.status === 'approved' ? 'Approved at' : 'Rejected at'),
          e(Text, { style: s.fieldValue }, fmtDateTime(r.reviewedAt))));
      if (r.reviewedBy) consentKids.push(
        e(View, { key: 'rb', style: s.fieldRow },
          e(Text, { style: s.fieldLabel }, 'Reviewer'),
          e(Text, { style: { ...s.fieldValue, fontFamily: 'Courier' } }, r.reviewedBy)));
      if (r.rejectionReason) consentKids.push(
        e(View, { key: 'rr', style: s.fieldRow },
          e(Text, { style: s.fieldLabel }, 'Rejection reason'),
          e(Text, { style: { ...s.fieldValue, color: '#b91c1c' } }, r.rejectionReason)));

      pages.push(e(Page, { key: `f-${r.id}-${idx}`, size: 'A4', style: s.page, wrap: true },
        e(View, { style: s.letterTop },
          e(View, null,
            e(Text, { style: s.schoolKey }, 'BINUS School Simprug'),
            e(Text, { style: s.formTitle }, 'Pickup System Authorization Form'),
          ),
          e(View, null,
            e(Text, { style: s.metaRight }, `Submission ID: ${r.id}`),
            e(Text, { style: s.metaRight }, `Submitted: ${fmtDateTime(r.submittedAt)}`),
            e(Text, { style: s.metaRight }, `Status: ${(r.status || '').toUpperCase()}`),
          ),
        ),
        e(Text, { style: s.sectionTitle }, '1. Guardian / Submitter'),
        e(View, { style: s.fieldRow }, e(Text, { style: s.fieldLabel }, 'Full name'), e(Text, { style: s.fieldValue }, r.guardian?.name || '—')),
        e(View, { style: s.fieldRow }, e(Text, { style: s.fieldLabel }, 'Email'),     e(Text, { style: s.fieldValue }, r.guardian?.email || '—')),
        e(View, { style: s.fieldRow }, e(Text, { style: s.fieldLabel }, 'Phone'),     e(Text, { style: s.fieldValue }, r.guardian?.phone || '—')),

        e(Text, { style: s.sectionTitle }, `2. Students under guardian (${r.students.length})`),
        ...studentRows,

        e(Text, { style: s.sectionTitle }, `3. Authorised pickup persons (${r.chaperones.length})`),
        ...chapBoxes,

        e(Text, { style: s.sectionTitle }, '4. Consent & signature'),
        ...consentKids,

        e(Text, { style: s.footer, fixed: true, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}  ·  BINUS School Simprug · Pickup System  ·  CONFIDENTIAL` }),
      ));
    });
  }

  return renderToBuffer(e(Document, null, ...pages));
}

// ── HTML print mode ─────────────────────────────────────────────────────────
// Returns a self-printing letterhead HTML document. Mirrors the on-screen
// PrintFormModal in /v2/pickup-admin so the operator gets the familiar
// layout when they hit Ctrl+P or Save-as-PDF in the browser.
async function buildPrintHtml({ records, audit, sections, meta, filters, includePhotos }) {
  if (includePhotos && sections.records) await attachChaperoneFaces(records);
  const esc = (v) => safeStr(v).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  const dataUri = (buf) => buf ? `data:image/${buf[0] === 0x89 ? 'png' : 'jpeg'};base64,${buf.toString('base64')}` : null;

  const t = summarize(records);
  const summaryHtml = sections.summary ? `
    <section class="summary">
      <h2>Summary</h2>
      <div class="kpis">
        ${[
          ['Records', t.records],['Pending', t.pending],['Approved', t.approved],
          ['Rejected', t.rejected],['Students', t.students],['Chaperones', t.chaperones],
          ['With faces', t.withFaces],
        ].map(([l,v]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}
      </div>
      <div class="filters">
        Range: <code>${esc(filters.from || '—')} → ${esc(filters.to || '—')}</code> ·
        Status: <code>${esc(filters.status || 'all')}</code>
        ${filters.grade ? ` · Grade: <code>${esc(filters.grade)}</code>` : ''}
        ${filters.homeroom ? ` · Homeroom: <code>${esc(filters.homeroom)}</code>` : ''}
        · Generated by <code>${esc(meta.actor)}</code>
      </div>
    </section>` : '';

  const formsHtml = sections.records ? records.map((r) => `
    <article class="form">
      <header class="letterhead">
        <div>
          <div class="school">BINUS School Simprug</div>
          <h1>Pickup System Authorization Form</h1>
        </div>
        <div class="meta">
          <div>Submission ID:&nbsp;<code>${esc(r.id)}</code></div>
          <div>Submitted:&nbsp;<code>${esc(fmtDateTime(r.submittedAt))}</code></div>
          <div>Status:&nbsp;<code>${esc((r.status||'').toUpperCase())}</code></div>
        </div>
      </header>

      <h3>1. Guardian / Submitter</h3>
      <div class="field"><span>Full name</span><strong>${esc(r.guardian?.name || '—')}</strong></div>
      <div class="field"><span>Email</span><strong>${esc(r.guardian?.email || '—')}</strong></div>
      <div class="field"><span>Phone</span><strong>${esc(r.guardian?.phone || '—')}</strong></div>

      <h3>2. Students under guardian (${r.students.length})</h3>
      <table class="students">
        <thead><tr><th>#</th><th>Name</th><th>Student ID</th><th>Class</th></tr></thead>
        <tbody>${r.students.map((st, i) => `
          <tr><td>${i+1}</td><td><strong>${esc(st.name)}</strong></td>
            <td><code>${esc(st.id)}</code></td><td>${esc(st.homeroom || '—')}</td></tr>`).join('')}</tbody>
      </table>

      <h3>3. Authorised pickup persons (${r.chaperones.length})</h3>
      ${r.chaperones.map((c, i) => {
        const allowed = (c.authorizedStudentIds || [])
          .map((sid) => r.students.find((x) => x.id === sid)?.name || sid).join(', ') || '—';
        const photo = includePhotos && c._facePngBuf ? `<img src="${dataUri(c._facePngBuf)}" alt="">` : '';
        return `
        <div class="chap">
          <div>
            <div class="chap-name">${i+1}. <strong>${esc(c.name)}</strong> <span class="rel">(${esc(relLabel(c.relation))})</span></div>
            <div class="chap-meta">Phone: <code>${esc(c.phone || '—')}</code></div>
            ${c.email     ? `<div class="chap-meta">Email: <code>${esc(c.email)}</code></div>` : ''}
            ${c.idNumber  ? `<div class="chap-meta">Government ID: <code>${esc(c.idNumber)}</code></div>` : ''}
            <div class="chap-meta authd">Authorised to pick up: <strong>${esc(allowed)}</strong></div>
            ${c.allocatedId ? `<div class="chap-meta alloc">Chaperone ID: <code>#${esc(c.allocatedId)}</code></div>` : ''}
          </div>
          ${photo}
        </div>`;
      }).join('')}

      <h3>4. Consent &amp; signature</h3>
      <p class="consent">By submitting this form the guardian consents to BINUS Simprug processing the
        facial biometric data of the listed adults strictly for the purpose of verifying authorised
        pickup at school exits. Face images are stored for 12 months and may be revoked at any time
        by contacting the school.</p>
      <div class="field"><span>Submitted at</span><strong>${esc(fmtDateTime(r.submittedAt))}</strong></div>
      ${r.reviewedAt ? `<div class="field"><span>${r.status === 'approved' ? 'Approved at' : 'Rejected at'}</span><strong>${esc(fmtDateTime(r.reviewedAt))}</strong></div>` : ''}
      ${r.reviewedBy ? `<div class="field"><span>Reviewer</span><strong><code>${esc(r.reviewedBy)}</code></strong></div>` : ''}
      ${r.rejectionReason ? `<div class="field"><span>Rejection reason</span><strong style="color:#b91c1c">${esc(r.rejectionReason)}</strong></div>` : ''}

      <footer class="page-foot">BINUS School Simprug · Pickup System · CONFIDENTIAL</footer>
    </article>`).join('') : '';

  const auditHtml = (sections.audit && audit?.length) ? `
    <article class="form audit-page">
      <h2>Audit Trail (${audit.length})</h2>
      <table class="audit">
        <thead><tr><th>When</th><th>Kind</th><th>Actor</th><th>Target</th><th>Summary</th></tr></thead>
        <tbody>${audit.slice(0, 200).map((a) => `
          <tr><td><code>${esc((a.at||'').slice(0,19).replace('T',' '))}</code></td>
            <td><code>${esc(a.kind)}</code></td><td>${esc(a.actor)}</td>
            <td>${esc(a.target)}</td><td>${esc(a.summary)}</td></tr>`).join('')}</tbody>
      </table>
    </article>` : '';

  return Buffer.from(`<!doctype html>
<html><head><meta charset="utf-8"><title>BINUS Onboarding Forms — ${esc(filters.from || 'all')} → ${esc(filters.to || 'all')}</title>
<style>
  *,*:before,*:after{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;background:#f1f5f9;margin:0;padding:24px}
  .toolbar{position:sticky;top:0;background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 6px 24px rgba(0,0,0,.15);margin-bottom:16px;z-index:10}
  .toolbar h1{margin:0;font-size:14px;font-weight:600;letter-spacing:.3px}
  .toolbar button{background:#10b981;color:#0f172a;border:0;border-radius:6px;padding:7px 16px;font-weight:700;font-size:13px;cursor:pointer;margin-left:8px}
  .toolbar button.alt{background:#475569;color:#fff}
  .summary{background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:18px 22px;margin-bottom:18px}
  .summary h2{margin:0 0 10px;font-size:13px;color:#047857;letter-spacing:1px;text-transform:uppercase}
  .kpis{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;margin-bottom:8px}
  .kpi{padding:10px;background:#f8fafc;border-radius:6px}
  .kpi .v{font-size:20px;font-weight:700;color:#047857}
  .kpi .l{font-size:10px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.6px}
  .filters{font-size:11px;color:#475569;margin-top:6px}
  .form{background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:32px;margin-bottom:18px;page-break-after:always}
  .form:last-child{page-break-after:auto}
  .letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:18px}
  .letterhead .school{font-size:11px;color:#c2410c;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
  .letterhead h1{margin:0;font-size:22px;font-weight:700}
  .letterhead .meta{text-align:right;font-size:11px;color:#475569}
  .letterhead .meta div{margin:2px 0}
  .form h3{font-size:11px;color:#c2410c;letter-spacing:1.2px;text-transform:uppercase;margin:20px 0 8px;font-weight:700}
  .field{display:flex;border-bottom:1px solid #e2e8f0;padding:6px 0;font-size:13px}
  .field span{width:200px;font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.6px;padding-top:1px}
  .field strong{flex:1;color:#0f172a;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:12px}
  table.students th,table.students td{border:1px solid #cbd5e1;padding:7px 9px;text-align:left;vertical-align:top}
  table.students th{background:#f1f5f9;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#475569}
  .chap{display:flex;justify-content:space-between;align-items:flex-start;border:1px solid #cbd5e1;border-radius:6px;padding:12px;margin-bottom:8px}
  .chap .chap-name{font-size:14px;margin-bottom:4px}
  .chap .rel{font-size:10px;color:#c2410c;text-transform:uppercase;letter-spacing:.6px;margin-left:4px}
  .chap .chap-meta{font-size:11px;color:#334155;margin-top:2px}
  .chap .chap-meta.alloc{color:#047857;margin-top:6px}
  .chap .chap-meta.authd{margin-top:6px}
  .chap img{width:80px;height:80px;object-fit:cover;border:1px solid #cbd5e1;border-radius:4px;margin-left:12px;flex-shrink:0}
  .consent{font-size:11px;color:#334155;line-height:1.5;margin:0 0 8px}
  .page-foot{margin-top:18px;padding-top:8px;border-top:1px solid #e2e8f0;font-size:9px;color:#94a3b8;text-align:center}
  .audit-page table{font-size:10px}
  .audit-page td,.audit-page th{border:1px solid #cbd5e1;padding:5px 7px;text-align:left}
  code{font-family:Menlo,Consolas,monospace;font-size:.92em}
  @media print {
    body{background:#fff;padding:0;margin:0}
    .toolbar{display:none !important}
    .summary,.form{box-shadow:none;border:0;margin:0;border-radius:0;padding:24px 32px}
    .form{page-break-after:always}
    .form:last-child{page-break-after:auto}
    @page{size:A4;margin:14mm}
  }
</style></head>
<body>
  <div class="toolbar">
    <h1>BINUS Onboarding Forms — ${esc(records.length)} record(s) · ${esc(filters.from || '—')} → ${esc(filters.to || '—')}</h1>
    <div>
      <button class="alt" onclick="window.close()">Close</button>
      <button onclick="window.print()">Print / Save as PDF</button>
    </div>
  </div>
  ${summaryHtml}
  ${formsHtml}
  ${auditHtml}
  <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},300);});</script>
</body></html>`, 'utf8');
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
  if (!['xlsx','pdf','csv','print'].includes(format)) {
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
      buf = await buildPdf({ records, audit, sections, meta, filters, includePhotos });
      mime = 'application/pdf';
      filename = `${baseName}.pdf`;
    } else if (format === 'print') {
      buf = await buildPrintHtml({ records, audit, sections, meta, filters, includePhotos });
      mime = 'text/html; charset=utf-8';
      filename = `${baseName}.html`;
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
    // 'print' must be inline so the new tab can render & auto-print.
    const disp = format === 'print' ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disp}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch (err) {
    console.error('[pickup/admin/onboarding-export]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['POST'], permission: 'reports.export' });
