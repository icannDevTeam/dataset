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
const {
  BRAND, logoDataUri,
  buildPdfCover, writeXlsxCoverSheet, brandHeaderStyle, applyZebra,
} = require('../../../../lib/report-branding');

// Lazy-required heavy deps (imported inside handlers below)
//   exceljs            — XLSX generation
//   @react-pdf/renderer — PDF generation

export const config = {
  api: { bodyParser: { sizeLimit: '256kb' }, responseLimit: false },
};

const DEFAULT_SECTIONS = {
  summary: true, byDate: true, byGate: true, byClass: true,
  byTerminal: true, frFlags: true, topChaperones: true,
  audit: false, chaperones: false, recent: true,
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

  const headerStyle = brandHeaderStyle('teal');

  // Branded cover sheet via shared module (logo, title block, KPI grid).
  const filterNotes = [];
  if (filters?.grade)    filterNotes.push(`Grade filter: ${filters.grade}`);
  if (filters?.homeroom) filterNotes.push(`Homeroom filter: ${filters.homeroom}`);
  writeXlsxCoverSheet(wb, {
    title:    'Pickup Operations Report',
    subtitle: 'Daily volume, gate flow, FR signals & chaperone activity',
    theme:    'teal',
    range:    `${data.range.from} → ${data.range.to} (${data.range.totalDays} days)`,
    actor:    meta.actor,
    tenant:   meta.tenant,
    kpis: sections.summary ? [
      ['Total pickups',     data.summary.totalPickups],
      ['Auto approved',     data.summary.autoApproved],
      ['Officer overrides', data.summary.officerOverridden],
      ['Flagged',           data.summary.flagged],
      ['Average per day',   data.summary.avgPerDay],
      ['Approval rate',     fmtPct(data.summary.approvalRate)],
    ] : [],
    notes: filterNotes,
  });

  const addTable = (name, headers, rows) => {
    if (!rows?.length) return;
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));
    ws.getRow(1).eachCell((c) => Object.assign(c, headerStyle));
    ws.getRow(1).height = 22;
    rows.forEach((r) => ws.addRow(r));
    applyZebra(ws);
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
  // (Cover page now handled via shared buildPdfCover; this Page holds
  // the detail tables. The intro line below provides at-a-glance context.)
  children.push(e(View, { key: 'hdr' },
    e(Text, { style: s.h1 }, 'Pickup Operations — Detail'),
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

  // Build branded cover page first; then a detail page with the tables.
  const filterNotes = [];
  if (filters?.grade)    filterNotes.push(`Grade filter: ${filters.grade}`);
  if (filters?.homeroom) filterNotes.push(`Homeroom filter: ${filters.homeroom}`);
  const coverPage = buildPdfCover(reactPdf, React, {
    title:    'Pickup Operations Report',
    subtitle: 'Daily volume, gate flow, FR signals & chaperone activity',
    theme:    'teal',
    range:    `${data.range.from} → ${data.range.to} (${data.range.totalDays} days)`,
    actor:    meta.actor,
    tenant:   meta.tenant,
    kpis: sections.summary ? [
      ['Total pickups',     data.summary.totalPickups],
      ['Auto approved',     data.summary.autoApproved],
      ['Officer overrides', data.summary.officerOverridden],
      ['Flagged',           data.summary.flagged],
      ['Average per day',   data.summary.avgPerDay],
      ['Approval rate',     fmtPct(data.summary.approvalRate)],
    ] : [],
    notes: filterNotes,
  });

  const doc = e(Document, null,
    coverPage,
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

// ── HTML print mode ─────────────────────────────────────────────────────────
// Self-printing letterhead HTML for the pickup-report. Renders the same
// sections as the PDF but as a browser-printable page; auto-fires
// window.print() so the operator can Save-as-PDF or send to a real printer.
function buildPrintHtml({ data, filters, sections, audit, meta }) {
  const esc = (v) => safeStr(v).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  const tbl = (title, headers, rows) => {
    if (!rows?.length) return '';
    return `<section class="block"><h3>${esc(title)}</h3><table><thead><tr>${
      headers.map(h => `<th>${esc(h)}</th>`).join('')
    }</tr></thead><tbody>${
      rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
    }</tbody></table></section>`;
  };

  const k = data.summary || {};
  const summaryHtml = sections.summary ? `
    <section class="block summary">
      <h3>Summary</h3>
      <div class="kpis">
        ${[
          ['Total pickups', k.totalPickups],['Auto approved', k.autoApproved],
          ['Overrides', k.officerOverridden],['Flagged', k.flagged],
          ['Avg/day', k.avgPerDay],['Approval rate', fmtPct(k.approvalRate)],
          ['Override rate', fmtPct(k.overrideRate)],['Days', data.range.totalDays],
        ].map(([l, v]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}
      </div>
    </section>` : '';

  // Per-terminal detail cards (one block per terminal with its FR signals)
  const terminalDetail = sections.byTerminal ? (data.byTerminal || []).map((t) => `
    <section class="block term-detail">
      <header class="term-head">
        <div>
          <div class="key">Terminal</div>
          <h3>${esc(t.gate || t.terminalId)}</h3>
          <div class="sub">ID: <code>${esc(t.terminalId)}</code></div>
        </div>
        <div class="term-kpis">
          <div><strong>${esc(t.total)}</strong><span>Pickups</span></div>
          <div><strong>${esc(t.avgConfidence ?? '—')}%</strong><span>Avg conf</span></div>
          <div><strong>${esc(t.livenessPassRate ?? '—')}%</strong><span>Liveness</span></div>
          <div><strong>${esc(t.spoof)}</strong><span>Spoof</span></div>
          <div><strong>${esc(t.lowConfidence)}</strong><span>Low conf</span></div>
          <div><strong>${esc(t.unknownChaperone)}</strong><span>Unknown</span></div>
        </div>
      </header>
    </section>`).join('') : '';

  // Per-event detail cards (terminal + chaperone + students for each recent event)
  const eventDetail = sections.recent ? (data.recent || []).slice(0, 80).map((r) => `
    <section class="block event-detail">
      <header class="event-head">
        <div>
          <div class="key">Pickup event</div>
          <h3>${esc((r.at||'').slice(0,19).replace('T',' '))}</h3>
        </div>
        <div class="event-meta">
          <div>Gate:&nbsp;<code>${esc(r.gate || '—')}</code></div>
          <div>State:&nbsp;<code>${esc(r.cardState || '—')}</code> ${r.isOverride ? '<span class="chip">OVERRIDE</span>' : ''}</div>
          ${r.officer ? `<div>Officer:&nbsp;<code>${esc(r.officer)}</code></div>` : ''}
        </div>
      </header>
      <div class="event-body">
        <div class="col">
          <div class="key">Chaperone</div>
          <strong>${esc(r.chaperone || '—')}</strong>
        </div>
        <div class="col wide">
          <div class="key">Students (${(r.students||[]).length})</div>
          ${(r.students||[]).map((s) => `<div class="stu">• <strong>${esc(s.name)}</strong>${s.homeroom ? ` <span class="hr">(${esc(s.homeroom)})</span>` : ''}</div>`).join('') || '<em>none</em>'}
        </div>
      </div>
    </section>`).join('') : '';

  return Buffer.from(`<!doctype html>
<html><head><meta charset="utf-8"><title>BINUS Pickup Report — ${esc(data.range.from)} → ${esc(data.range.to)}</title>
<style>
  *,*:before,*:after{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;background:#f1f5f9;margin:0;padding:24px}
  .toolbar{position:sticky;top:0;background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 6px 24px rgba(0,0,0,.15);margin-bottom:16px;z-index:10}
  .toolbar h1{margin:0;font-size:14px;font-weight:600}
  .toolbar button{background:#22d3ee;color:#0f172a;border:0;border-radius:6px;padding:7px 16px;font-weight:700;font-size:13px;cursor:pointer;margin-left:8px}
  .toolbar button.alt{background:#475569;color:#fff}
  .letterhead{background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:24px 28px;margin-bottom:14px;border-bottom:3px solid #0e7490}
  .letterhead .school{font-size:11px;color:#c2410c;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
  .letterhead h1{margin:0;font-size:22px;font-weight:700;color:#0f172a}
  .letterhead .meta{font-size:11px;color:#475569;margin-top:6px}
  .block{background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:18px 22px;margin-bottom:12px;page-break-inside:avoid}
  .block h3{font-size:11px;color:#0e7490;letter-spacing:1.2px;text-transform:uppercase;margin:0 0 10px;font-weight:700}
  .summary .kpis{display:grid;grid-template-columns:repeat(8,1fr);gap:10px}
  .kpi{padding:8px;background:#f8fafc;border-radius:6px}
  .kpi .v{font-size:18px;font-weight:700;color:#0e7490}
  .kpi .l{font-size:9px;color:#64748b;margin-top:2px;text-transform:uppercase;letter-spacing:.6px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th,td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left;vertical-align:top}
  th{background:#f1f5f9;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#475569}
  .term-detail .term-head{display:flex;justify-content:space-between;align-items:flex-start}
  .term-head h3{font-size:18px;color:#0f172a;margin:2px 0 2px;letter-spacing:0;text-transform:none}
  .term-head .key,.event-head .key,.event-body .key{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.6px}
  .term-head .sub{font-size:11px;color:#475569}
  .term-kpis{display:flex;gap:14px}
  .term-kpis div{text-align:right}
  .term-kpis strong{display:block;font-size:14px;color:#0e7490;font-weight:700}
  .term-kpis span{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px}
  .event-detail .event-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e2e8f0}
  .event-head h3{font-size:14px;color:#0f172a;margin:2px 0;letter-spacing:0;text-transform:none;font-family:Menlo,Consolas,monospace}
  .event-meta{font-size:11px;color:#475569;text-align:right}
  .event-meta div{margin:1px 0}
  .chip{background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.5px;margin-left:4px}
  .event-body{display:flex;gap:18px}
  .event-body .col{flex:1}
  .event-body .col.wide{flex:2}
  .event-body strong{font-size:13px;display:block;margin-top:2px}
  .stu{font-size:12px;margin-top:2px}
  .stu .hr{color:#64748b;font-size:11px}
  code{font-family:Menlo,Consolas,monospace;font-size:.92em}
  @media print {
    body{background:#fff;padding:0;margin:0}
    .toolbar{display:none !important}
    .letterhead,.block{box-shadow:none;border-radius:0;border-left:0;border-right:0;border-top:0;margin:0 0 6px}
    .block{page-break-inside:avoid}
    @page{size:A4;margin:14mm}
  }
</style></head>
<body>
  <div class="toolbar">
    <h1>BINUS Pickup Report — ${esc(data.range.from)} → ${esc(data.range.to)} · ${esc(data.range.totalDays)} days</h1>
    <div>
      <button class="alt" onclick="window.close()">Close</button>
      <button onclick="window.print()">Print / Save as PDF</button>
    </div>
  </div>
  <header class="letterhead">
    <div class="school">BINUS School Simprug</div>
    <h1>Pickup Operations Report</h1>
    <div class="meta">
      Range: <code>${esc(data.range.from)} → ${esc(data.range.to)}</code> ·
      ${filters?.grade ? `Grade: <code>${esc(filters.grade)}</code> · ` : ''}
      ${filters?.homeroom ? `Homeroom: <code>${esc(filters.homeroom)}</code> · ` : ''}
      Generated by <code>${esc(meta.actor)}</code> on <code>${esc(new Date().toISOString().slice(0,19).replace('T',' '))}</code> UTC
    </div>
  </header>

  ${summaryHtml}
  ${tbl('By Date', ['Date','Total','Auto','Override','Green','Yellow','Red'],
        sections.byDate ? (data.byDate||[]).map(r => [r.date,r.total,r.autoApproved,r.overridden,r.green,r.yellow,r.red]) : [])}
  ${tbl('By Gate', ['Gate','Total','Auto','Override','Green','Yellow','Red'],
        sections.byGate ? (data.byGate||[]).map(r => [r.gate,r.total,r.autoApproved,r.overridden,r.green,r.yellow,r.red]) : [])}
  ${tbl('By Class', ['Homeroom','Pickups'],
        sections.byClass ? (data.byClass||[]).map(r => [r.homeroom,r.total]) : [])}
  ${tbl('Top Chaperones', ['Name','Pickups'],
        sections.topChaperones ? (data.topChaperones||[]).map(r => [r.name,r.total]) : [])}
  ${terminalDetail ? `<h2 style="margin:18px 0 6px;color:#0e7490;font-size:13px;text-transform:uppercase;letter-spacing:1.2px">Terminal Details</h2>${terminalDetail}` : ''}
  ${sections.frFlags ? tbl('Low-Confidence Flags', ['When','Gate','Chaperone','Conf'],
        (data.fr?.lowConfidenceFlags||[]).map(r => [r.at,r.gate,r.chaperone,r.confidence])) : ''}
  ${sections.frFlags ? tbl('Spoof / Liveness Flags', ['When','Gate','Chaperone','Liveness'],
        (data.fr?.spoofFlags||[]).map(r => [r.at,r.gate,r.chaperone,r.livenessScore ?? '—'])) : ''}
  ${eventDetail ? `<h2 style="margin:18px 0 6px;color:#0e7490;font-size:13px;text-transform:uppercase;letter-spacing:1.2px">Recent Event Details</h2>${eventDetail}` : ''}
  ${tbl(`Audit Trail (${audit?.length || 0})`, ['When','Kind','Actor','Target','Summary'],
        (sections.audit && audit?.length) ? audit.map(r => [(r.at||'').slice(0,19).replace('T',' '), r.kind, r.actor, r.target, r.summary]) : [])}

  <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},300);});</script>
</body></html>`, 'utf8');
}

// ── Handler ────────────────────────────────────────────────────────────────
async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const today = getWIBToday();
  const body = req.body || {};
  const format = String(body.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv', 'print'].includes(format)) {
    return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf', 'csv' or 'print'" });
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
    } else if (format === 'print') {
      buf = buildPrintHtml({ data, filters, sections, audit, meta });
      mime = 'text/html; charset=utf-8';
      filename = `${baseName}.html`;
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
    const disp = format === 'print' ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disp}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch (err) {
    console.error('[pickup/admin/export]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['POST'], permission: 'reports.export', reauth: true });
