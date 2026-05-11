/**
 * Shared report branding utilities for PDF + XLSX exports.
 *
 *   - Loads the BINUS School Simprug logo from disk (cached) and exposes
 *     it as both a Buffer (XLSX) and a base64 data-URI (PDF / HTML).
 *   - Centralises the brand colour palette so every report (onboarding,
 *     pickup analytics, attendance) shares one identity.
 *   - Provides reusable helpers:
 *       buildPdfCover(opts)      → array of @react-pdf/renderer elements
 *                                  for a full-bleed first page.
 *       writeXlsxCoverSheet(wb, opts)  → seeds the workbook's Summary tab
 *                                  with logo + title + branded KPI rows.
 */
const fs = require('fs');
const path = require('path');

// Brand palette (BINUS Simprug)
const BRAND = {
  primary:        '#0e7490',  // teal-700 — main headers
  primaryDark:    '#0f4c5c',
  accent:         '#c2410c',  // burnt orange — secondary
  ink:            '#0f172a',
  inkSoft:        '#334155',
  muted:          '#64748b',
  rule:           '#cbd5e1',
  ruleSoft:       '#e2e8f0',
  bgCream:        '#fefce8',
  bgGreen:        '#047857',  // emerald-700 — onboarding
  bgGreenDark:    '#064e3b',

  // ARGB hex for ExcelJS (alpha first)
  argb: {
    primary:    'FF0E7490',
    primaryDark:'FF0F4C5C',
    accent:     'FFC2410C',
    ink:        'FF0F172A',
    inkSoft:    'FF334155',
    muted:      'FF64748B',
    ruleSoft:   'FFE2E8F0',
    bgCream:    'FFFEFCE8',
    bgGreen:    'FF047857',
    white:      'FFFFFFFF',
    band:       'FFF8FAFC',
  },
};

// ── Logo cache ──────────────────────────────────────────────────────────────
let _logoBuf = null;
let _logoExt = null;
function loadLogoBuffer() {
  if (_logoBuf) return { buf: _logoBuf, ext: _logoExt };
  const candidates = [
    path.join(process.cwd(), 'public', 'binus-logo.png'),
    path.join(process.cwd(), 'public', 'binus-logo.jpg'),
    path.join(process.cwd(), 'public', 'binus-logo.jpeg'),
  ];
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(p);
      _logoBuf = buf;
      _logoExt = (buf[0] === 0x89 && buf[1] === 0x50) ? 'png' : 'jpeg';
      return { buf: _logoBuf, ext: _logoExt };
    } catch { /* try next */ }
  }
  return { buf: null, ext: null };
}

