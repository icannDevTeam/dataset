/**
 * lib/downloads-helpers.js
 *
 * Shared output renderers for the /v2/admin/downloads hub endpoints.
 * Each endpoint pulls + reshapes its data, then hands a uniform
 * { title, subtitle, theme, kpis, columns, rows, range, actor, tenant,
 *   notes, kind, format } payload to one of the builders below.
 *
 * Reuses lib/report-branding.js so every download has the same look
 * (BINUS logo cover page, brand colours, zebra striping).
 */
const {
  BRAND, logoDataUri,
  buildPdfCover, writeXlsxCoverSheet, brandHeaderStyle, applyZebra,
} = require('./report-branding');

// Cap pulled from Firestore in any single export, to keep memory + PDF
// page count bounded. We append a footer note when truncation happens.
const MAX_ROWS = 5000;

function safeStr(v) { return v == null ? '' : String(v); }

function escCsv(v) {
  const s = safeStr(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(payload) {
  const { columns, rows } = payload;
  const lines = [columns.map(escCsv).join(',')];
  for (const r of rows) lines.push(r.map(escCsv).join(','));
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function buildXlsx(payload) {
  const ExcelJS = (await import('exceljs')).default || require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BINUS Facial Attendance';
  wb.created = new Date();

  writeXlsxCoverSheet(wb, {
    title:    payload.title,
    subtitle: payload.subtitle,
    theme:    payload.theme || 'teal',
    range:    payload.range,
    actor:    payload.actor,
    tenant:   payload.tenant,
    kpis:     payload.kpis || [],
    notes:    payload.notes || [],
  });

  const ws = wb.addWorksheet(payload.sheetName || 'Data', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  ws.columns = payload.columns.map((h) => ({
    header: h,
    key: h,
    width: Math.max(12, Math.min(48, h.length + 4)),
  }));
  const head = brandHeaderStyle(payload.theme || 'teal');
  ws.getRow(1).eachCell((c) => Object.assign(c, head));
  ws.getRow(1).height = 22;
  for (const r of payload.rows) ws.addRow(r);
  applyZebra(ws);

  if (payload.truncated) {
    ws.addRow([]);
    const note = ws.addRow([`Note: results truncated at ${MAX_ROWS} rows. Narrow the date range for a complete export.`]);
    note.getCell(1).font = { italic: true, color: { argb: BRAND.argb.muted } };
  }

  return wb.xlsx.writeBuffer();
}

async function buildPdf(payload) {
  const React = (await import('react')).default || require('react');
  const reactPdf = await import('@react-pdf/renderer');
  const { Document, Page, Text, View, StyleSheet, renderToBuffer } = reactPdf;
  const e = React.createElement;

  const themeColor = payload.theme === 'green' ? '#047857' : '#0e7490';

  const s = StyleSheet.create({
    page:    { padding: 28, fontSize: 9, fontFamily: 'Helvetica', color: '#0f172a' },
    h1:      { fontSize: 16, fontWeight: 700, color: themeColor, marginBottom: 4 },
    meta:    { fontSize: 9, color: '#475569', marginBottom: 10 },
    table:   { display: 'table', width: 'auto', borderStyle: 'solid', borderWidth: 0 },
    tr:      { flexDirection: 'row' },
    th:      { backgroundColor: themeColor, color: '#fff', padding: 4, fontSize: 8, fontWeight: 700 },
    td:      { padding: 3, fontSize: 7.5, borderBottom: '0.5pt solid #e2e8f0' },
    tdAlt:   { padding: 3, fontSize: 7.5, borderBottom: '0.5pt solid #e2e8f0', backgroundColor: '#f8fafc' },
    note:    { marginTop: 12, fontSize: 8, color: '#94a3b8', fontStyle: 'italic' },
    footer:  { position: 'absolute', bottom: 16, left: 28, right: 28, fontSize: 7, color: '#94a3b8', textAlign: 'center' },
  });

  const widths = (() => {
    if (Array.isArray(payload.colWidths) && payload.colWidths.length === payload.columns.length) {
      return payload.colWidths.map((w) => `${w}%`);
    }
    const w = (100 / payload.columns.length).toFixed(2);
    return payload.columns.map(() => `${w}%`);
  })();

  const cover = buildPdfCover(reactPdf, React, {
    title:    payload.title,
    subtitle: payload.subtitle,
    theme:    payload.theme || 'teal',
    range:    payload.range,
    actor:    payload.actor,
    tenant:   payload.tenant,
    kpis:     payload.kpis || [],
    notes:    payload.notes || [],
  });

  // Body: chunk rows across pages, ~36 rows per A4 page after header.
  const ROWS_PER_PAGE = 34;
  const bodyPages = [];
  const rows = payload.rows;
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) {
    const chunk = rows.slice(i, i + ROWS_PER_PAGE);
    bodyPages.push(e(Page, { key: `b${i}`, size: 'A4', style: s.page },
      e(Text, { style: s.h1 }, `${payload.title} — Detail`),
      e(Text, { style: s.meta },
        `${payload.range || ''}  ·  ${payload.kind || ''}  ·  page ${Math.floor(i / ROWS_PER_PAGE) + 1} of ${Math.ceil(rows.length / ROWS_PER_PAGE) || 1}  ·  ${rows.length.toLocaleString()} rows`),
      e(View, { style: s.table },
        e(View, { style: s.tr }, ...payload.columns.map((c, ci) =>
          e(View, { key: ci, style: { width: widths[ci] } }, e(Text, { style: s.th }, c)))),
        ...chunk.map((r, ri) => e(View, { key: ri, style: s.tr },
          ...r.map((cell, ci) => e(View, { key: ci, style: { width: widths[ci] } },
            e(Text, { style: ri % 2 === 1 ? s.tdAlt : s.td }, safeStr(cell)))))),
      ),
      payload.truncated && (i + ROWS_PER_PAGE >= rows.length)
        ? e(Text, { style: s.note }, `Note: results truncated at ${MAX_ROWS} rows. Narrow the date range for a complete export.`)
        : null,
      e(Text, { style: s.footer, fixed: true },
        'BINUS School Simprug · CONFIDENTIAL · For internal use only'),
    ));
  }

  if (bodyPages.length === 0) {
    bodyPages.push(e(Page, { key: 'empty', size: 'A4', style: s.page },
      e(Text, { style: s.h1 }, `${payload.title} — Detail`),
      e(Text, { style: s.meta }, payload.range || ''),
      e(Text, { style: s.note }, 'No rows in the selected range.'),
      e(Text, { style: s.footer, fixed: true },
        'BINUS School Simprug · CONFIDENTIAL · For internal use only'),
    ));
  }

  const doc = e(Document, null, cover, ...bodyPages);
  return renderToBuffer(doc);
}

/**
 * Build the final response buffer + headers for an export.
 * Resolves to { buf, mime, filename }.
 */
async function renderDownload(payload) {
  const fmt = String(payload.format || 'xlsx').toLowerCase();
  const base = `binus-${payload.kind || 'export'}_${payload.dateStamp || ''}`.replace(/_$/, '');
  if (fmt === 'xlsx') {
    return {
      buf: await buildXlsx(payload),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${base}.xlsx`,
    };
  }
  if (fmt === 'pdf') {
    return {
      buf: await buildPdf(payload),
      mime: 'application/pdf',
      filename: `${base}.pdf`,
    };
  }
  return {
    buf: buildCsv(payload),
    mime: 'text/csv; charset=utf-8',
    filename: `${base}.csv`,
  };
}

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/** Validate + normalize { format, from, to } from request body. */
function validateExportRequest(body, opts = {}) {
  const fmt = String(body.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return { error: { status: 400, body: { error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" } } };
  }
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const to = isDate(body.to) ? body.to : today;
  const fromDef = (() => {
    const d = new Date(Date.now() + 7 * 3600 * 1000);
    d.setUTCDate(d.getUTCDate() - 29);
    return d.toISOString().slice(0, 10);
  })();
  const from = isDate(body.from) ? body.from : fromDef;
  // Cap at 365 days to avoid runaway scans
  const days = Math.ceil(
    (new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime()) / 86400000,
  ) + 1;
  const maxDays = opts.maxDays || 365;
  if (days < 1) {
    return { error: { status: 400, body: { error: 'bad_range', message: 'From must be on or before To.' } } };
  }
  if (days > maxDays) {
    return { error: { status: 400, body: { error: 'range_too_wide', message: `Range exceeds ${maxDays} days.` } } };
  }
  return { format: fmt, from, to, days };
}

/**
 * Build a JSON preview payload for the Downloads Hub UI.
 * Returns the same shape no matter the source endpoint, so the
 * frontend renders one modal regardless of which export it's previewing.
 */
function buildPreview(payload, { sampleSize = 25 } = {}) {
  const rows = payload.rows || [];
  return {
    preview: true,
    title: payload.title,
    subtitle: payload.subtitle,
    theme: payload.theme || 'teal',
    range: payload.range || '',
    actor: payload.actor,
    tenant: payload.tenant,
    kpis: payload.kpis || [],
    columns: payload.columns || [],
    sampleRows: rows.slice(0, sampleSize),
    totalRows: rows.length,
    truncated: !!payload.truncated,
    notes: payload.notes || [],
    kind: payload.kind,
    sampleSize,
  };
}

module.exports = {
  MAX_ROWS,
  renderDownload,
  buildCsv,
  buildXlsx,
  buildPdf,
  validateExportRequest,
  buildPreview,
  safeStr,
  escCsv,
};
