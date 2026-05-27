/**
 * lib/download.js — Reliable browser blob/file download helpers.
 *
 * Why this exists:
 *   The previous in-file `downloadCSV` helpers created an `<a>` element and
 *   called `.click()` without appending to the DOM, then revoked the object
 *   URL synchronously. Firefox / Safari silently dropped those downloads
 *   and Chrome occasionally raced the revoke. This module centralises a
 *   correct implementation.
 *
 * Usage:
 *   import { downloadBlob, downloadCSV } from '../lib/download';
 *   downloadCSV('report.csv', [['Name','Date'], ['Ada','2026-01-01']]);
 *   downloadBlob(myBlob, 'export.pdf');
 */

/**
 * Trigger a browser download for an arbitrary Blob.
 * Returns true if the click was dispatched (best-effort indicator).
 */
export function downloadBlob(blob, filename) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!(blob instanceof Blob)) {
    throw new TypeError('downloadBlob: first argument must be a Blob');
  }
  if (!filename || typeof filename !== 'string') {
    throw new TypeError('downloadBlob: filename is required');
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // MUST be in the DOM for some browsers (Firefox, Safari) to honor the click.
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    // Defer cleanup so the browser has time to start the download before
    // we release the object URL. requestAnimationFrame + small timeout
    // is the safest cross-browser pattern.
    const cleanup = () => {
      try { a.remove(); } catch {}
      try { URL.revokeObjectURL(url); } catch {}
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => setTimeout(cleanup, 0));
    } else {
      setTimeout(cleanup, 100);
    }
  }
  return true;
}

/**
 * Escape one CSV field per RFC 4180.
 *   - wrap in double quotes
 *   - double-up any embedded double quotes
 *   - render null/undefined as empty string
 */
function escapeCsvField(value) {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV string from a 2D array.
 *   - `\ufeff` BOM ensures Excel opens UTF-8 correctly
 *   - CRLF line endings for maximum spreadsheet compatibility
 */
export function buildCsv(rows) {
  if (!Array.isArray(rows)) throw new TypeError('buildCsv: rows must be an array');
  const body = rows.map((row) => {
    if (!Array.isArray(row)) return escapeCsvField(row);
    return row.map(escapeCsvField).join(',');
  }).join('\r\n');
  return '\ufeff' + body;
}

/** Trigger a CSV download from a 2D array of rows. */
export function downloadCSV(filename, rows) {
  const csv = buildCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  return downloadBlob(blob, filename);
}

/** Trigger a JSON download (pretty-printed). */
export function downloadJSON(filename, data) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
  return downloadBlob(blob, filename);
}

export default { downloadBlob, downloadCSV, downloadJSON, buildCsv };
