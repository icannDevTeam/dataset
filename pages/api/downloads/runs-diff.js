/**
 * POST /api/downloads/runs-diff
 *
 * Compare two prior reportRuns of the same card (A = baseline, B = current).
 * Pulls the stored CSV artifacts from Storage, parses them, and emits a
 * unified diff (added / removed / changed) keyed by the first column.
 *
 * Body filters (required):
 *   { cardId, runIdA, runIdB }
 *
 * Reads:
 *   • tenants/{tid}/reportRuns/{runIdA}
 *   • tenants/{tid}/reportRuns/{runIdB}
 *   • gs://<bucket>/<storagePath>     (CSV artifacts for both runs)
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

// ── Minimal RFC4180-ish CSV parser ─────────────────────────────────────
// Handles quoted fields, embedded quotes ("") and newlines inside quotes.
// We don't need streaming — exported artifacts cap at MAX_ROWS (5000).
function parseCsv(text) {
  const out = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"')      { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else                 { field += ch; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); out.push(row); }
  return out;
}

function rowsToObjects(grid) {
  if (!grid || grid.length === 0) return { header: [], rows: [] };
  const header = grid[0].map((h) => String(h || '').trim());
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    if (r.length === 1 && r[0] === '') continue; // blank line
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] != null ? String(r[j]) : '';
    rows.push(obj);
  }
  return { header, rows };
}

async function loadRunCsv(db, bucket, tid, runId) {
  const ref = db.doc(`${tenancy.reportRunsPath(tid)}/${runId}`);
  const snap = await ref.get().catch(() => null);
  if (!snap || !snap.exists) return { error: `Run ${runId} not found` };
  const meta = snap.data() || {};
  const fmt = String(meta.format || '').toLowerCase();
  if (!meta.storagePath) return { meta, error: `Run ${runId} has no storagePath (was preview/dry-run?)` };
  if (fmt !== 'csv')      return { meta, error: `Run ${runId} stored format is ${fmt || 'unknown'}, only csv is replayable` };
  try {
    const file = bucket.file(meta.storagePath);
    const [buf] = await file.download();
    const { header, rows } = rowsToObjects(parseCsv(buf.toString('utf8')));
    return { meta, header, rows };
  } catch (err) {
    return { meta, error: `Download failed for ${runId}: ${err.message}` };
  }
}

function emptyDiff(notes) {
  return {
    rows: [{
      status: 'note',
      key:    '',
      changedFields: notes.join(' | '),
    }],
    meta: { notes, _emptyCols: true },
  };
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const bucket = getFirebaseStorage().bucket();
  const tid = ctx.tenantId || tenancy.getTenantId();

  const cardId  = String(ctx.filters?.cardId  || '').trim();
  const runIdA  = String(ctx.filters?.runIdA  || '').trim();
  const runIdB  = String(ctx.filters?.runIdB  || '').trim();
  if (!cardId || !runIdA || !runIdB) {
    return emptyDiff(['Required filters missing: cardId, runIdA, runIdB']);
  }
  if (runIdA === runIdB) {
    return emptyDiff(['runIdA and runIdB are identical — nothing to diff']);
  }

  const [A, B] = await Promise.all([
    loadRunCsv(db, bucket, tid, runIdA),
    loadRunCsv(db, bucket, tid, runIdB),
  ]);

  // Card mismatch guard — both runs must belong to the requested cardId.
  const errs = [];
  if (A.error) errs.push(`A: ${A.error}`);
  if (B.error) errs.push(`B: ${B.error}`);
  if (A.meta && A.meta.cardId && A.meta.cardId !== cardId) {
    errs.push(`A: cardId mismatch (got ${A.meta.cardId})`);
  }
  if (B.meta && B.meta.cardId && B.meta.cardId !== cardId) {
    errs.push(`B: cardId mismatch (got ${B.meta.cardId})`);
  }
  if (errs.length > 0) return emptyDiff(errs);

  // Heuristic key: first header field present in both. If they differ,
  // we fall back to A's first header but warn in notes.
  const headerA = A.header || [];
  const headerB = B.header || [];
  if (headerA.length === 0 || headerB.length === 0) {
    return emptyDiff(['One of the runs has an empty header row']);
  }
  const keyField = headerA[0];
  const notes = [
    `Row key = first column "${keyField}" (heuristic).`,
    `A: ${runIdA} (${A.rows.length} rows)  vs  B: ${runIdB} (${B.rows.length} rows).`,
  ];
  if (headerA[0] !== headerB[0]) {
    notes.push(`WARNING: A's first column is "${headerA[0]}" but B's is "${headerB[0]}" — diff may be unreliable.`);
  }

  // Union of all columns, preserving A's order then appending new B-only.
  const colOrder = headerA.slice();
  for (const h of headerB) if (!colOrder.includes(h)) colOrder.push(h);

  const indexA = new Map();
  for (const r of A.rows) {
    const k = r[keyField] || '';
    if (!indexA.has(k)) indexA.set(k, r);
  }
  const indexB = new Map();
  for (const r of B.rows) {
    const k = r[keyField] || '';
    if (!indexB.has(k)) indexB.set(k, r);
  }

  let added = 0, removed = 0, changed = 0;
  const out = [];

  const allKeys = new Set([...indexA.keys(), ...indexB.keys()]);
  for (const k of allKeys) {
    const a = indexA.get(k);
    const b = indexB.get(k);
    if (a && !b) {
      removed++;
      out.push({ status: 'removed', key: k, dataSource: 'A', _src: a, changedFields: '' });
    } else if (b && !a) {
      added++;
      out.push({ status: 'added', key: k, dataSource: 'B', _src: b, changedFields: '' });
    } else if (a && b) {
      const diffs = [];
      for (const c of colOrder) {
        const av = a[c] != null ? a[c] : '';
        const bv = b[c] != null ? b[c] : '';
        if (av !== bv) diffs.push(c);
      }
      if (diffs.length === 0) continue; // identical row — skip
      changed++;
      // Show B's values for changed rows (current state).
      out.push({ status: 'changed', key: k, dataSource: 'both', _src: b, changedFields: diffs.join(', ') });
    }
  }

  // Flatten _src into top-level columns matching colOrder ids.
  const rows = out.map((r) => {
    const o = {
      status:        r.status,
      key:           r.key,
      changedFields: r.changedFields,
      dataSource:    r.dataSource,
    };
    for (const c of colOrder) o[c] = (r._src && r._src[c] != null) ? r._src[c] : '';
    return o;
  });

  rows.sort((x, y) => {
    const rank = { added: 0, changed: 1, removed: 2, note: 3 };
    const ra = rank[x.status] ?? 9, rb = rank[y.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(x.key).localeCompare(String(y.key));
  });

  notes.push(`Added: ${added}, Removed: ${removed}, Changed: ${changed}.`);

  return {
    rows,
    meta: {
      notes,
      _diffCounts: { added, removed, changed },
      _dynamicCols: colOrder,
    },
  };
}

// Columns are partially dynamic — we compute them at request time from
// the union of A/B headers. The runDownload contract wants a static
// columns[]; we shim by reading a hint placed on the request by the
// fetcher. Implementation: do a small wrapper that swaps columns just
// before runDownload renders.
//
// Simpler approach: keep the columns list to the fixed framing
// (status/key/changedFields/dataSource). Original column values get
// emitted under their own header names — we pre-stringify into a single
// "details" column to keep the static-column contract intact.
function kpis(rows) {
  let added = 0, removed = 0, changed = 0;
  for (const r of rows) {
    if (r.status === 'added')   added++;
    if (r.status === 'removed') removed++;
    if (r.status === 'changed') changed++;
  }
  return [
    ['Added',   added.toLocaleString()],
    ['Removed', removed.toLocaleString()],
    ['Changed', changed.toLocaleString()],
  ];
}

// We collapse all extra row columns into a single "details" column so the
// downstream renderer (CSV / XLSX) sees a stable shape. The "changedFields"
// column lets readers spot which fields moved without scanning the JSON.
const FIXED_COLUMNS = [
  { id: 'status',        label: 'Status',         width: 9,
    format: (v) => v || '' },
  { id: 'key',           label: 'Key',            width: 20,
    format: (v) => v || '' },
  { id: 'changedFields', label: 'Changed Fields', width: 30,
    format: (v) => v || '' },
  { id: 'dataSource',    label: 'Data Source',    width: 10,
    format: (v) => v || '' },
  { id: '_details',      label: 'Details (JSON)', width: 60,
    format: (_v, row) => {
      if (!row) return '';
      const o = {};
      for (const [k, val] of Object.entries(row)) {
        if (['status', 'key', 'changedFields', 'dataSource'].includes(k)) continue;
        if (k.startsWith('_')) continue;
        o[k] = val;
      }
      try { return JSON.stringify(o); } catch { return ''; }
    },
  },
];

export default withApi(runDownload({
  cardId: 'runs-diff',
  title: 'Diff Between Report Runs',
  subtitle: 'Row-level added / removed / changed between two prior runs',
  theme: 'indigo',
  sheetName: 'Run Diff',
  needsRange: false,
  snapshotLabel: 'Diff snapshot',
  maxDays: 365,
  columns: FIXED_COLUMNS,
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_compliance', rateLimit: 30 });
