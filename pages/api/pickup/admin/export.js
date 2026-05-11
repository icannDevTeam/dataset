/**
 * POST /api/pickup/admin/export
 *
 * Generates a parameterised pickup-report export in CSV / XLSX / PDF.
 * Reuses lib/pickup-analytics.js for the same aggregation that powers
 * /api/pickup/admin/analytics so the export numbers always match the UI.
 *
 * Request body:
 *   {
 *     format: 'xlsx' | 'pdf' | 'csv',
 *     from:   'YYYY-MM-DD',
 *     to:     'YYYY-MM-DD',
 *     filters?: {
 *       grade?:    string,   // restricts byClass + recent rows by homeroom prefix
 *       homeroom?: string,   // exact homeroom restriction
 *     },
 *     sections?: {
 *       summary?: bool, byDate?: bool, byGate?: bool, byClass?: bool,
 *       byTerminal?: bool, frFlags?: bool, topChaperones?: bool,
 *       audit?: bool, chaperones?: bool, recent?: bool,
 *     }
 *     includeChaperonePhotos?: bool   // XLSX only — embeds thumbnails
 *   }
 *
 * Response: binary file download with the correct Content-Type +
 *           Content-Disposition: attachment; filename="..."
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const { computePickupAnalytics } = require('../../../../lib/pickup-analytics');
const { auditLogPath, logAudit } = require('../../../../lib/audit-log');

// Lazy-required heavy deps (imported inside handlers below)
//   exceljs            — XLSX generation
//   @react-pdf/renderer — PDF generation

export const config = {
  api: { bodyParser: { sizeLimit: '256kb' }, responseLimit: false },
};

const DEFAULT_SECTIONS = {
  summary: true, byDate: true, byGate: true, byClass: true,
  byTerminal: true, frFlags: true, topChaperones: true,
  audit: true, chaperones: false, recent: true,
};

function getWIBToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function safeStr(v, fallback = '') { return v == null ? fallback : String(v); }
function fmtPct(v) { return v == null ? '—' : `${v}%`; }
function escCsv(v) {
  const s = safeStr(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function applyFilters(data, filters) {
  if (!filters || (!filters.grade && !filters.homeroom)) return data;
  const matchHr = (hr) => {
    if (!hr) return false;
    if (filters.homeroom) return hr === filters.homeroom;
    if (filters.grade)    return String(hr).startsWith(String(filters.grade));
    return true;
  };
  return {
    ...data,
    byClass: (data.byClass || []).filter(c => matchHr(c.homeroom)),
    recent:  (data.recent  || []).filter(r => (r.students || []).some(s => matchHr(s.homeroom))),
  };
}

async function loadAuditEntries(db, tid, { from, to }) {
  const fromMs = new Date(from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(to   + 'T23:59:59+07:00').getTime();
  const snap = await db.collection(auditLogPath(tid))
    .orderBy('at', 'desc').limit(1000).get();
  const out = [];
  snap.forEach((d) => {
    const e = d.data() || {};
    const ts = e.at ? Date.parse(e.at) : NaN;
    if (Number.isNaN(ts) || ts < fromMs || ts > toMs) return;
    if (!/^(pickup\.|chaperone\.|device\.)/.test(e.kind || '')) return;
    out.push({
      at: e.at,
      kind: e.kind,
      actor: e.actor?.email || e.actor?.name || '—',
      target: e.target?.label || e.target?.id || '',
      summary: e.summary || '',
      ip: e.ip || '',
    });
  });
  return out;
}

async function loadChaperoneRoster(db, tid, { withPhotos }) {
  const snap = await db.collection(tenancy.chaperonesPath(tid))
    .orderBy('createdAt', 'desc').limit(500).get();
  const rows = [];
  let bucket = null;
  if (withPhotos) {
    try { bucket = admin.storage().bucket(); } catch { bucket = null; }
  }
  for (const d of snap.docs) {
    const c = d.data() || {};
    let photoBuf = null;
    if (withPhotos && bucket && Array.isArray(c.facePaths) && c.facePaths.length) {
      try {
        const [buf] = await bucket.file(c.facePaths[0]).download();
        photoBuf = buf;
      } catch (err) {
        photoBuf = null;
      }
    }
    rows.push({
      id: d.id,
      name: c.name || '—',
      relation: c.relation || c.relationship || '',
      phone: c.phone || '',
      email: c.email || '',
      idNumber: c.idNumber || '',
      authorizedStudents: (c.authorizedStudentIds || []).join(', '),
      faceCount: (c.facePaths || c.photoUrls || []).length,
      status: c.status || (c.suspended ? 'suspended' : ''),
      enrolled: !!c.deviceEnrolled,
      photoBuf,
    });
  }
  return rows;
}

// ── XLSX generation ─────────────────────────────────────────────────────────
async function buildXlsx({ data, filters, sections, audit, chaperones, includePhotos, meta }) {
  const ExcelJS = (await import('exceljs')).default || require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BINUS Facial Attendance';
  wb.created = new Date();

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E7490' } },
    alignment: { vertical: 'middle' },
  };

  const cover = wb.addWorksheet('Summary');
  cover.columns = [{ width: 30 }, { width: 30 }];
  cover.mergeCells('A1:B1');
  cover.getCell('A1').value = 'BINUS Pickup Report';
  cover.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FF0E7490' } };
  cover.addRow([]);
  cover.addRow(['Range', `${data.range.from} → ${data.range.to} (${data.range.totalDays} days)`]);
  cover.addRow(['Generated', new Date().toISOString()]);
  cover.addRow(['Tenant', meta.tenant]);
  cover.addRow(['Generated by', meta.actor]);
  if (filters?.grade)    cover.addRow(['Filter: grade', filters.grade]);
  if (filters?.homeroom) cover.addRow(['Filter: homeroom', filters.homeroom]);

  if (sections.summary) {
    cover.addRow([]);
    cover.addRow(['KPI', 'Value']).eachCell((c) => Object.assign(c, headerStyle));
    const s = data.summary;
    [
      ['Total pickups',     s.totalPickups],
      ['Auto approved',     s.autoApproved],
      ['Officer overrides', s.officerOverridden],
      ['Flagged',           s.flagged],
      ['Avg per day',       s.avgPerDay],
      ['Approval rate',     fmtPct(s.approvalRate)],
      ['Override rate',     fmtPct(s.overrideRate)],
    ].forEach((r) => cover.addRow(r));
  }

  const addTable = (name, headers, rows) => {
    if (!rows?.length) return;
    const ws = wb.addWorksheet(name);
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));
    ws.getRow(1).eachCell((c) => Object.assign(c, headerStyle));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    rows.forEach((r) => ws.addRow(r));
  };

  if (sections.byDate)    addTable('By Date',
    ['date','total','autoApproved','overridden','green','yellow','red'],
    data.byDate.map(r => [r.date,r.total,r.autoApproved,r.overridden,r.green,r.yellow,r.red]));
  if (sections.byGate)    addTable('By Gate',
    ['gate','total','autoApproved','overridden','green','yellow','red'],
    data.byGate.map(r => [r.gate,r.total,r.autoApproved,r.overridden,r.green,r.yellow,r.red]));
  if (sections.byClass)   addTable('By Class',
    ['homeroom','total'],
    data.byClass.map(r => [r.homeroom,r.total]));
  if (sections.byTerminal) addTable('By Terminal (FR)',
    ['terminalId','gate','total','avgConfidence%','livenessPassRate%','spoof','lowConfidence','unknownChaperone','avgRetries'],
    data.byTerminal.map(r => [r.terminalId,r.gate,r.total,r.avgConfidence,r.livenessPassRate,r.spoof,r.lowConfidence,r.unknownChaperone,r.avgRetries]));
  if (sections.frFlags) {
    addTable('Low Confidence Flags',
      ['at','gate','terminalId','chaperone','confidence'],
      (data.fr.lowConfidenceFlags||[]).map(r => [r.at,r.gate,r.terminalId,r.chaperone,r.confidence]));
    addTable('Spoof Flags',
      ['at','gate','terminalId','chaperone','livenessScore'],
      (data.fr.spoofFlags||[]).map(r => [r.at,r.gate,r.terminalId,r.chaperone,r.livenessScore]));
  }
  if (sections.topChaperones) addTable('Top Chaperones',
    ['name','total'],
    data.topChaperones.map(r => [r.name,r.total]));
  if (sections.recent)    addTable('Recent Events',
    ['at','gate','cardState','isOverride','chaperone','officer','students'],
    data.recent.map(r => [r.at,r.gate,r.cardState,r.isOverride?'YES':'',r.chaperone||'',r.officer||'',
      (r.students||[]).map(s => `${s.name}${s.homeroom?` (${s.homeroom})`:''}`).join('; ')]));
  if (sections.audit && audit?.length) addTable('Audit Trail',
    ['at','kind','actor','target','summary','ip'],
    audit.map(r => [r.at,r.kind,r.actor,r.target,r.summary,r.ip]));

  if (sections.chaperones && chaperones?.length) {
    const ws = wb.addWorksheet('Chaperones');
    const headers = ['photo','id','name','relation','phone','email','idNumber','faceCount','status','enrolled','authorizedStudents'];
    ws.columns = headers.map((h) => ({ header: h, key: h, width: h === 'photo' ? 14 : Math.max(12, h.length + 2) }));
    ws.getRow(1).eachCell((c) => Object.assign(c, headerStyle));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    let r = 2;
    for (const c of chaperones) {
      const row = ws.addRow(['', c.id, c.name, c.relation, c.phone, c.email, c.idNumber, c.faceCount, c.status, c.enrolled?'YES':'', c.authorizedStudents]);
      if (includePhotos && c.photoBuf) {
        try {
          const ext = (c.photoBuf[0] === 0x89 && c.photoBuf[1] === 0x50) ? 'png' : 'jpeg';
          const imgId = wb.addImage({ buffer: c.photoBuf, extension: ext });
          ws.getRow(r).height = 64;
          ws.addImage(imgId, { tl: { col: 0.1, row: r - 1 + 0.05 }, ext: { width: 80, height: 80 } });
        } catch {}
      }
      r++;
    }
  }

  return wb.xlsx.writeBuffer();
}

// ── PDF generation (@react-pdf/renderer) ────────────────────────────────────
async function buildPdf({ data, filters, sections, audit, meta }) {
  const React = (await import('react')).default || require('react');
  const reactPdf = await import('@react-pdf/renderer');
  const { Document, Page, Text, View, StyleSheet, renderToBuffer } = reactPdf;
  const e = React.createElement;

  const s = StyleSheet.create({
    page:    { padding: 28, fontSize: 9, fontFamily: 'Helvetica', color: '#0f172a' },
    h1:      { fontSize: 18, fontWeight: 700, color: '#0e7490', marginBottom: 4 },
    h2:      { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 6, color: '#0e7490', borderBottom: '1pt solid #cbd5e1', paddingBottom: 2 },
    meta:    { fontSize: 9, color: '#475569', marginBottom: 8 },
    kpiRow:  { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
    kpi:     { width: '25%', padding: 6, marginBottom: 6 },
    kpiVal:  { fontSize: 14, fontWeight: 700, color: '#0e7490' },
    kpiLbl:  { fontSize: 8, color: '#64748b', marginTop: 2 },
    table:   { display: 'table', width: 'auto', borderStyle: 'solid', borderWidth: 0 },
    tr:      { flexDirection: 'row' },
    th:      { backgroundColor: '#0e7490', color: '#fff', padding: 4, fontSize: 8, fontWeight: 700 },
    td:      { padding: 3, fontSize: 8, borderBottom: '0.5pt solid #e2e8f0' },
    footer:  { position: 'absolute', bottom: 16, left: 28, right: 28, fontSize: 7, color: '#94a3b8', textAlign: 'center' },
  });

  const Table = (cols, rows, widths) => {
    const W = widths || cols.map(() => `${(100 / cols.length).toFixed(2)}%`);
    return e(View, { style: s.table },
      e(View, { style: s.tr }, ...cols.map((c, i) => e(View, { key: i, style: { width: W[i] } }, e(Text, { style: s.th }, c)))),
      ...rows.map((r, ri) => e(View, { key: ri, style: s.tr },
        ...r.map((cell, ci) => e(View, { key: ci, style: { width: W[ci] } }, e(Text, { style: s.td }, safeStr(cell))))))
    );
  };

  const cardStateBar = () => {
    const t = (data.byCardState.green || 0) + (data.byCardState.yellow || 0) + (data.byCardState.red || 0);
    if (!t) return null;
    const pct = (n) => `${Math.round((n / t) * 100)}%`;
    return e(View, { style: { flexDirection: 'row', height: 14, marginVertical: 6 } },
      e(View, { style: { width: pct(data.byCardState.green || 0), backgroundColor: '#10b981' } }),
      e(View, { style: { width: pct(data.byCardState.yellow || 0), backgroundColor: '#f59e0b' } }),
      e(View, { style: { width: pct(data.byCardState.red || 0), backgroundColor: '#ef4444' } }),
    );
  };

  const children = [];
  // Cover
  children.push(e(View, { key: 'hdr' },
    e(Text, { style: s.h1 }, 'BINUS Pickup Report'),
    e(Text, { style: s.meta }, `${data.range.from} → ${data.range.to}  ·  ${data.range.totalDays} days  ·  generated ${new Date().toISOString().slice(0,19).replace('T',' ')} UTC  ·  by ${meta.actor}${filters?.grade?`  ·  grade ${filters.grade}`:''}${filters?.homeroom?`  ·  homeroom ${filters.homeroom}`:''}`),
  ));

  if (sections.summary) {
    const k = data.summary;
    children.push(e(View, { key: 'kpis' },
      e(Text, { style: s.h2 }, 'Summary'),
      e(View, { style: s.kpiRow },
        ...[
          ['Total pickups', k.totalPickups],
          ['Auto approved', k.autoApproved],
          ['Overrides',     k.officerOverridden],
          ['Flagged',       k.flagged],
          ['Avg/day',       k.avgPerDay],
          ['Approval rate', fmtPct(k.approvalRate)],
          ['Override rate', fmtPct(k.overrideRate)],
          ['Days',          data.range.totalDays],
        ].map(([lbl, v], i) => e(View, { key: i, style: s.kpi },
          e(Text, { style: s.kpiVal }, safeStr(v)),
          e(Text, { style: s.kpiLbl }, lbl),
        )),
      ),
      cardStateBar(),
    ));
  }

  if (sections.byGate && data.byGate.length) {
    children.push(e(View, { key: 'gate' },
      e(Text, { style: s.h2 }, 'By Gate'),
      Table(['Gate','Total','Approved','Overrides','Green','Yellow','Red'],
        data.byGate.slice(0, 25).map(r => [r.gate, r.total, r.autoApproved, r.overridden, r.green, r.yellow, r.red])),
    ));
  }

  if (sections.byClass && data.byClass.length) {
    children.push(e(View, { key: 'class' },
      e(Text, { style: s.h2 }, 'By Class'),
      Table(['Homeroom','Pickups'],
        data.byClass.slice(0, 30).map(r => [r.homeroom, r.total]),
        ['70%', '30%']),
    ));
  }

  if (sections.byTerminal && data.byTerminal.length) {
    children.push(e(View, { key: 'term' },
      e(Text, { style: s.h2 }, 'By Terminal (FR signals)'),
      Table(['Gate','Total','AvgConf%','Liveness%','Spoof','LowConf','Unknown'],
        data.byTerminal.slice(0, 25).map(r => [r.gate, r.total, r.avgConfidence ?? '—', r.livenessPassRate ?? '—', r.spoof, r.lowConfidence, r.unknownChaperone])),
    ));
  }

  if (sections.topChaperones && data.topChaperones.length) {
    children.push(e(View, { key: 'chaps' },
      e(Text, { style: s.h2 }, 'Top Chaperones'),
      Table(['Name','Pickups'],
        data.topChaperones.slice(0, 15).map(r => [r.name, r.total]),
        ['70%', '30%']),
    ));
  }

  if (sections.frFlags) {
    if ((data.fr.lowConfidenceFlags || []).length) {
      children.push(e(View, { key: 'low' },
        e(Text, { style: s.h2 }, 'Low-Confidence Flags'),
        Table(['When','Gate','Chaperone','Conf'],
          data.fr.lowConfidenceFlags.slice(0, 25).map(r => [r.at, r.gate, r.chaperone, r.confidence])),
      ));
    }
    if ((data.fr.spoofFlags || []).length) {
      children.push(e(View, { key: 'spoof' },
        e(Text, { style: s.h2 }, 'Spoof / Liveness Flags'),
        Table(['When','Gate','Chaperone','Liveness'],
          data.fr.spoofFlags.slice(0, 25).map(r => [r.at, r.gate, r.chaperone, r.livenessScore ?? '—'])),
      ));
    }
  }

  if (sections.audit && audit?.length) {
    children.push(e(View, { key: 'audit' },
      e(Text, { style: s.h2 }, `Audit Trail (${audit.length} entries)`),
      Table(['When','Kind','Actor','Target','Summary'],
        audit.slice(0, 50).map(r => [(r.at||'').slice(0,19).replace('T',' '), r.kind, r.actor, r.target, r.summary]),
        ['18%', '18%', '18%', '20%', '26%']),
    ));
  }

  if (sections.recent && data.recent?.length) {
    children.push(e(View, { key: 'recent' },
      e(Text, { style: s.h2 }, 'Recent Events'),
      Table(['When','Gate','State','Override','Chaperone','Students'],
        data.recent.slice(0, 40).map(r => [
          (r.at||'').slice(0,19).replace('T',' '),
          r.gate, r.cardState, r.isOverride ? 'Y' : '',
          r.chaperone || '', (r.students||[]).map(st => `${st.name}${st.homeroom?` (${st.homeroom})`:''}`).join(', '),
        ]),
        ['16%', '14%', '10%', '8%', '20%', '32%']),
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

// ── CSV generation ──────────────────────────────────────────────────────────
function buildCsv({ data, filters, sections, audit, meta }) {
  const lines = [];
  const sec = (title) => { lines.push(''); lines.push(`# ${title}`); };
  lines.push(`BINUS Pickup Report,${data.range.from} to ${data.range.to}`);
  lines.push(`Generated,${new Date().toISOString()}`);
  lines.push(`Generated by,${meta.actor}`);
  lines.push(`Tenant,${meta.tenant}`);
  if (filters?.grade)    lines.push(`Filter: grade,${filters.grade}`);
  if (filters?.homeroom) lines.push(`Filter: homeroom,${filters.homeroom}`);

  if (sections.summary) {
    sec('Summary');
    Object.entries(data.summary).forEach(([k, v]) => lines.push(`${k},${escCsv(v)}`));
  }
  const writeTable = (title, headers, rows) => {
    if (!rows?.length) return;
    sec(title);
    lines.push(headers.join(','));
    rows.forEach((r) => lines.push(r.map(escCsv).join(',')));
  };
  if (sections.byDate)    writeTable('By Date', ['date','total','autoApproved','overridden','green','yellow','red'],
    data.byDate.map(r => [r.date,r.total,r.autoApproved,r.overridden,r.green,r.yellow,r.red]));
  if (sections.byGate)    writeTable('By Gate', ['gate','total','autoApproved','overridden','green','yellow','red'],
    data.byGate.map(r => [r.gate,r.total,r.autoApproved,r.overridden,r.green,r.yellow,r.red]));
  if (sections.byClass)   writeTable('By Class', ['homeroom','total'],
    data.byClass.map(r => [r.homeroom,r.total]));
  if (sections.byTerminal) writeTable('By Terminal',
    ['terminalId','gate','total','avgConfidence%','livenessPassRate%','spoof','lowConfidence','unknownChaperone','avgRetries'],
    data.byTerminal.map(r => [r.terminalId,r.gate,r.total,r.avgConfidence,r.livenessPassRate,r.spoof,r.lowConfidence,r.unknownChaperone,r.avgRetries]));
  if (sections.frFlags) {
    writeTable('Low Confidence Flags', ['at','gate','terminalId','chaperone','confidence'],
      (data.fr.lowConfidenceFlags||[]).map(r => [r.at,r.gate,r.terminalId,r.chaperone,r.confidence]));
    writeTable('Spoof Flags', ['at','gate','terminalId','chaperone','livenessScore'],
      (data.fr.spoofFlags||[]).map(r => [r.at,r.gate,r.terminalId,r.chaperone,r.livenessScore]));
  }
  if (sections.topChaperones) writeTable('Top Chaperones', ['name','total'],
    data.topChaperones.map(r => [r.name,r.total]));
  if (sections.recent) writeTable('Recent Events',
    ['at','gate','cardState','isOverride','chaperone','officer','students'],
    data.recent.map(r => [r.at,r.gate,r.cardState,r.isOverride?'YES':'',r.chaperone||'',r.officer||'',
      (r.students||[]).map(s => `${s.name}${s.homeroom?` (${s.homeroom})`:''}`).join('; ')]));
  if (sections.audit && audit?.length) writeTable('Audit Trail',
    ['at','kind','actor','target','summary','ip'],
    audit.map(r => [r.at,r.kind,r.actor,r.target,r.summary,r.ip]));

  return Buffer.from('\uFEFF' + lines.join('\n'), 'utf8');
}

// ── Handler ─────────────────────────────────────────────────────────────────
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const today = getWIBToday();
  const body = req.body || {};
  const format = String(body.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(format)) {
    return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" });
  }
  const from = isDate(body.from) ? body.from : today;
  const to   = isDate(body.to)   ? body.to   : today;
  const filters = body.filters || {};
  const sections = { ...DEFAULT_SECTIONS, ...(body.sections || {}) };
  const includePhotos = !!body.includeChaperonePhotos;

  const tid = tenancy.getTenantId();

  try {
    initializeFirebase();
    const db = admin.firestore();

    // Aggregate (same engine as /analytics)
    let data = await computePickupAnalytics(db, tid, { from, to });
    data = applyFilters(data, filters);

    // Side queries
    const [audit, chaperones] = await Promise.all([
      sections.audit       ? loadAuditEntries(db, tid, { from, to }) : Promise.resolve([]),
      sections.chaperones  ? loadChaperoneRoster(db, tid, { withPhotos: includePhotos }) : Promise.resolve([]),
    ]);

    const meta = {
      tenant: tid,
      actor: req.user?.email || req.user?.name || '—',
    };

    let buf, mime, filename;
    const baseName = `binus-pickup-report_${from}_to_${to}`;
    if (format === 'xlsx') {
      buf = await buildXlsx({ data, filters, sections, audit, chaperones, includePhotos, meta });
      mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      filename = `${baseName}.xlsx`;
    } else if (format === 'pdf') {
      buf = await buildPdf({ data, filters, sections, audit, meta });
      mime = 'application/pdf';
      filename = `${baseName}.pdf`;
    } else {
      buf = buildCsv({ data, filters, sections, audit, meta });
      mime = 'text/csv; charset=utf-8';
      filename = `${baseName}.csv`;
    }

    // Audit-log the export
    await logAudit(db, {
      tenantId: tid,
      actor: req.user || null,
      kind: 'pickup.report.export',
      target: { type: 'report', id: baseName, label: filename },
      summary: `Exported pickup report (${format.toUpperCase()})`,
      metadata: { format, from, to, filters, sections, includePhotos },
      req,
    });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch (err) {
    console.error('[pickup/admin/export]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['POST'], permission: 'reports.export' });
