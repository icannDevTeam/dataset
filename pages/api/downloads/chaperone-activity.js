/**
 * POST /api/downloads/chaperone-activity
 *
 * Per-chaperone activity report across a date range:
 *   • pickup count, last pickup, distinct students
 *   • late count (pickups after declared cutoff, blank if no cutoff)
 *   • incident count (security_incidents referencing the chaperone)
 *
 * Reads:
 *   • tenants/{tid}/chaperones                       (roster — all)
 *   • tenants/{tid}/pickup_events  where createdAt   (in range)
 *   • tenants/{tid}/security_incidents               (filter in code)
 *   • tenants/{tid}/settings/pickup                  (declared cutoff)
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
  if (typeof v.toDate === 'function') {
    try { return v.toDate().toISOString(); } catch { return ''; }
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

function parseCutoffHHmm(s) {
  // Returns minutes-since-midnight, or null.
  if (!s || typeof s !== 'string') return null;
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23) return null;
  return h * 60 + mm;
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(`${ctx.from}T00:00:00.000Z`).getTime();
  const toMs   = new Date(`${ctx.to}T23:59:59.999Z`).getTime();

  // Cutoff for "late pickup" — pickup settings may store it under any of
  // these keys. If none present, late count is blank per spec.
  let cutoffMins = null;
  try {
    const cfg = await db.doc(tenancy.pickupSettingsDoc(tid)).get();
    if (cfg.exists) {
      const c = cfg.data() || {};
      cutoffMins = parseCutoffHHmm(c.pickupCutoffHHmm || c.cutoffHHmm || c.lateCutoffHHmm);
    }
  } catch {}

  // Load chaperones roster.
  const chapSnap = await db.collection(tenancy.chaperonesPath(tid))
    .limit(MAX_ROWS + 1).get().catch(() => null);
  const chapById = new Map();
  const chapByEmpNo = new Map();
  if (chapSnap) {
    chapSnap.forEach((d) => {
      const r = d.data() || {};
      const entry = {
        id: d.id,
        name: r.name || d.id,
        phone: r.phone || '',
        employeeNo: r.employeeNo || '',
      };
      chapById.set(d.id, entry);
      if (entry.employeeNo) chapByEmpNo.set(entry.employeeNo, entry);
    });
  }

  // Pickup events in range. We orderBy createdAt desc and filter range
  // in code (pickup-events.js follows the same pattern — Firestore range
  // queries on createdAt aren't guaranteed indexed in this collection).
  const peSnap = await db.collection(tenancy.pickupEventsPath(tid))
    .orderBy('createdAt', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);

  // chaperoneId -> { pickupCount, lastPickup, students:Set, lateCount }
  const agg = new Map();
  const ensure = (id) => {
    if (!agg.has(id)) {
      agg.set(id, { pickupCount: 0, lastPickup: '', students: new Set(), lateCount: 0 });
    }
    return agg.get(id);
  };

  let truncated = false;
  if (peSnap) {
    peSnap.forEach((d) => {
      const e = d.data() || {};
      const createdIso = toIso(e.createdAt || e.recordedAt || e.scannedAt || e.ts || e.timestamp);
      const ms = createdIso ? Date.parse(createdIso) : NaN;
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;

      const chap = e.chaperone || {};
      const cid = (typeof chap === 'object' ? chap.id : null) || e.chaperoneId || null;
      if (!cid) return; // unknown chaperone events have no id to attribute

      // Auto-register chaperones seen in events but absent from roster.
      if (!chapById.has(cid)) {
        chapById.set(cid, {
          id: cid,
          name: (typeof chap === 'object' ? (chap.name || cid) : cid),
          phone: (typeof chap === 'object' ? (chap.phone || '') : ''),
          employeeNo: e.employeeNo || '',
        });
      }

      const a = ensure(cid);
      a.pickupCount++;
      if (!a.lastPickup || createdIso > a.lastPickup) a.lastPickup = createdIso;

      const students = Array.isArray(e.students) ? e.students : [];
      for (const s of students) {
        const sid = (s && typeof s === 'object') ? (s.id || s.binusId || s.name) : s;
        if (sid) a.students.add(String(sid));
      }

      // Late pickup: createdAt time-of-day past cutoff (WIB).
      if (cutoffMins != null) {
        const wib = new Date(ms + 7 * 3600 * 1000);
        const minsOfDay = wib.getUTCHours() * 60 + wib.getUTCMinutes();
        if (minsOfDay > cutoffMins) a.lateCount++;
      }
    });
  }

  // Incidents — match by chaperoneId, fallback to employeeNo or name.
  // security_incidents schema varies (object/string subject + chaperoneName
  // + employeeNo); we walk and bin into the right chaperone.
  const incCount = new Map();
  const incSnap = await db.collection(tenancy.securityIncidentsPath(tid))
    .orderBy('timestamp', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);
  if (incSnap) {
    incSnap.forEach((d) => {
      const r = d.data() || {};
      const tsRaw = toIso(r.timestamp || r.createdAt);
      const ms = tsRaw ? Date.parse(tsRaw) : NaN;
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;
      let cid = null;
      if (r.chaperone && typeof r.chaperone === 'object') cid = r.chaperone.id || null;
      if (!cid && r.chaperoneId) cid = r.chaperoneId;
      if (!cid && r.employeeNo && chapByEmpNo.has(r.employeeNo)) {
        cid = chapByEmpNo.get(r.employeeNo).id;
      }
      if (!cid && r.chaperoneName) {
        for (const c of chapById.values()) {
          if (c.name && c.name === r.chaperoneName) { cid = c.id; break; }
        }
      }
      if (!cid) return;
      incCount.set(cid, (incCount.get(cid) || 0) + 1);
    });
  }

  // Build output rows — only chaperones with activity in the range.
  const rows = [];
  for (const [cid, a] of agg.entries()) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const c = chapById.get(cid) || { id: cid, name: cid, phone: '', employeeNo: '' };
    rows.push({
      chaperoneId:      cid,
      name:             c.name,
      phone:            c.phone,
      employeeNo:       c.employeeNo,
      pickupCount:      a.pickupCount,
      lastPickup:       a.lastPickup ? a.lastPickup.slice(0, 19).replace('T', ' ') : '',
      distinctStudents: a.students.size,
      lateCount:        cutoffMins == null ? '' : a.lateCount,
      incidentCount:    incCount.get(cid) || 0,
    });
  }
  rows.sort((x, y) => (y.pickupCount - x.pickupCount) || x.name.localeCompare(y.name));

  const notes = [];
  if (cutoffMins == null) {
    notes.push('Late count blank — no declared pickup cutoff at settings/pickup.');
  } else {
    const hh = String(Math.floor(cutoffMins / 60)).padStart(2, '0');
    const mm = String(cutoffMins % 60).padStart(2, '0');
    notes.push(`Late = pickup recorded after ${hh}:${mm} WIB.`);
  }
  return { rows, meta: { truncated, notes } };
}

function kpis(rows) {
  const active = rows.length;
  let total = 0;
  for (const r of rows) total += Number(r.pickupCount || 0);
  return [
    ['Active chaperones',     active.toLocaleString()],
    ['Total pickups',         total.toLocaleString()],
    ['Avg pickups / chaperone', active ? (total / active).toFixed(1) : '0'],
  ];
}

export default withApi(runDownload({
  cardId: 'chaperone-activity',
  title: 'Chaperone Activity Report',
  subtitle: 'Per-chaperone pickup volume, last pickup, incidents',
  theme: 'indigo',
  sheetName: 'Chaperone Activity',
  maxDays: 365,
  columns: [
    { id: 'chaperoneId',      label: 'Chaperone ID',      width: 14 },
    { id: 'name',             label: 'Name',              width: 22 },
    { id: 'phone',            label: 'Phone',             width: 15 },
    { id: 'employeeNo',       label: 'EmployeeNo',        width: 10 },
    { id: 'pickupCount',      label: 'Pickups',           width: 8 },
    { id: 'lastPickup',       label: 'Last Pickup',       width: 19 },
    { id: 'distinctStudents', label: 'Distinct Students', width: 10 },
    { id: 'lateCount',        label: 'Late Pickups',      width: 10 },
    { id: 'incidentCount',    label: 'Incidents',         width: 9 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_compliance', rateLimit: 30 });
