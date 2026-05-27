/**
 * POST /api/downloads/consent-audit
 *
 * Audit of every parent/guardian consent acceptance in the range, joined
 * with the policy_versions doc that was accepted.
 *
 * Reads:
 *   • tenants/{tid}/consents          (consentedAt / signedAt / acceptedAt)
 *   • tenants/{tid}/policy_versions   (versionId, effectiveDate)
 *   • tenants/{tid}/students  (best-effort subject name resolution)
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
  if (typeof v?.toDate === 'function') {
    try { return v.toDate().toISOString(); } catch { return ''; }
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

function pickAcceptedAt(r) {
  // Discovered field is `consentedAt` (consent/record.js). Spec also
  // mentions acceptedAt / signedAt / createdAt — accept any.
  return toIso(r.consentedAt || r.acceptedAt || r.signedAt || r.createdAt);
}

function classifyChannel(r) {
  const c = String(r.channel || r.source || r.via || '').toLowerCase();
  if (c) return c;
  const ua = String(r.userAgent || '').toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'tablet';
  if (/kiosk/.test(ua))       return 'kiosk';
  return 'web';
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(`${ctx.from}T00:00:00+07:00`).getTime();
  const toMs   = new Date(`${ctx.to}T23:59:59+07:00`).getTime();

  // Load policy_versions once → versionId -> { effectiveDate, label }.
  const polMap = new Map();
  try {
    const polSnap = await db.collection(tenancy.policyVersionsPath(tid)).get();
    polSnap.forEach((d) => {
      const p = d.data() || {};
      polMap.set(d.id, {
        versionId:      p.versionId || d.id,
        effectiveDate:  p.effectiveDate || p.effectiveAt || p.createdAt || '',
      });
    });
  } catch {}

  // Walk consents — schema is `${tid}/consents/{studentId}` per record.js.
  // We can't safely range-query on consentedAt without a guaranteed index,
  // so pull and filter in code with MAX_ROWS+1 cap.
  const cSnap = await db.collection(tenancy.consentsPath(tid))
    .limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;

  // Build subject-name cache lazily (one batched read after we know the IDs).
  const subjectIds = new Set();
  const stage = []; // pre-filtered records before name resolution
  if (cSnap) {
    cSnap.forEach((d) => {
      const r = d.data() || {};
      const acceptedIso = pickAcceptedAt(r);
      const ms = acceptedIso ? Date.parse(acceptedIso) : NaN;
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;
      const sid = r.studentId || d.id;
      const subjectType = r.subjectType || (sid ? 'student' : 'unknown');
      stage.push({ r, sid, subjectType, acceptedIso });
      if (sid) subjectIds.add(String(sid));
    });
  }

  // Resolve subject names (students collection, falling back to legacy).
  const nameById = new Map();
  if (subjectIds.size > 0) {
    try {
      // Firestore `in` queries cap at 30 — chunk it.
      const ids = Array.from(subjectIds);
      const coll = db.collection(tenancy.studentsPath(tid));
      for (let i = 0; i < ids.length; i += 30) {
        const chunk = ids.slice(i, i + 30);
        const snap = await coll.where(admin.firestore.FieldPath.documentId(), 'in', chunk)
          .get().catch(() => null);
        if (snap) snap.forEach((d) => {
          const s = d.data() || {};
          nameById.set(d.id, s.name || s.fullName || '');
        });
      }
    } catch {}
    // Legacy fallback for any unresolved.
    const missing = Array.from(subjectIds).filter((id) => !nameById.has(id));
    if (missing.length > 0) {
      try {
        const coll = db.collection('student_metadata');
        for (let i = 0; i < missing.length; i += 30) {
          const chunk = missing.slice(i, i + 30);
          const snap = await coll.where(admin.firestore.FieldPath.documentId(), 'in', chunk)
            .get().catch(() => null);
          if (snap) snap.forEach((d) => {
            const s = d.data() || {};
            nameById.set(d.id, s.name || '');
          });
        }
      } catch {}
    }
  }

  for (const item of stage) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const { r, sid, subjectType, acceptedIso } = item;
    const pol = polMap.get(r.policyVersionId) || {};
    rows.push({
      subjectType,
      subjectId:           sid || '',
      subjectName:         r.guardianName || nameById.get(String(sid)) || '',
      policyVersion:       r.policyVersionId || pol.versionId || '',
      policyEffectiveAt:   (pol.effectiveDate || '').toString().slice(0, 10),
      acceptedAt:          acceptedIso.slice(0, 19).replace('T', ' '),
      ip:                  r.ipAddress || r.ip || '',
      channel:             classifyChannel(r),
    });
  }
  rows.sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : a.acceptedAt > b.acceptedAt ? -1 : 0));

  return { rows, meta: { truncated, notes: [
    'Subject name shows the guardian who signed; if absent, falls back to the student name.',
    'Channel is inferred from the consent record (or user-agent) when not explicit.',
  ] } };
}

function kpis(rows) {
  const versions = new Set(), subjects = new Set();
  for (const r of rows) {
    if (r.policyVersion) versions.add(r.policyVersion);
    if (r.subjectId)     subjects.add(r.subjectId);
  }
  return [
    ['Total accepted in range',  rows.length.toLocaleString()],
    ['Distinct policy versions', versions.size.toLocaleString()],
    ['Distinct subjects',        subjects.size.toLocaleString()],
  ];
}

export default withApi(runDownload({
  cardId: 'consent-audit',
  title: 'Consent / Policy Version Audit',
  subtitle: 'Who accepted which policy version, when, from where',
  theme: 'indigo',
  sheetName: 'Consent Audit',
  maxDays: 365,
  columns: [
    { id: 'subjectType',       label: 'Subject Type',     width: 10 },
    { id: 'subjectId',         label: 'Subject ID',       width: 12 },
    { id: 'subjectName',       label: 'Subject Name',     width: 22 },
    { id: 'policyVersion',     label: 'Policy Version',   width: 16 },
    { id: 'policyEffectiveAt', label: 'Policy Effective', width: 12 },
    { id: 'acceptedAt',        label: 'Accepted At',      width: 19 },
    { id: 'ip',                label: 'IP',               width: 14 },
    { id: 'channel',           label: 'Channel',          width: 8 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_compliance', rateLimit: 30 });
