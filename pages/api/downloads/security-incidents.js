/**
 * POST /api/downloads/security-incidents
 * Spoofing detections + liveness failures from
 * `tenants/{tid}/security_incidents`.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(ctx.from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(ctx.to   + 'T23:59:59+07:00').getTime();

  const snap = await db.collection(tenancy.securityIncidentsPath(tid))
    .orderBy('timestamp', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const r = d.data() || {};
      const tsRaw = r.timestamp?.toDate ? r.timestamp.toDate().toISOString()
        : (typeof r.timestamp === 'string' ? r.timestamp : null);
      if (!tsRaw) return;
      const ms = Date.parse(tsRaw);
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;
      const type = String(r.type || r.kind || 'unknown');
      const subject = r.student || r.chaperone || r.target || '\u2014';
      const subjectName = typeof subject === 'string' ? subject : (subject.name || subject.id || '\u2014');
      const subjectKey  = typeof subject === 'string' ? subject : (subject.id || subject.name || '\u2014');
      rows.push({
        timestamp:  tsRaw.slice(0, 19).replace('T', ' '),
        type,
        subject:    subjectName,
        source:     r.gate || r.terminalId || r.source || '\u2014',
        confidence: r.confidence != null ? Number(r.confidence).toFixed(2) : '',
        liveness:   r.livenessScore != null ? Number(r.livenessScore).toFixed(2) : '',
        photoPath:  r.photoPath || r.photo_path || r.image || '',
        notes:      r.notes || r.summary || '',
        _subjectKey: subjectKey,
      });
    });
  }
  return { rows, meta: { truncated, notes: [
    'Photos referenced in "Photo Path" are stored in Firebase Storage.',
    'For incidents older than 90 days, narrow the date range to retrieve archived records.',
  ] } };
}

function kpis(rows, ctx) {
  let spoof = 0, liveness = 0, lowConf = 0;
  const subjectSet = new Set();
  for (const r of rows) {
    if (/spoof/i.test(r.type)) spoof++;
    else if (/liveness/i.test(r.type)) liveness++;
    else if (/low.?conf/i.test(r.type)) lowConf++;
    subjectSet.add(r._subjectKey);
  }
  return [
    ['Total incidents',   rows.length.toLocaleString()],
    ['Spoof attempts',    spoof.toLocaleString()],
    ['Liveness failures', liveness.toLocaleString()],
    ['Low-confidence',    lowConf.toLocaleString()],
    ['Subjects affected', subjectSet.size.toLocaleString()],
    ['Days covered',      ctx.days],
  ];
}

export default withApi(runDownload({
  cardId: 'security-incidents',
  title: 'Security Incidents Report',
  subtitle: 'Spoofing detections, liveness failures & low-confidence events',
  theme: 'teal',
  sheetName: 'Incidents',
  maxDays: 365,
  columns: [
    { id: 'timestamp',  label: 'Timestamp',  width: 13 },
    { id: 'type',       label: 'Type',       width: 10 },
    { id: 'subject',    label: 'Subject',    width: 18 },
    { id: 'source',     label: 'Source',     width: 10 },
    { id: 'confidence', label: 'Confidence', width: 8 },
    { id: 'liveness',   label: 'Liveness',   width: 8 },
    { id: 'photoPath',  label: 'Photo Path', width: 18 },
    { id: 'notes',      label: 'Notes',      width: 15 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_security', rateLimit: 30 });
