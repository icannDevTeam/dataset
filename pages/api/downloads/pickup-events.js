/**
 * POST /api/downloads/pickup-events
 *
 * Pickup event ledger — every release event recorded by gate officers /
 * FR matchers in `tenants/{tid}/pickup_events`.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function toIso(v) {
  if (!v) return '';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

function formatWib(iso) {
  if (!iso) return '\u2014';
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch { return '\u2014'; }
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(`${ctx.from}T00:00:00.000+07:00`).getTime();
  const toMs   = new Date(`${ctx.to}T23:59:59.999+07:00`).getTime();
  const classFilter = ctx.filters?.class ? String(ctx.filters.class).toLowerCase() : null;

  // pickup_events docs use recordedAt/scannedAt (see backend/
  // pickup_event_writer.py) — orderBy on a missing field silently
  // returns zero docs in Firestore.
  const snap = await db.collection(tenancy.pickupEventsPath(tid))
    .orderBy('recordedAt', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const e = d.data() || {};
      const createdIso = toIso(e.teacherRelease?.at || e.recordedAt || e.scannedAt || e.createdAt || e.ts || e.timestamp);
      const createdMs = createdIso ? new Date(createdIso).getTime() : 0;
      if (createdMs && (createdMs < fromMs || createdMs > toMs)) return;
      // Real schema nests these: chaperone{name,relation}, students[],
      // fr{confidence} — flat fields kept as fallback for legacy docs.
      const chap = (e.chaperone && typeof e.chaperone === 'object') ? e.chaperone : {};
      const studs = Array.isArray(e.students) ? e.students : [];
      const cls = studs.map((s) => s?.homeroom).filter(Boolean).join(', ')
        || (e.studentHomeroom || e.studentClass || '').toString();
      if (classFilter && cls.toLowerCase() !== classFilter) return;
      const isOverride = !!e.officerOverride || !!e.overrideCode;
      const method = String(e.method || e.matchMethod || (isOverride ? 'override' : 'fr')).toLowerCase();
      const gate = e.releaseGroupName || e.gate || e.deviceName || e.terminal || e.terminalId || '\u2014';
      const frConf = (e.fr && typeof e.fr.confidence === 'number') ? e.fr.confidence
        : (typeof e.confidence === 'number' ? e.confidence : null);
      rows.push({
        time:        formatWib(createdIso),
        student:     studs.map((s) => s?.name).filter(Boolean).join(', ') || e.studentName || '\u2014',
        binusId:     studs.map((s) => s?.binusId || s?.id).filter(Boolean).join(', ') || e.studentBinusId || e.studentId || '',
        class:       cls,
        chaperone:   chap.name || e.chaperoneName || '\u2014',
        relation:    chap.relation || e.chaperoneRelation || '',
        gate,
        method,
        confidence:  frConf != null ? `${(frConf * 100).toFixed(1)}%` : '',
        officer:     e.officerOverride?.by || e.officerOverride?.email || e.officer || e.releasedBy
          || e.teacherRelease?.displayName || e.teacherRelease?.by || '',
        notes:       e.decision && e.decision !== 'ok' ? e.decision : (e.notes || ''),
      });
    });
  }
  return { rows, meta: { truncated, notes: classFilter ? [`Filtered by class: ${classFilter.toUpperCase()}`] : [] } };
}

function kpis(rows) {
  let viaFr = 0, viaOverride = 0, viaManual = 0;
  const byGate = new Map();
  for (const r of rows) {
    if (r.method.includes('override')) viaOverride++;
    else if (r.method.includes('manual')) viaManual++;
    else viaFr++;
    byGate.set(r.gate, (byGate.get(r.gate) || 0) + 1);
  }
  const gateBreakdown = Array.from(byGate.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => [`Gate \u00b7 ${k}`, String(v)]);
  return [
    ['Total releases',   rows.length.toLocaleString()],
    ['Face match',       viaFr.toLocaleString()],
    ['Officer override', viaOverride.toLocaleString()],
    ['Manual',           viaManual.toLocaleString()],
    ['FR success rate',  rows.length ? `${((viaFr / rows.length) * 100).toFixed(1)}%` : '\u2014'],
    ...gateBreakdown,
  ];
}

export default withApi(runDownload({
  cardId: 'pickup-events',
  title: 'Pickup Events Report',
  subtitle: 'Every student release at the gate \u2014 chaperone, method, officer.',
  theme: 'orange',
  sheetName: 'Pickup Events',
  maxDays: 365,
  columns: [
    { id: 'time',       label: 'Time',        width: 17 },
    { id: 'student',    label: 'Student',     width: 16 },
    { id: 'binusId',    label: 'Binusian ID', width: 12 },
    { id: 'class',      label: 'Class',       width: 7 },
    { id: 'chaperone',  label: 'Chaperone',   width: 16 },
    { id: 'relation',   label: 'Relation',    width: 9 },
    { id: 'gate',       label: 'Gate',        width: 9 },
    { id: 'method',     label: 'Method',      width: 9 },
    { id: 'confidence', label: 'Confidence',  width: 9 },
    { id: 'officer',    label: 'Officer',     width: 12 },
    { id: 'notes',      label: 'Notes',       width: 14 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