/** Returns a base64 data URI for the BINUS logo, or null. */
function logoDataUri() {
  const { buf, ext } = loadLogoBuffer();
  if (!buf) return null;
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

/** Convert any image Buffer to a base64 data URI. Sniffs PNG vs JPEG. */
function bufferToDataUri(buf) {
  if (!buf) return null;
  const ext = (buf[0] === 0x89 && buf[1] === 0x50) ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

// ── PDF cover page (returns array of elements) ──────────────────────────────
/**
 * Render a polished cover page using @react-pdf/renderer primitives.
 *
 *   reactPdf      — the imported '@react-pdf/renderer' module
 *   React         — the React module (for createElement)
 *   opts.title    — main report title (e.g. 'Pickup Authorization Forms')
 *   opts.subtitle — sub-line (e.g. 'Onboarding Submissions Report')
 *   opts.theme    — 'teal' | 'green' (defaults to teal)
 *   opts.range    — 'YYYY-MM-DD → YYYY-MM-DD'
 *   opts.actor    — generator email
 *   opts.tenant   — tenant id
 *   opts.kpis     — array of [label, value] for the centered grid
 *   opts.notes    — optional array of free-form lines (filters etc.)
 */
function buildPdfCover(reactPdf, React, opts) {
  const { Page, Text, View, Image, StyleSheet } = reactPdf;
  const e = React.createElement;
  const theme = opts.theme === 'green' ? {
    primary: BRAND.bgGreen, primaryDark: BRAND.bgGreenDark,
  } : {
    primary: BRAND.primary, primaryDark: BRAND.primaryDark,
  };
  const logo = logoDataUri();
  const generated = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

  const s = StyleSheet.create({
    page:        { padding: 0, fontFamily: 'Helvetica', color: BRAND.ink, backgroundColor: '#ffffff' },
    band:        { backgroundColor: theme.primary, paddingTop: 48, paddingBottom: 32, paddingHorizontal: 48 },
    bandRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
    logoBox:     { width: 64, height: 64, padding: 6, backgroundColor: '#ffffff', borderRadius: 6, marginRight: 18 },
    logo:        { width: 52, height: 52, objectFit: 'contain' },
    schoolKey:   { fontSize: 9, color: '#a7f3d0', letterSpacing: 2, fontWeight: 700 },
    schoolName:  { fontSize: 14, color: '#ffffff', fontWeight: 700, marginTop: 2 },
    title:       { fontSize: 28, color: '#ffffff', fontWeight: 700, lineHeight: 1.15, marginTop: 6 },
    subtitle:    { fontSize: 12, color: '#e2e8f0', marginTop: 6 },
    rangeChip:   { marginTop: 14, paddingVertical: 5, paddingHorizontal: 10, backgroundColor: theme.primaryDark, borderRadius: 3, alignSelf: 'flex-start' },
    rangeText:   { fontSize: 10, color: '#ffffff', letterSpacing: 0.6, fontWeight: 700 },

    body:        { paddingHorizontal: 48, paddingTop: 28, paddingBottom: 48 },
    sectionLbl:  { fontSize: 9, color: BRAND.accent, letterSpacing: 1.6, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 },
    metaTable:   { borderTop: `0.5pt solid ${BRAND.ruleSoft}`, marginBottom: 24 },
    metaRow:     { flexDirection: 'row', borderBottom: `0.5pt solid ${BRAND.ruleSoft}`, paddingVertical: 6 },
    metaKey:     { width: 130, fontSize: 9, color: BRAND.muted, textTransform: 'uppercase', letterSpacing: 0.6 },
    metaVal:     { flex: 1, fontSize: 11, color: BRAND.ink, fontWeight: 600 },

    kpiGrid:     { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
    kpiCard:     { width: '33.33%', padding: 6 },
    kpiInner:    { borderWidth: 1, borderColor: BRAND.ruleSoft, borderStyle: 'solid', borderRadius: 6, padding: 12, height: 70 },
    kpiVal:      { fontSize: 22, color: theme.primary, fontWeight: 700, lineHeight: 1.0 },
    kpiLbl:      { fontSize: 8, color: BRAND.muted, marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.5 },

    notes:       { marginTop: 24, fontSize: 9, color: BRAND.inkSoft, lineHeight: 1.5 },
    footer:      { position: 'absolute', bottom: 24, left: 48, right: 48, fontSize: 8, color: BRAND.muted, textAlign: 'center', borderTop: `0.5pt solid ${BRAND.ruleSoft}`, paddingTop: 8 },
    confidential:{ marginTop: 4, fontSize: 7, color: BRAND.muted, letterSpacing: 1.2 },
  });

  const headerKids = [];
  if (logo) {
    headerKids.push(e(View, { key: 'lb', style: s.logoBox }, e(Image, { style: s.logo, src: logo })));
  }
  headerKids.push(e(View, { key: 'sn' },
    e(Text, { style: s.schoolKey }, 'BINUS SCHOOL SIMPRUG'),
    e(Text, { style: s.schoolName }, 'Facial Attendance & Pickup System'),
  ));

  const kpis = opts.kpis || [];

  return e(Page, { size: 'A4', style: s.page },
    // top brand band
    e(View, { style: s.band },
      e(View, { style: s.bandRow }, ...headerKids),
      e(Text, { style: s.title }, opts.title || 'Report'),
      opts.subtitle ? e(Text, { style: s.subtitle }, opts.subtitle) : null,
      opts.range ? e(View, { style: s.rangeChip },
        e(Text, { style: s.rangeText }, `REPORTING PERIOD · ${opts.range}`),
      ) : null,
    ),
    // body
    e(View, { style: s.body },
      e(Text, { style: s.sectionLbl }, 'Document Information'),
      e(View, { style: s.metaTable },
        e(View, { style: s.metaRow },
          e(Text, { style: s.metaKey }, 'Generated'), e(Text, { style: s.metaVal }, generated)),
        e(View, { style: s.metaRow },
          e(Text, { style: s.metaKey }, 'Generated by'), e(Text, { style: s.metaVal }, opts.actor || '—')),
        e(View, { style: s.metaRow },
          e(Text, { style: s.metaKey }, 'Tenant'), e(Text, { style: s.metaVal }, opts.tenant || '—')),
        opts.range ? e(View, { style: s.metaRow },
          e(Text, { style: s.metaKey }, 'Period'), e(Text, { style: s.metaVal }, opts.range)) : null,
      ),
      kpis.length ? e(Text, { style: s.sectionLbl }, 'Key Indicators') : null,
      kpis.length ? e(View, { style: s.kpiGrid },
        ...kpis.map(([lbl, val], i) => e(View, { key: i, style: s.kpiCard },
          e(View, { style: s.kpiInner },
            e(Text, { style: s.kpiVal }, String(val ?? '—')),
            e(Text, { style: s.kpiLbl }, lbl),
          ),
        )),
      ) : null,
      opts.notes && opts.notes.length
        ? e(View, { style: s.notes }, ...opts.notes.map((n, i) => e(Text, { key: i }, n)))
        : null,
    ),
    e(View, { style: s.footer, fixed: true },
      e(Text, null, 'BINUS School Simprug · Jl. Pasar Jum\u02BCat, Pondok Pinang, Jakarta Selatan'),
      e(Text, { style: s.confidential }, 'CONFIDENTIAL · For internal use only'),
    ),
  );
}

// ── XLSX cover sheet ────────────────────────────────────────────────────────
/**
 * Seeds an ExcelJS workbook with a polished Summary worksheet.
 *
 *   wb           — ExcelJS Workbook instance (already created)
 *   opts.title   — main title
 *   opts.subtitle
 *   opts.theme   — 'teal' | 'green'
 *   opts.range
 *   opts.actor
 *   opts.tenant
 *   opts.kpis    — array of [label, value]
 *   opts.notes   — array of strings (filter context)
 *
 * Returns the cover worksheet.
 */
function writeXlsxCoverSheet(wb, opts) {
  const argb = (opts.theme === 'green') ? BRAND.argb.bgGreen : BRAND.argb.primary;
  const cover = wb.addWorksheet('Summary', {
    properties: { tabColor: { argb } },
    views: [{ showGridLines: false, zoomScale: 110 }],
    pageSetup: { orientation: 'portrait', paperSize: 9, fitToPage: true, margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5, header: 0.3, footer: 0.3 } },
  });
  cover.columns = [{ width: 4 }, { width: 24 }, { width: 28 }, { width: 28 }, { width: 4 }];

  // Top brand band — rows 1..5 with solid colour fill, logo placed on left.
  for (let r = 1; r <= 5; r++) {
    const row = cover.getRow(r);
    row.height = 22;
    for (let c = 1; c <= 5; c++) {
      const cell = row.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
      cell.border = {};
    }
  }
  cover.mergeCells('B2:D2');
  cover.getCell('B2').value = 'BINUS SCHOOL SIMPRUG';
  cover.getCell('B2').font = { bold: true, color: { argb: BRAND.argb.white }, size: 9 };
  cover.getCell('B2').alignment = { vertical: 'middle' };
  cover.mergeCells('B3:D3');
  cover.getCell('B3').value = opts.title || 'Report';
  cover.getCell('B3').font = { bold: true, color: { argb: BRAND.argb.white }, size: 18 };
  cover.getCell('B3').alignment = { vertical: 'middle' };
  cover.mergeCells('B4:D4');
  cover.getCell('B4').value = opts.subtitle || 'Facial Attendance & Pickup System';
  cover.getCell('B4').font = { color: { argb: 'FFE2E8F0' }, size: 10 };
  cover.getCell('B4').alignment = { vertical: 'middle' };

  // Embed logo — drop into B2 area
  try {
    const { buf, ext } = loadLogoBuffer();
    if (buf) {
      const imgId = wb.addImage({ buffer: buf, extension: ext });
      cover.addImage(imgId, { tl: { col: 0.3, row: 1.2 }, ext: { width: 60, height: 60 } });
    }
  } catch { /* ignore */ }

  // Spacer
  cover.addRow([]); cover.addRow([]);

  // Document Information block
  let r = cover.rowCount + 1;
  cover.getCell(`B${r}`).value = 'DOCUMENT INFORMATION';
  cover.getCell(`B${r}`).font = { bold: true, color: { argb: BRAND.argb.accent }, size: 9 };
  cover.mergeCells(`B${r}:D${r}`);
  r++;
  const generated = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const meta = [
    ['Generated',    generated],
    ['Generated by', opts.actor || '—'],
    ['Tenant',       opts.tenant || '—'],
  ];
  if (opts.range) meta.push(['Period', opts.range]);
  meta.forEach(([k, v]) => {
    cover.getCell(`B${r}`).value = k;
    cover.getCell(`B${r}`).font = { color: { argb: BRAND.argb.muted }, size: 9 };
    cover.getCell(`B${r}`).alignment = { vertical: 'middle' };
    cover.mergeCells(`C${r}:D${r}`);
    cover.getCell(`C${r}`).value = v;
    cover.getCell(`C${r}`).font = { color: { argb: BRAND.argb.ink }, size: 11, bold: true };
    cover.getCell(`C${r}`).alignment = { vertical: 'middle' };
    cover.getRow(r).height = 18;
    cover.getRow(r).border = { bottom: { style: 'thin', color: { argb: BRAND.argb.ruleSoft } } };
    r++;
  });

  // KPI block
  if (opts.kpis && opts.kpis.length) {
    cover.addRow([]); r++;
    cover.getCell(`B${r}`).value = 'KEY INDICATORS';
    cover.getCell(`B${r}`).font = { bold: true, color: { argb: BRAND.argb.accent }, size: 9 };
    cover.mergeCells(`B${r}:D${r}`);
    r++;
    // Header row for the KPI table
    const head = cover.getRow(r);
    head.getCell(2).value = 'Indicator';
    head.getCell(3).value = 'Value';
    [2, 3].forEach((c) => {
      head.getCell(c).font = { bold: true, color: { argb: BRAND.argb.white } };
      head.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
      head.getCell(c).alignment = { vertical: 'middle' };
    });
    cover.mergeCells(`C${r}:D${r}`);
    head.height = 20;
    r++;
    opts.kpis.forEach(([lbl, val], i) => {
      const row = cover.getRow(r);
      row.getCell(2).value = lbl;
      row.getCell(3).value = val;
      row.getCell(2).font = { color: { argb: BRAND.argb.inkSoft }, size: 10 };
      row.getCell(3).font = { color: { argb: argb }, size: 12, bold: true };
      cover.mergeCells(`C${r}:D${r}`);
      // banded rows
      if (i % 2 === 1) {
        [2, 3].forEach((c) => {
          row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.argb.band } };
        });
      }
      row.height = 18;
      r++;
    });
  }

  // Notes
  if (opts.notes && opts.notes.length) {
    cover.addRow([]); r++;
    cover.getCell(`B${r}`).value = 'CONTEXT';
    cover.getCell(`B${r}`).font = { bold: true, color: { argb: BRAND.argb.accent }, size: 9 };
    cover.mergeCells(`B${r}:D${r}`);
    r++;
    opts.notes.forEach((n) => {
      cover.getCell(`B${r}`).value = n;
      cover.getCell(`B${r}`).font = { color: { argb: BRAND.argb.inkSoft }, size: 10 };
      cover.mergeCells(`B${r}:D${r}`);
      cover.getRow(r).alignment = { wrapText: true, vertical: 'top' };
      r++;
    });
  }

  // Footer
  cover.addRow([]); r++;
  cover.getCell(`B${r}`).value = 'CONFIDENTIAL · BINUS School Simprug · For internal use only';
  cover.getCell(`B${r}`).font = { color: { argb: BRAND.argb.muted }, size: 8, italic: true };
  cover.mergeCells(`B${r}:D${r}`);

  return cover;
}

/** Apply a polished branded header style to the first row of any worksheet. */
function brandHeaderStyle(theme) {
  const argb = (theme === 'green') ? BRAND.argb.bgGreen : BRAND.argb.primary;
  return {
    font: { bold: true, color: { argb: BRAND.argb.white }, size: 10 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } },
    alignment: { vertical: 'middle', horizontal: 'left' },
    border: {
      bottom: { style: 'medium', color: { argb: BRAND.argb.primaryDark } },
    },
  };
}

/** Apply zebra-striping to data rows of a worksheet (skips row 1 = header). */
function applyZebra(ws) {
  for (let r = 2; r <= ws.rowCount; r++) {
    if (r % 2 === 0) {
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
        if (!cell.fill || cell.fill.type !== 'pattern') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.argb.band } };
        }
      });
    }
  }
}

module.exports = {
  BRAND,
  loadLogoBuffer,
  logoDataUri,
  bufferToDataUri,
  buildPdfCover,
  writeXlsxCoverSheet,
  brandHeaderStyle,
  applyZebra,
};
