/**
 * /v2/admin/downloads
 *
 * The Downloads Hub — one-stop compliance/operations export desk.
 * Wires branded report endpoints behind a uniform date-range +
 * format picker UI. Access is gated by the `downloads` feature in
 * lib/permissions.js (owner + admin by default).
 *
 * ───────────────────────────────────────────────────────────────────
 * Deep-link contract: `/v2/admin/downloads?card=<id>`
 *
 * Other V2 admin pages (analytics, reports, …) ship a "Preview report"
 * button that opens the preview modal then hands the user off here to
 * configure the actual export. They pass the matching card `id` so we
 * can scroll-to + highlight that card on mount.
 *
 * Valid `card` ids (must stay in sync with the SECTIONS array below):
 *   attendance · chaperone-roster · pickup-events · onboarding-forms
 *   students-roster · terminals · system-health · security-incidents
 *   access-logs · audit-log
 * ───────────────────────────────────────────────────────────────────
 */
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import AdminLayout from '../../../components/v2/AdminLayout';
import ReauthModal from '../../../components/v2/ReauthModal';
import { useAuth } from '../../../lib/AuthContext';

// ── Timezone-aware date helpers ──────────────────────────────────────
// All M3 date computations (presets, default range, default `from`/`to`)
// route through `dateInTz` so changing the hub timezone re-anchors the
// whole UI. The backend itself still operates in WIB — TZ is purely a
// presentation concern: "today in Tokyo" just picks a different YYYY-MM-DD.
const TIMEZONES = [
  { id: 'Asia/Jakarta',         label: 'Asia/Jakarta (WIB · default)' },
  { id: 'UTC',                  label: 'UTC' },
  { id: 'Asia/Singapore',       label: 'Asia/Singapore' },
  { id: 'Asia/Tokyo',           label: 'Asia/Tokyo' },
  { id: 'Europe/London',        label: 'Europe/London' },
  { id: 'America/Los_Angeles',  label: 'America/Los_Angeles' },
  { id: 'America/New_York',     label: 'America/New_York' },
];
const ALLOWED_TZ = new Set(TIMEZONES.map((t) => t.id));

function dateInTz(tz, offsetDays = 0) {
  try {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value || '1970';
    const m = parts.find((p) => p.type === 'month')?.value || '01';
    const da = parts.find((p) => p.type === 'day')?.value || '01';
    return `${y}-${m}-${da}`;
  } catch {
    // Fallback to WIB if Intl rejects the zone.
    const d = new Date(Date.now() + 7 * 3600 * 1000);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }
}
const today  = (tz = 'Asia/Jakarta') => dateInTz(tz, 0);
const daysAgo = (n, tz = 'Asia/Jakarta') => dateInTz(tz, -n);

// Built-in date-range presets. Each returns {from, to} in the user's TZ.
// `Custom` is rendered as a sentinel — selecting it just reveals the
// existing date pickers without overwriting their current values.
const RANGE_PRESETS = [
  { id: 'today',     label: 'Today',         range: (tz) => ({ from: today(tz), to: today(tz) }) },
  { id: 'yesterday', label: 'Yesterday',     range: (tz) => ({ from: daysAgo(1, tz), to: daysAgo(1, tz) }) },
  { id: 'week',      label: 'This week',     range: (tz) => {
      // ISO week: Monday → today. Compute via JS Date in TZ-day terms.
      const todayStr = today(tz);
      const d = new Date(todayStr + 'T00:00:00Z');
      const dow = d.getUTCDay();          // 0 Sun … 6 Sat
      const back = dow === 0 ? 6 : dow - 1; // back to Monday
      return { from: daysAgo(back, tz), to: todayStr };
    } },
  { id: 'last7',     label: 'Last 7 days',   range: (tz) => ({ from: daysAgo(6, tz),  to: today(tz) }) },
  { id: 'month',     label: 'This month',    range: (tz) => {
      const todayStr = today(tz);
      return { from: todayStr.slice(0, 8) + '01', to: todayStr };
    } },
  { id: 'last90',    label: 'Last term (90 days)', range: (tz) => ({ from: daysAgo(89, tz), to: today(tz) }) },
  { id: 'custom',    label: 'Custom',        range: null },
];

const SECTIONS = [
  {
    heading: 'Operational',
    description: 'Day-to-day attendance & pickup records.',
    cards: [
      {
        id: 'attendance',
        endpoint: '/api/downloads/attendance',
        icon: 'ph-identification-badge',
        title: 'Attendance Report',
        blurb: 'Every facial-recognition scan, on-time vs late, by date range.',
        tone: 'teal',
        needsRange: true,
        filters: ['class', 'status'],
        permission: 'download_operational',
        tags: ['attendance', 'operations', 'daily'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'chaperone-roster',
        endpoint: '/api/downloads/chaperone-roster',
        icon: 'ph-users-three',
        title: 'Chaperone Roster',
        blurb: 'Full directory of registered pickup chaperones / guardians.',
        tone: 'green',
        needsRange: false,
        permission: 'download_compliance',
        tags: ['pickup', 'directory'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'pickup-events',
        endpoint: '/api/downloads/pickup-events',
        icon: 'ph-hand-waving',
        title: 'Pickup Events Report',
        blurb: 'Every student release at the gate — chaperone, method, officer.',
        tone: 'orange',
        needsRange: true,
        filters: ['class'],
        permission: 'download_operational',
        tags: ['pickup', 'operations', 'daily'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'onboarding-forms',
        endpoint: '/api/downloads/onboarding-forms',
        icon: 'ph-clipboard-text',
        title: 'Onboarding Forms',
        blurb: 'Parent-submitted onboarding forms — status, chaperones, students.',
        tone: 'green',
        needsRange: true,
        filters: ['formStatus'],
        permission: 'download_directory',
        tags: ['pickup', 'directory', 'compliance'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'daily-brief',
        endpoint: '/api/downloads/daily-brief',
        icon: 'ph-newspaper',
        title: 'Daily Operations Brief',
        blurb: 'One-page brief: attendance, late, no-shows, uptime, pickups, exceptions.',
        tone: 'indigo',
        needsRange: true,
        permission: 'download_operational',
        tags: ['daily', 'summary', 'pdf'],
        formats: ['pdf', 'csv', 'xlsx'],
      },
      {
        id: 'late-absence-trend',
        endpoint: '/api/downloads/late-absence-trend',
        icon: 'ph-trend-up',
        title: 'Late & Absence Trend',
        blurb: 'Weekly streaks and escalation flags per student.',
        tone: 'orange',
        needsRange: true,
        permission: 'download_operational',
        tags: ['attendance', 'trend'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'device-sync',
        endpoint: '/api/downloads/device-sync',
        icon: 'ph-broadcast',
        title: 'Device Sync Report',
        blurb: 'Per-terminal snapshot: enrolled count, last sync, drift, status.',
        tone: 'sky',
        needsRange: false,
        permission: 'download_operational',
        tags: ['devices', 'snapshot'],
        formats: ['csv', 'xlsx'],
      },
    ],
  },
  {
    heading: 'Directory & Devices',
    description: 'Master rosters of students and terminal hardware.',
    cards: [
      {
        id: 'students-roster',
        endpoint: '/api/downloads/students-roster',
        icon: 'ph-graduation-cap',
        title: 'Student Body Roster',
        blurb: 'Every registered student — Binusian ID, class, parent contacts.',
        tone: 'sky',
        needsRange: false,
        anyPermission: ['download_operational', 'download_directory'],
        tags: ['directory', 'students'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'terminals',
        endpoint: '/api/downloads/terminals',
        icon: 'ph-device-tablet',
        title: 'Terminals & Devices',
        blurb: 'All face terminals & gate devices with online / heartbeat status.',
        tone: 'indigo',
        needsRange: false,
        permission: 'download_operational',
        tags: ['devices', 'infrastructure'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'system-health',
        endpoint: '/api/downloads/system-health',
        icon: 'ph-heartbeat',
        title: 'System Health Snapshot',
        blurb: 'Live terminal status + today’s attendance + 24h pickup volume.',
        tone: 'red',
        needsRange: false,
        permission: 'download_operational',
        tags: ['devices', 'operations', 'health'],
        formats: ['csv', 'xlsx'],
      },
    ],
  },
  {
    heading: 'Security & Compliance',
    description: 'High-trust exports — audit log, access log, incidents.',
    cards: [
      {
        id: 'security-incidents',
        endpoint: '/api/downloads/security-incidents',
        icon: 'ph-shield-warning',
        title: 'Security Incidents',
        blurb: 'Spoof attempts, liveness failures and low-confidence events.',
        tone: 'red',
        needsRange: true,
        permission: 'download_security',
        tags: ['security', 'incidents'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'access-logs',
        endpoint: '/api/downloads/access-logs',
        icon: 'ph-sign-in',
        title: 'Dashboard Access Log',
        blurb: 'Every sign-in to the admin console — user, IP, device, time.',
        tone: 'sky',
        needsRange: true,
        permission: 'download_security',
        tags: ['security', 'audit'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'audit-log',
        endpoint: '/api/downloads/audit-log',
        icon: 'ph-clipboard-text',
        title: 'System Audit Log',
        blurb: 'Standalone copy of every mutating action across the system.',
        tone: 'indigo',
        needsRange: true,
        filters: ['auditKind'],
        permission: 'download_compliance',
        tags: ['compliance', 'security', 'audit'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'chaperone-audit',
        endpoint: '/api/downloads/chaperone-audit',
        icon: 'ph-user-list',
        title: 'Chaperone Audit Trail',
        blurb: 'Shadow-delete, restore and mutation history per chaperone.',
        tone: 'orange',
        needsRange: true,
        permission: 'download_compliance',
        tags: ['pickup', 'compliance', 'audit'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'audit-export',
        endpoint: '/api/downloads/audit-export',
        icon: 'ph-list-magnifying-glass',
        title: 'Audit Log Export',
        blurb: 'Compliance export of every mutating action — actor, role, target, summary.',
        tone: 'indigo',
        needsRange: true,
        filters: ['actionKind'],
        permission: 'download_compliance',
        tags: ['audit', 'compliance'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'unknown-faces',
        endpoint: '/api/downloads/unknown-faces',
        icon: 'ph-warning-octagon',
        title: 'Unknown Faces',
        blurb: 'Faces detected by terminals but not matched to any enrolled student.',
        tone: 'red',
        needsRange: true,
        permission: 'download_security',
        tags: ['security', 'incidents'],
        formats: ['csv', 'xlsx', 'pdf'],
      },
      {
        id: 'chaperone-activity',
        endpoint: '/api/downloads/chaperone-activity',
        icon: 'ph-users-three',
        title: 'Chaperone Activity Report',
        blurb: 'Per-chaperone pickup volume, last pickup, incidents.',
        tone: 'indigo',
        needsRange: true,
        permission: 'download_compliance',
        tags: ['chaperones', 'pickups'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'consent-audit',
        endpoint: '/api/downloads/consent-audit',
        icon: 'ph-file-text',
        title: 'Consent / Policy Version Audit',
        blurb: 'Who accepted which policy version, when, from where.',
        tone: 'indigo',
        needsRange: true,
        permission: 'download_compliance',
        tags: ['compliance', 'consent'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'runs-diff',
        endpoint: '/api/downloads/runs-diff',
        icon: 'ph-git-diff',
        title: 'Diff Between Two Report Runs',
        blurb: 'Added / removed / changed rows between any two prior runs of the same card.',
        tone: 'indigo',
        needsRange: false,
        permission: 'download_compliance',
        tags: ['diff', 'history'],
        formats: ['csv', 'xlsx'],
      },
      {
        id: 'dsar-export',
        endpoint: '/api/downloads/dsar-export',
        icon: 'ph-shield-check',
        title: 'DSAR / Privacy Export',
        blurb: 'All personal data for one subject — always async, ZIP output.',
        tone: 'red',
        needsRange: false,
        permission: 'download_compliance',
        tags: ['privacy', 'dsar', 'critical'],
        formats: ['zip'],
      },
    ],
  },
];

const TONES = {
  teal:    { ring: 'border-teal-500/30',    bg: 'bg-teal-500/10',    fg: 'text-teal-300',    btn: 'bg-teal-600 hover:bg-teal-500' },
  green:   { ring: 'border-emerald-500/30', bg: 'bg-emerald-500/10', fg: 'text-emerald-300', btn: 'bg-emerald-600 hover:bg-emerald-500' },
  red:     { ring: 'border-rose-500/30',    bg: 'bg-rose-500/10',    fg: 'text-rose-300',    btn: 'bg-rose-600 hover:bg-rose-500' },
  sky:     { ring: 'border-sky-500/30',     bg: 'bg-sky-500/10',     fg: 'text-sky-300',     btn: 'bg-sky-600 hover:bg-sky-500' },
  indigo:  { ring: 'border-indigo-500/30',  bg: 'bg-indigo-500/10',  fg: 'text-indigo-300',  btn: 'bg-indigo-600 hover:bg-indigo-500' },
  orange:  { ring: 'border-orange-500/30',  bg: 'bg-orange-500/10',  fg: 'text-orange-300',  btn: 'bg-orange-600 hover:bg-orange-500' },
};

// Flat lookup so the recently-run rail (which only knows cardId) can
// render the human-facing card title without re-walking SECTIONS.
const CARD_BY_ID = SECTIONS.flatMap((s) => s.cards).reduce((acc, c) => {
  acc[c.id] = c; return acc;
}, {});

// ── M7: Per-card source-data retention (in days).
//   This is the upstream retention window of the *source* collection
//   backing each report — independent of how far back the user is
//   asking for. Mirrors our published privacy policy + storage policies.
//   Conservative defaults: ops 90d, attendance/pickups 365d,
//   compliance/audit 730d, security incidents 180d, DSAR 730d.
const RETENTION_BY_CARD = {
  // Operational
  attendance: 365,
  'chaperone-roster': 730,
  'pickup-events': 365,
  'onboarding-forms': 730,
  'daily-brief': 90,
  'late-absence-trend': 365,
  'device-sync': 90,
  // Directory & Devices
  'students-roster': 730,
  terminals: 365,
  'system-health': 90,
  // Security & Compliance
  'security-incidents': 180,
  'access-logs': 365,
  'audit-log': 730,
  'chaperone-audit': 730,
  'audit-export': 730,
  'unknown-faces': 30,
  'chaperone-activity': 365,
  'consent-audit': 730,
  'runs-diff': 90,
  'dsar-export': 730,
};
// Decorate cards in place so DownloadCard can read `card.retentionDays`
// without having to look it up from a separate map.
for (const c of Object.values(CARD_BY_ID)) {
  if (typeof c.retentionDays !== 'number') {
    c.retentionDays = RETENTION_BY_CARD[c.id] ?? 365;
  }
}

function relativeTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60)   return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min}m ago`;
  const hr  = Math.floor(min / 60);
  if (hr  < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30)   return `${day}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtPills({ value, onChange, disabled, allowed }) {
  const list = Array.isArray(allowed) && allowed.length ? allowed : ['xlsx', 'pdf', 'csv'];
  return list.map((f) => (
    <button
      key={f}
      type="button"
      disabled={disabled}
      onClick={() => onChange(f)}
      className={`px-2.5 py-1 text-[11px] font-medium rounded border transition-colors ${
        value === f
          ? 'bg-white/10 text-white border-white/30'
          : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
      } disabled:opacity-40`}
    >
      {f.toUpperCase()}
    </button>
  ));
}

function safeCell(v) {
  if (v == null) return '';
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function PreviewModal({ data, tone, format, onClose, onConfirm, onApplyLast7 }) {
  const cols = data.columns || [];
  const rows = data.sampleRows || [];
  const more = Math.max(0, (data.totalRows || 0) - rows.length);
  const isEmpty = (data.totalRows || 0) === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[88vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className={`px-5 py-4 border-b border-slate-700 flex items-start justify-between gap-4 ${tone.bg}`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <i className={`ph ph-eye text-lg ${tone.fg}`} />
              <span className={`text-[10px] font-semibold uppercase tracking-widest ${tone.fg}`}>Preview</span>
            </div>
            <h3 className="text-base font-semibold text-white mt-1 truncate">{data.title}</h3>
            <p className="text-xs text-slate-400 mt-0.5 truncate">{data.subtitle}</p>
            {data.range && <p className="text-[11px] text-slate-500 mt-1">{data.range}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-white/5"
            aria-label="Close preview"
          >
            <i className="ph ph-x text-lg" />
          </button>
        </div>

        {/* KPIs */}
        {data.kpis && data.kpis.length > 0 && (
          <div className="px-5 py-3 border-b border-slate-800 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {data.kpis.map(([label, value], i) => (
              <div key={i} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2">
                <div className="text-[9px] uppercase tracking-wider text-slate-500 truncate">{label}</div>
                <div className="text-sm font-semibold text-white mt-0.5 truncate" title={String(value)}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Notes */}
        {data.notes && data.notes.length > 0 && (
          <div className="px-5 pt-3 space-y-1">
            {data.notes.map((n, i) => (
              <div key={i} className="text-[11px] text-amber-300/80 flex items-start gap-1.5">
                <i className="ph ph-info mt-0.5" /> <span>{n}</span>
              </div>
            ))}
          </div>
        )}

        {/* Sample table */}
        <div className="flex-1 overflow-auto px-5 py-3">
          {/* M3: empty-state coaching banner — only when the user has a
              way to widen the range (the hub passes onApplyLast7). */}
          {isEmpty && typeof onApplyLast7 === 'function' && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-amber-200">
              <i className="ph ph-info text-base mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-medium">No data in this range.</p>
                <p className="text-[11px] text-amber-200/80 mt-0.5">
                  Try expanding to the last 7 days — most reports surface
                  something useful at that window.
                </p>
              </div>
              <button
                type="button"
                onClick={onApplyLast7}
                className="shrink-0 px-2.5 py-1 text-[11px] font-semibold rounded bg-amber-500/30 hover:bg-amber-500/50 text-amber-50 border border-amber-400/40"
              >
                Apply: last 7 days
              </button>
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
            Showing first {rows.length.toLocaleString()} of {(data.totalRows || 0).toLocaleString()} rows
            {data.truncated && <span className="ml-2 text-amber-300">· truncated at server cap</span>}
          </div>
          {rows.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">
              <i className="ph ph-tray text-3xl block mb-2" />
              No rows in the selected range.
            </div>
          ) : (
            <table className="w-full text-[11px] border-collapse">
              <thead className="sticky top-0 bg-slate-900">
                <tr>
                  {cols.map((c) => (
                    <th key={c} className={`text-left font-semibold px-2 py-1.5 border-b border-slate-700 ${tone.fg}`}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className={ri % 2 ? 'bg-slate-950/40' : ''}>
                    {(Array.isArray(r) ? r : []).map((cell, ci) => (
                      <td key={ci} className="px-2 py-1.5 border-b border-slate-800/60 text-slate-300 align-top whitespace-nowrap">
                        {safeCell(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {more > 0 && (
            <div className="text-[11px] text-slate-500 italic mt-3">
              … {more.toLocaleString()} more rows will be included in the actual download.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-700 flex items-center justify-between gap-3 bg-slate-950/60">
          <div className="text-[11px] text-slate-500">
            Format: <span className="text-slate-300 font-medium">{format.toUpperCase()}</span>
            {data.tenant && <span className="ml-3">Tenant: <span className="text-slate-300">{data.tenant}</span></span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 rounded-lg"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={rows.length === 0}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg text-white flex items-center gap-1.5 ${tone.btn} disabled:opacity-50`}
            >
              <i className="ph ph-download-simple" /> Generate {format.toUpperCase()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// localStorage helpers — never throw on SSR / private-mode storage.
function lsGet(key) {
  try { if (typeof window === 'undefined') return null; return window.localStorage.getItem(key); }
  catch { return null; }
}
function lsSet(key, val) {
  try { if (typeof window === 'undefined') return; window.localStorage.setItem(key, val); } catch {}
}

// Resolve a preset id → { from, to } in the supplied timezone. Returns
// null for the `custom` sentinel; the caller keeps the existing
// from/to values when the user picks Custom.
function resolvePreset(id, tz) {
  const preset = RANGE_PRESETS.find((p) => p.id === id);
  if (!preset || !preset.range) return null;
  try { return preset.range(tz); } catch { return null; }
}

function DownloadCard({
  card, highlighted, registerRef, lastRun,
  timezone = 'Asia/Jakarta',
  isFavourite = false,
  onToggleFavourite,
  isSelected = false,
  onToggleSelected,
  formatDefault,           // server-side preference, optional
}) {
  const tone = TONES[card.tone] || TONES.teal;
  const cardRef = useRef(null);
  useEffect(() => {
    if (registerRef) registerRef(card.id, cardRef.current);
  }, [card.id, registerRef]);

  // Allowed formats: server-declared list with safety fallback.
  const allowedFormats = useMemo(
    () => (Array.isArray(card.formats) && card.formats.length ? card.formats : ['xlsx', 'csv']),
    [card.formats],
  );

  // Initial format = LS choice → server pref → first allowed.
  const initialFormat = useMemo(() => {
    const ls = lsGet(`downloads.format.${card.id}`);
    if (ls && allowedFormats.includes(ls)) return ls;
    if (formatDefault && allowedFormats.includes(formatDefault)) return formatDefault;
    return allowedFormats[0];
  }, [card.id, allowedFormats, formatDefault]);
  const [format, setFormatRaw] = useState(initialFormat);
  const setFormat = useCallback((f) => {
    setFormatRaw(f);
    lsSet(`downloads.format.${card.id}`, f);
  }, [card.id]);

  // Initial preset = LS → 'last7' default. We persist by preset id only;
  // `custom` keeps the user-typed dates intact.
  const initialPreset = useMemo(() => {
    const ls = lsGet(`downloads.range.${card.id}`);
    if (ls && RANGE_PRESETS.some((p) => p.id === ls)) return ls;
    return 'last7';
  }, [card.id]);
  const [presetId, setPresetIdRaw] = useState(initialPreset);
  const setPresetId = useCallback((id) => {
    setPresetIdRaw(id);
    lsSet(`downloads.range.${card.id}`, id);
  }, [card.id]);

  // Compute initial from/to from the chosen preset in the current TZ.
  const initialRange = useMemo(() => {
    const r = resolvePreset(initialPreset, timezone);
    return r || { from: daysAgo(6, timezone), to: today(timezone) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [from, setFrom] = useState(initialRange.from);
  const [to,   setTo]   = useState(initialRange.to);
  const [filters, setFilters] = useState({});
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null); // { rows, at }
  const [bigConfirm, setBigConfirm] = useState(null); // { rowCount } when > BIG
  // ── M7: PII redaction toggle. Only meaningful on cards whose columns
  //   declare a `pii` kind server-side. We persist the choice per-card
  //   so a "privacy by default" user doesn't have to re-tick every time.
  const [redact, setRedactRaw] = useState(() => lsGet(`downloads.redact.${card.id}`) === '1');
  const setRedact = useCallback((v) => {
    setRedactRaw(!!v);
    lsSet(`downloads.redact.${card.id}`, v ? '1' : '0');
  }, [card.id]);

  // Whenever preset or TZ changes (non-custom), recompute dates.
  useEffect(() => {
    if (presetId === 'custom') return;
    const r = resolvePreset(presetId, timezone);
    if (r) { setFrom(r.from); setTo(r.to); }
    // Reset stale estimate any time the range moves under us.
    setEstimate(null);
  }, [presetId, timezone]);

  const buildBody = (extra = {}) => (
    card.needsRange
      ? { format, from, to, filters, redact, ...extra }
      : { format, redact, ...extra }
  );

  const runGenerate = useCallback(async (reauthToken) => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(card.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(reauthToken ? { 'X-Reauth-Token': reauthToken } : {}),
        },
        body: JSON.stringify(buildBody()),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        let errCode = '';
        try { const j = await res.json(); detail = j.message || j.error || detail; errCode = j.error || ''; } catch {}
        // If server demands re-auth, re-open the password modal automatically.
        if (res.status === 401 && /^reauth_/.test(errCode)) {
          setReauthOpen(true);
          throw new Error(detail);
        }
        if (res.status === 423) {
          throw new Error(detail);
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m ? m[1] : `${card.id}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg({ ok: true, text: `Downloaded ${filename}` });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Export failed' });
    } finally {
      setBusy(false);
    }
  }, [card, format, from, to, filters]);

  // Public "Generate" button. If we have a fresh estimate over the
  // background threshold, prompt the user to enqueue rather than
  // tying up the browser tab on a 5k+ row sync export.
  const BIG_ROW_THRESHOLD = 5000;
  const generate = useCallback(() => {
    setMsg(null);
    if (estimate && estimate.rows > BIG_ROW_THRESHOLD) {
      setBigConfirm({ rowCount: estimate.rows });
      return;
    }
    setReauthOpen(true);
  }, [estimate]);

  const runDryRun = useCallback(async () => {
    setEstimating(true); setMsg(null);
    try {
      const res = await fetch(card.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody({ dryRun: true })),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.message || j.error || detail; } catch {}
        throw new Error(detail);
      }
      const data = await res.json();
      const rows = Number(data.rowCount || 0);
      setEstimate({ rows, at: Date.now() });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Estimate failed' });
    } finally {
      setEstimating(false);
    }
  }, [card, format, from, to, filters]);

  // Enqueue background job — confirmation path after big-row warning.
  const enqueueBackground = useCallback(async () => {
    setBigConfirm(null);
    setBusy(true); setMsg(null);
    try {
      // Background jobs require re-auth via X-Reauth-Token; reuse the
      // same modal. We stash the enqueue intent on the ref to know what
      // to do once the user confirms.
      setReauthOpen('background');
    } finally {
      setBusy(false);
    }
  }, []);

  const runEnqueue = useCallback(async (reauthToken) => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/downloads/_jobs/start', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(reauthToken ? { 'X-Reauth-Token': reauthToken } : {}),
        },
        body: JSON.stringify({
          cardId: card.id, format,
          from: card.needsRange ? from : null,
          to:   card.needsRange ? to : null,
          filters,
        }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.message || j.error || detail; } catch {}
        throw new Error(detail);
      }
      const data = await res.json();
      setMsg({
        ok: true,
        text: `Queued — we'll prepare it in the background (job ${String(data.jobId || '').slice(0, 8)}). Check "Recently run".`,
      });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Enqueue failed' });
    } finally {
      setBusy(false);
    }
  }, [card, format, from, to, filters]);

  const runPreview = useCallback(async () => {
    setPreviewing(true); setMsg(null);
    try {
      const res = await fetch(card.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody({ preview: true })),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.error || j.message || detail; } catch {}
        throw new Error(detail);
      }
      const data = await res.json();
      setPreview(data);
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Preview failed' });
    } finally {
      setPreviewing(false);
    }
  }, [card, format, from, to, filters]);

  return (
    <div
      ref={cardRef}
      data-card-id={card.id}
      className={`bg-slate-900/60 border ${tone.ring} rounded-xl p-4 flex flex-col gap-3 transition-shadow relative ${
        highlighted ? 'ring-2 ring-teal-400/70 ring-offset-2 ring-offset-slate-950 shadow-[0_0_30px_rgba(45,212,191,0.35)]' : ''
      } ${isSelected ? 'outline outline-2 outline-teal-400/60' : ''}`}
    >
      {/* Top-corner actions: bulk-select checkbox + favourite pin. */}
      {onToggleSelected && (
        <label className="absolute top-2 left-2 z-10 flex items-center cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelected(card.id)}
            className="w-4 h-4 rounded border-slate-600 bg-slate-950 text-teal-500 focus:ring-teal-500 focus:ring-offset-slate-950"
            aria-label={`Select ${card.title} for bulk run`}
          />
        </label>
      )}
      {onToggleFavourite && (
        <button
          type="button"
          onClick={() => onToggleFavourite(card.id)}
          className={`absolute top-2 right-2 z-10 p-1 rounded hover:bg-white/5 transition-colors ${
            isFavourite ? 'text-amber-300' : 'text-slate-500 hover:text-slate-300'
          }`}
          aria-label={isFavourite ? 'Unpin from favourites' : 'Pin to favourites'}
          title={isFavourite ? 'Unpin from favourites' : 'Pin to favourites'}
        >
          <i className={`ph${isFavourite ? '-fill' : ''} ph-push-pin text-base`} />
        </button>
      )}

      <div className="flex items-start gap-3 pl-7 pr-7">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${tone.bg} ${tone.fg}`}>
          <i className={`ph ${card.icon} text-xl`} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white">{card.title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{card.blurb}</p>
          {/* M7: Retention badge — surfaces the upstream data retention
              window so operators know what window the source actually
              covers (independent of the export's own date range). */}
          {typeof card.retentionDays === 'number' && (
            <p className="text-[10px] text-slate-500 mt-1" title="Maximum age of source data backing this report">
              <i className="ph ph-archive" /> Source data retained {card.retentionDays} days
            </p>
          )}
          {lastRun && (
            <p className="text-[10px] text-slate-500 mt-1">
              Last run: {relativeTime(lastRun.createdAt)} · {Number(lastRun.rowCount || 0).toLocaleString()} rows
              {lastRun.verifyToken && (
                <span className="ml-1 text-slate-600" title={`Verification token: ${lastRun.verifyToken}`}>
                  · verify:{String(lastRun.verifyToken).slice(0, 8)}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {card.needsRange && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">Range</label>
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="flex-1 text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
            >
              {RANGE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          {presetId === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px] uppercase tracking-wide text-slate-500">
                From
                <input
                  type="date"
                  value={from}
                  onChange={(e) => { setFrom(e.target.value); setEstimate(null); }}
                  className="mt-0.5 w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
                />
              </label>
              <label className="text-[10px] uppercase tracking-wide text-slate-500">
                To
                <input
                  type="date"
                  value={to}
                  onChange={(e) => { setTo(e.target.value); setEstimate(null); }}
                  className="mt-0.5 w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
                />
              </label>
            </div>
          )}
          {presetId !== 'custom' && (
            <p className="text-[10px] text-slate-500 -mt-1.5">
              {from} → {to} · {timezone}
            </p>
          )}
        </>
      )}

      {card.filters?.includes('class') && (
        <input
          type="text"
          placeholder="Homeroom (optional, e.g. 4A)"
          value={filters.class || ''}
          onChange={(e) => { setFilters((f) => ({ ...f, class: e.target.value })); setEstimate(null); }}
          className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
        />
      )}
      {card.filters?.includes('status') && (
        <select
          value={filters.status || ''}
          onChange={(e) => { setFilters((f) => ({ ...f, status: e.target.value })); setEstimate(null); }}
          className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
        >
          <option value="">All statuses</option>
          <option value="Present">Present</option>
          <option value="Late">Late</option>
        </select>
      )}
      {card.filters?.includes('formStatus') && (
        <select
          value={filters.status || ''}
          onChange={(e) => { setFilters((f) => ({ ...f, status: e.target.value })); setEstimate(null); }}
          className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
        >
          <option value="">All form statuses</option>
          <option value="pending">Pending review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      )}
      {card.filters?.includes('auditKind') && (
        <input
          type="text"
          placeholder="Kind prefix (optional, e.g. pickup.)"
          value={filters.kind || ''}
          onChange={(e) => { setFilters((f) => ({ ...f, kind: e.target.value })); setEstimate(null); }}
          className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
        />
      )}

      {/* Format pills + dry-run estimate. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {fmtPills({ value: format, onChange: setFormat, disabled: busy || previewing, allowed: allowedFormats })}
          {/* M7: PII redaction toggle. No-op for cards whose columns
              don't declare a `pii` kind — backend is the source of truth. */}
          <label
            className={`ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide cursor-pointer select-none ${redact ? 'text-amber-300' : 'text-slate-500 hover:text-slate-300'}`}
            title="Hash names → initials, mask Binus IDs / emails / phone numbers in the rendered file"
          >
            <input
              type="checkbox"
              checked={redact}
              onChange={(e) => setRedact(e.target.checked)}
              disabled={busy || previewing}
              className="w-3 h-3 accent-amber-400"
            />
            Redact PII
          </label>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={runDryRun}
            disabled={busy || previewing || estimating}
            className="px-2 py-1 text-[11px] font-medium rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 disabled:opacity-40 flex items-center gap-1"
            title="Quickly estimate the row count for this range"
          >
            {estimating
              ? (<><i className="ph ph-circle-notch animate-spin" /> Estimating…</>)
              : (<><i className="ph ph-calculator" /> Estimate rows</>)}
          </button>
          {estimate && !estimating && (
            <span className="px-2 py-0.5 text-[11px] font-semibold rounded bg-slate-800/80 text-slate-200 border border-slate-700">
              ≈ {estimate.rows.toLocaleString()} rows
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1 mt-auto">
        <button
          type="button"
          onClick={runPreview}
          disabled={busy || previewing}
          className="px-2.5 py-1.5 text-xs font-medium rounded-lg text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 flex items-center gap-1.5 disabled:opacity-50"
        >
          {previewing
            ? (<><i className="ph ph-circle-notch animate-spin" /> …</>)
            : (<><i className="ph ph-eye" /> Preview</>)}
        </button>
        <button
          type="button"
          onClick={generate}
          disabled={busy || previewing}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg text-white flex items-center gap-1.5 ${tone.btn} disabled:opacity-50`}
        >
          {busy
            ? (<><i className="ph ph-circle-notch animate-spin" /> Generating…</>)
            : (<><i className="ph ph-download-simple" /> Download</>)}
        </button>
      </div>

      {msg && (
        <div className={`text-[11px] rounded px-2 py-1 ${
          msg.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
        }`}>
          {msg.text}
        </div>
      )}

      {preview && (
        <PreviewModal
          data={preview}
          tone={tone}
          format={format}
          onClose={() => setPreview(null)}
          onConfirm={() => { setPreview(null); generate(); }}
          onApplyLast7={() => {
            // Coaching banner — jump to the Last 7 days preset and
            // re-trigger the preview. We deliberately reset to the
            // built-in preset so the user can see the source range
            // even after closing the modal.
            setPresetId('last7');
            const r = resolvePreset('last7', timezone);
            if (r) { setFrom(r.from); setTo(r.to); }
            setEstimate(null);
            setPreview(null);
            // Defer so the new from/to state is captured by buildBody().
            setTimeout(() => runPreview(), 0);
          }}
        />
      )}

      {bigConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setBigConfirm(null); }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center shrink-0">
                <i className="ph ph-clock-countdown text-xl" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">Large export</h3>
                <p className="text-xs text-slate-400 mt-1">
                  This export will produce <span className="text-slate-200 font-semibold">{bigConfirm.rowCount.toLocaleString()}</span> rows.
                  We'll run it in the background — you'll be notified in <span className="text-slate-200">Recently run</span> when it's ready. Continue?
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBigConfirm(null)}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={enqueueBackground}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-amber-600 hover:bg-amber-500 flex items-center gap-1.5"
              >
                <i className="ph ph-paper-plane-tilt" /> Continue in background
              </button>
            </div>
          </div>
        </div>
      )}

      <ReauthModal
        open={!!reauthOpen}
        title="Confirm download"
        action={`download the ${card.title.toLowerCase()}`}
        onCancel={() => setReauthOpen(false)}
        onConfirm={(token) => {
          const mode = reauthOpen;
          setReauthOpen(false);
          if (mode === 'background') runEnqueue(token);
          else runGenerate(token);
        }}
      />
    </div>
  );
}

const CROSS_LINKS = [
  { href: '/v2/reports',                icon: 'ph-chart-line',          label: 'Attendance Analytics',  blurb: 'Interactive dashboards & monthly summaries.' },
  { href: '/v2/pickup-admin',           icon: 'ph-package',             label: 'Pickup Admin',          blurb: 'Chaperone management, pickup logs, onboarding.' },
  { href: '/v2/admin/security-audit',   icon: 'ph-shield-check',        label: 'Security Audit Console', blurb: 'Live access-log viewer with device fingerprints.' },
  { href: '/v2/admin/system-audit',     icon: 'ph-clipboard-text',      label: 'System Audit Console',  blurb: 'Browse the full mutation trail in real time.' },
];

// "My presets" rail (M6). Saved + scheduled report templates per user
// plus any preset shared with the caller's role. Run-now invokes the
// preset's card endpoint with stored filters; delete removes ownership;
// schedule badge surfaces when a preset has `schedule.enabled`.
function MyPresetsRail({ presets, loading, onRun, onDelete, canManage }) {
  if (!loading && presets.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          My presets
        </h2>
        <span className="text-[10px] text-slate-500">
          Scheduled runs land in Recently run · share via copy-link.
        </span>
      </div>
      {loading ? (
        <div className="text-[11px] text-slate-500 italic">Loading…</div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
          {presets.map((p) => {
            const card = CARD_BY_ID[p.cardId];
            const tone = TONES[card?.tone] || TONES.teal;
            const sched = p.schedule && p.schedule.enabled ? p.schedule : null;
            return (
              <div key={p.id}
                   className={`shrink-0 w-[240px] bg-slate-900/60 border ${tone.ring} rounded-lg p-3 flex flex-col gap-1.5`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider ${tone.fg} truncate`} title={p.name}>
                    {p.name}
                  </span>
                  <span className="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    {String(p.format || 'xlsx').toUpperCase()}
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 truncate" title={card?.title || p.cardId}>
                  {card?.title || p.cardId}
                </div>
                {sched ? (
                  <div className="text-[10px] text-emerald-400 truncate" title={`cron: ${sched.cron}`}>
                    <i className="ph ph-clock" /> {sched.cron} · keep {sched.retentionDays}d
                  </div>
                ) : (
                  <div className="text-[10px] text-slate-500">Manual run · {p.isOwner ? 'mine' : 'shared'}</div>
                )}
                <div className="flex items-center gap-1.5 mt-1">
                  <button type="button"
                          onClick={() => onRun && onRun(p)}
                          className={`flex-1 px-2 py-1 text-[11px] font-medium rounded text-white flex items-center justify-center gap-1.5 ${tone.btn}`}
                          title="Jump to this card with filters pre-filled">
                    <i className="ph ph-play" /> Run now
                  </button>
                  {p.isOwner && canManage && (
                    <button type="button"
                            onClick={() => onDelete && onDelete(p)}
                            className="px-2 py-1 text-[10px] font-medium rounded border border-slate-700 text-slate-400 hover:text-rose-300 hover:border-rose-500/60"
                            title="Delete this preset">
                      <i className="ph ph-trash" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// "Recently run by you" horizontal rail. Fetches the caller's 5 most
// recent reportRuns and renders compact re-download tiles. The rail is
// always rendered (with an empty-state) so the page doesn't reflow when
// data arrives.
function RecentlyRunRail({ runs, loading, onShare, canShare }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Recently run by you
        </h2>
        {/* TODO(M2 follow-up): /v2/admin/downloads?tab=history doesn't
            exist yet — wire the full history tab in a later milestone. */}
        <Link
          href="/v2/admin/downloads?tab=history"
          className="text-[11px] text-slate-500 hover:text-slate-300"
        >
          View all →
        </Link>
      </div>
      {loading ? (
        <div className="text-[11px] text-slate-500 italic">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="text-[11px] text-slate-500 italic border border-dashed border-slate-700/60 rounded-lg px-3 py-3">
          You haven&apos;t run any reports yet. Generate one below — it&apos;ll show up here for quick re-download.
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
          {runs.map((r) => {
            const card = CARD_BY_ID[r.cardId];
            const tone = TONES[card?.tone] || TONES.teal;
            const title = card?.title || r.cardId;
            const range = r.from && r.to ? `${r.from} → ${r.to}` : (r.mode === 'sync' ? 'Snapshot' : '—');
            const canRedown = r.storageAvailable && r.status === 'completed';
            return (
              <div
                key={r.id}
                className={`shrink-0 w-[220px] bg-slate-900/60 border ${tone.ring} rounded-lg p-3 flex flex-col gap-1.5`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider ${tone.fg} truncate`}>
                    {title}
                  </span>
                  <span className="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    {String(r.format || '').toUpperCase()}
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 truncate" title={range}>{range}</div>
                <div className="text-[10px] text-slate-500">
                  {Number(r.rowCount || 0).toLocaleString()} rows · {relativeTime(r.createdAt)}
                </div>
                <button
                  type="button"
                  disabled={!canRedown}
                  onClick={() => {
                    if (!canRedown) return;
                    window.location.href = `/api/downloads/runs/${r.id}/download`;
                  }}
                  className={`mt-1 px-2 py-1 text-[11px] font-medium rounded text-white flex items-center justify-center gap-1.5 ${tone.btn} disabled:opacity-40 disabled:cursor-not-allowed`}
                  title={canRedown ? 'Re-download saved artifact' : 'No artifact saved for this run'}
                >
                  <i className="ph ph-download-simple" /> Re-download
                </button>
                {canShare && (
                  <button
                    type="button"
                    disabled={!canRedown}
                    onClick={() => canRedown && onShare && onShare(r)}
                    className="px-2 py-1 text-[10px] font-medium rounded border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Mint a 24h shareable link (audit-logged)"
                  >
                    <i className="ph ph-share-network" /> Share link
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Decide if the current user can see a given card. A card may declare:
//   permission: 'download_x'             — single key, must match
//   anyPermission: ['download_x', ...]   — ANY of these keys grants access
//   (neither)                            — always shown (back-compat)
function cardVisible(card, can) {
  if (!can) return true;
  if (Array.isArray(card.anyPermission) && card.anyPermission.length) {
    return card.anyPermission.some((a) => can('downloads', a));
  }
  if (card.permission) return can('downloads', card.permission);
  return true;
}

export default function DownloadsPage() {
  const { can, permissions } = useAuth();
  // Filter SECTIONS through RBAC. Owners see everything (every action true);
  // others see only the cards backed by a permission they hold.
  const visibleSections = useMemo(() => {
    return SECTIONS.map((s) => ({
      ...s,
      cards: s.cards.filter((c) => cardVisible(c, can)),
    }));
    // Re-evaluate when the resolved permissions object changes.
  }, [can, permissions]);
  const allCards = useMemo(() => visibleSections.flatMap((s) => s.cards), [visibleSections]);
  const router = useRouter();
  const cardRefs = useRef({});
  const [highlightedId, setHighlightedId] = useState(null);

  // ── M3: per-user preferences (timezone, favourites, format defaults).
  //   Loaded once on mount; toggling a favourite or changing TZ writes
  //   through the merge-patch endpoint immediately so other tabs/devices
  //   see the change on next load.
  const [timezone, setTimezoneState] = useState('Asia/Jakarta');
  const [favourites, setFavouritesState] = useState([]); // string[]
  const [formatDefaults, setFormatDefaults] = useState({}); // { cardId: 'xlsx' }
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v2/users/me/preferences', { credentials: 'include' });
        if (!res.ok) throw new Error('prefs_load_failed');
        const data = await res.json();
        if (cancelled) return;
        if (data.timezone && ALLOWED_TZ.has(data.timezone)) setTimezoneState(data.timezone);
        if (Array.isArray(data.favourites)) setFavouritesState(data.favourites);
        if (data.formatDefaults && typeof data.formatDefaults === 'object') {
          setFormatDefaults(data.formatDefaults);
        }
      } catch {
        // Silent — defaults already in state.
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persistPref = useCallback(async (body) => {
    try {
      await fetch('/api/v2/users/me/preferences', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { /* optimistic UI — server write is best-effort */ }
  }, []);

  const setTimezone = useCallback((tz) => {
    if (!ALLOWED_TZ.has(tz)) return;
    setTimezoneState(tz);
    persistPref({ timezone: tz });
  }, [persistPref]);

  const toggleFavourite = useCallback((cardId) => {
    setFavouritesState((cur) => {
      const has = cur.includes(cardId);
      const next = has ? cur.filter((id) => id !== cardId) : [...cur, cardId];
      persistPref({ favourite: { id: cardId, action: has ? 'remove' : 'add' } });
      return next;
    });
  }, [persistPref]);

  // ── M3: search + tag-filter state. Search is debounced 200ms to keep
  //   typing snappy; tag selection is AND across chips.
  const [searchInput, setSearchInput] = useState('');
  const [searchQ, setSearchQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(searchInput.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [searchInput]);
  const [activeTags, setActiveTags] = useState([]); // string[]
  const allTags = useMemo(() => {
    const set = new Set();
    for (const c of allCards) (c.tags || []).forEach((t) => set.add(t));
    return Array.from(set).sort();
  }, [allCards]);
  const toggleTag = useCallback((t) => {
    setActiveTags((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  }, []);
  const clearFilters = useCallback(() => {
    setSearchInput(''); setSearchQ(''); setActiveTags([]);
  }, []);
  const filterActive = searchQ.length > 0 || activeTags.length > 0;

  // Filter visible sections through search + tags. Sections that end up
  // empty after filtering collapse out of the grid.
  const filteredSections = useMemo(() => {
    return visibleSections
      .map((s) => ({
        ...s,
        cards: s.cards.filter((c) => {
          if (activeTags.length) {
            const cardTags = c.tags || [];
            // AND semantics: every active tag must be on the card.
            if (!activeTags.every((t) => cardTags.includes(t))) return false;
          }
          if (searchQ) {
            const hay = `${c.id} ${c.title} ${c.blurb}`.toLowerCase();
            if (!hay.includes(searchQ)) return false;
          }
          return true;
        }),
      }))
      .filter((s) => s.cards.length > 0);
  }, [visibleSections, activeTags, searchQ]);

  // Pinned section: any visible card whose id appears in `favourites`.
  // Built from the unfiltered visible list so the pin row doesn't
  // disappear when the user types a search query.
  const pinnedCards = useMemo(() => {
    if (!favourites.length) return [];
    const seen = new Set();
    const out = [];
    for (const id of favourites) {
      if (seen.has(id)) continue;
      seen.add(id);
      const card = allCards.find((c) => c.id === id);
      if (card) out.push(card);
    }
    return out;
  }, [favourites, allCards]);

  // ── M3: bulk-run selection ──────────────────────────────────────────
  const [selected, setSelected] = useState(() => new Set()); // Set<cardId>
  const [bulkFormat, setBulkFormat] = useState('xlsx');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState(null);
  const [bulkReauthOpen, setBulkReauthOpen] = useState(false);
  const toggleSelected = useCallback((id) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const runBulk = useCallback(async (reauthToken) => {
    setBulkBusy(true); setBulkMsg(null);
    try {
      // Use the first selected card's preset range as the bulk window,
      // honouring the hub timezone. Falls back to last7 if no card needs
      // a date range.
      const r = resolvePreset('last7', timezone) || { from: daysAgo(6, timezone), to: today(timezone) };
      const ids = Array.from(selected);
      const res = await fetch('/api/downloads/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(reauthToken ? { 'X-Reauth-Token': reauthToken } : {}),
        },
        body: JSON.stringify({ cardIds: ids, format: bulkFormat, from: r.from, to: r.to }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.message || j.error || detail; } catch {}
        throw new Error(detail);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m ? m[1] : `bulk_${r.from}_${r.to}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBulkMsg({ ok: true, text: `Downloaded ${filename} (${ids.length} reports)` });
      clearSelection();
      // Refresh the recently-run rail so the bulk run shows up.
      refreshRuns();
    } catch (err) {
      setBulkMsg({ ok: false, text: err.message || 'Bulk export failed' });
    } finally {
      setBulkBusy(false);
    }
  }, [selected, bulkFormat, timezone, clearSelection]);

  // ── M3: timezone gear popover ───────────────────────────────────────
  const [tzOpen, setTzOpen] = useState(false);
  const tzPopRef = useRef(null);
  useEffect(() => {
    if (!tzOpen) return;
    const onClick = (e) => {
      if (tzPopRef.current && !tzPopRef.current.contains(e.target)) setTzOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setTzOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [tzOpen]);

  // M2: "Recently run by you" — backs both the rail and the per-card
  // "Last run: …" caption. Single fetch, grouped client-side so we don't
  // pay 10× Firestore reads on mount.
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/downloads/runs/list?mineOnly=true&limit=50', {
        credentials: 'include',
      });
      if (!res.ok) { setRuns([]); return; }
      const data = await res.json();
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, []);
  useEffect(() => { refreshRuns(); }, [refreshRuns]);

  // ── M6: Saved presets ───────────────────────────────────────────────
  const [presets, setPresets] = useState([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const canManagePresets = !!(can && can('downloads', 'manage_presets'));
  const refreshPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/presets', { credentials: 'include' });
      if (!res.ok) { setPresets([]); return; }
      const data = await res.json();
      setPresets(Array.isArray(data.presets) ? data.presets : []);
    } catch {
      setPresets([]);
    } finally {
      setPresetsLoading(false);
    }
  }, []);
  useEffect(() => { refreshPresets(); }, [refreshPresets]);

  const runPreset = useCallback((p) => {
    // Deep-link into the matching card so the user sees the filters
    // hydrate visibly before triggering Generate. Pre-filling
    // filter state across cards is out of scope for M6 — the deep-
    // link + visible card is enough to chain into the existing flow.
    router.push({ pathname: '/v2/admin/downloads', query: { card: p.cardId } });
  }, [router]);

  const deletePreset = useCallback(async (p) => {
    if (!window.confirm(`Delete preset "${p.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/v2/presets/${p.id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || j.error || `HTTP ${res.status}`);
      }
      refreshPresets();
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  }, [refreshPresets]);

  // ── M6: Share link — mint 24h signed URL, copy to clipboard ────────
  const shareRun = useCallback(async (r) => {
    const note = window.prompt(
      'Optional note: who are you sharing this with? (Audit-logged, not sent anywhere.)',
      '',
    );
    if (note === null) return;  // user cancelled
    try {
      const res = await fetch(`/api/downloads/runs/${r.id}/share`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharedWith: note }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || j.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      try {
        await navigator.clipboard.writeText(data.url);
        alert(`Link copied to clipboard.\nExpires: ${new Date(data.expiresAt).toLocaleString()}\n\nCommunicate this link out-of-band — recipients are not notified automatically.`);
      } catch {
        window.prompt('Copy this share link (expires in 24h):', data.url);
      }
    } catch (e) {
      alert(`Share failed: ${e.message}`);
    }
  }, []);

  // Latest run per cardId (runs already arrive in createdAt-desc order).
  const lastRunByCard = useMemo(() => {
    const acc = {};
    for (const r of runs) {
      // Only count completed sync/async runs in the "last run" caption —
      // previews and dry-runs aren't user-facing artifacts.
      if (r.status !== 'completed') continue;
      if (r.mode !== 'sync' && r.mode !== 'async') continue;
      if (!acc[r.cardId]) acc[r.cardId] = r;
    }
    return acc;
  }, [runs]);

  // Top-5 for the rail. Show any completed run (sync OR async); skip the
  // preview / dry-run noise.
  const recentRuns = useMemo(
    () => runs
      .filter((r) => r.status === 'completed' && (r.mode === 'sync' || r.mode === 'async' || r.mode === 'bulk'))
      .slice(0, 5),
    [runs],
  );

  const registerCardRef = useCallback((id, el) => {
    if (el) cardRefs.current[id] = el;
    else delete cardRefs.current[id];
  }, []);

  // Deep-link handler — scroll-to + highlight when ?card=<id> is present.
  // Re-runs whenever the param changes so navigating between cards works.
  useEffect(() => {
    if (!router.isReady) return;
    const raw = router.query.card;
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!id) { setHighlightedId(null); return; }
    const valid = allCards.some((c) => c.id === id);
    if (!valid) return;
    // Wait one frame so refs are attached.
    const t1 = setTimeout(() => {
      const el = cardRefs.current[id];
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setHighlightedId(id);
    }, 60);
    // Remove the highlight ring after a short pulse.
    const t2 = setTimeout(() => setHighlightedId(null), 3000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [router.isReady, router.query.card, allCards]);

  // Common render helper for a card grid (used by Pinned + each section).
  const renderCardGrid = (cards) => (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {cards.map((c) => (
        <DownloadCard
          key={c.id}
          card={c}
          highlighted={highlightedId === c.id}
          registerRef={registerCardRef}
          lastRun={lastRunByCard[c.id] || null}
          timezone={timezone}
          isFavourite={favourites.includes(c.id)}
          onToggleFavourite={prefsLoaded ? toggleFavourite : undefined}
          isSelected={selected.has(c.id)}
          onToggleSelected={toggleSelected}
          formatDefault={formatDefaults[c.id] || null}
        />
      ))}
    </div>
  );

  return (
    <AdminLayout title="Downloads" subtitle="Reports, audits & compliance exports">
      <Head><title>Downloads · Admin</title></Head>

      <div className="h-full overflow-y-auto">
        <div className="space-y-8 pb-8 pr-1">
        <div className="bg-gradient-to-br from-teal-900/40 via-slate-900/50 to-indigo-900/40 border border-slate-700/50 rounded-xl p-5">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-teal-500/15 text-teal-300 flex items-center justify-center">
              <i className="ph ph-download-simple text-2xl" />
            </div>
            <div className="flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-white">One-stop compliance desk</h2>
                  <p className="text-xs text-slate-300 mt-1 max-w-2xl">
                    Every export below is fully branded (BINUS cover page, theme colours, zebra striping),
                    rate-limited and recorded in the audit log. Use the cards to pull the slice you need;
                    switch between XLSX, PDF and CSV with one click.
                  </p>
                  <p className="text-[11px] text-slate-400 mt-2">
                    {allCards.length} exports available · Timezone <span className="text-slate-200">{timezone}</span>
                  </p>
                </div>
                {/* TZ gear popover */}
                <div className="relative" ref={tzPopRef}>
                  <button
                    type="button"
                    onClick={() => setTzOpen((v) => !v)}
                    className="p-2 rounded-lg border border-slate-700 hover:border-slate-500 text-slate-300 hover:text-white hover:bg-slate-800/60 flex items-center gap-1.5"
                    aria-haspopup="true"
                    aria-expanded={tzOpen}
                    title="Hub preferences"
                  >
                    <i className="ph ph-gear text-base" />
                  </button>
                  {tzOpen && (
                    <div className="absolute right-0 mt-2 w-72 z-30 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4">
                      <h3 className="text-xs font-semibold text-white">Hub timezone</h3>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Date presets and per-card range pickers compute days in this zone. Backend data is unchanged.
                      </p>
                      <label className="block mt-3 text-[10px] uppercase tracking-wider text-slate-500">
                        Timezone
                        <select
                          value={timezone}
                          onChange={(e) => setTimezone(e.target.value)}
                          className="mt-1 w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200"
                        >
                          {TIMEZONES.map((t) => (
                            <option key={t.id} value={t.id}>{t.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <MyPresetsRail
          presets={presets}
          loading={presetsLoading}
          onRun={runPreset}
          onDelete={deletePreset}
          canManage={canManagePresets}
        />
        <RecentlyRunRail
          runs={recentRuns}
          loading={runsLoading}
          onShare={shareRun}
          canShare={canManagePresets}
        />

        {/* M3: Search + tag filter. */}
        <section className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <i className="ph ph-magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-sm" />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search exports by name…"
                className="w-full pl-7 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-700 rounded-lg text-slate-200 placeholder:text-slate-500 focus:border-teal-500 focus:outline-none"
              />
            </div>
            {filterActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 flex items-center gap-1.5"
              >
                <i className="ph ph-x" /> Clear filters
              </button>
            )}
          </div>
          {allTags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {allTags.map((t) => {
                const on = activeTags.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTag(t)}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded-full border transition-colors ${
                      on
                        ? 'bg-teal-500/20 text-teal-200 border-teal-400/50'
                        : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
                    }`}
                    aria-pressed={on}
                  >
                    #{t}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* M3: Bulk-run toolbar (sticky-style banner when any card selected). */}
        {selected.size > 0 && (
          <div className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur border border-teal-500/30 rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap shadow-lg">
            <div className="text-xs text-slate-200">
              <span className="font-semibold text-teal-200">{selected.size} selected</span>
              <span className="text-slate-400"> · bundled as ZIP, audited per card</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1">
                {fmtPills({ value: bulkFormat, onChange: setBulkFormat, disabled: bulkBusy, allowed: ['xlsx', 'csv'] })}
              </div>
              <button
                type="button"
                onClick={clearSelection}
                disabled={bulkBusy}
                className="px-2.5 py-1.5 text-xs font-medium rounded-lg text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 disabled:opacity-50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => { setBulkMsg(null); setBulkReauthOpen(true); }}
                disabled={bulkBusy || selected.size === 0}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white flex items-center gap-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50"
              >
                {bulkBusy
                  ? (<><i className="ph ph-circle-notch animate-spin" /> Bundling…</>)
                  : (<><i className="ph ph-archive" /> Run {selected.size} selected</>)}
              </button>
            </div>
            {bulkMsg && (
              <div className={`basis-full text-[11px] rounded px-2 py-1 ${
                bulkMsg.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
              }`}>
                {bulkMsg.text}
              </div>
            )}
            <ReauthModal
              open={bulkReauthOpen}
              title="Confirm bulk download"
              action={`bulk-download ${selected.size} reports`}
              onCancel={() => setBulkReauthOpen(false)}
              onConfirm={(token) => { setBulkReauthOpen(false); runBulk(token); }}
            />
          </div>
        )}

        {/* Pinned section sits above the regular grid when any pins exist. */}
        {pinnedCards.length > 0 && !filterActive && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-300/90 flex items-center gap-1.5">
                <i className="ph-fill ph-push-pin" /> Pinned
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">Your favourite exports — quick access at the top.</p>
            </div>
            {renderCardGrid(pinnedCards)}
          </section>
        )}

        {filteredSections.length === 0 && filterActive ? (
          <div className="text-center text-slate-400 italic border border-dashed border-slate-700/60 rounded-lg px-3 py-10">
            <i className="ph ph-magnifying-glass text-2xl block mb-2 text-slate-500" />
            No exports match your search.
            <button
              type="button"
              onClick={clearFilters}
              className="ml-2 text-teal-300 hover:text-teal-200 underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          filteredSections.map((section) => (
            <section key={section.heading} className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">{section.heading}</h2>
                <p className="text-xs text-slate-500 mt-0.5">{section.description}</p>
              </div>
              {renderCardGrid(section.cards)}
            </section>
          ))
        )}

        {!filterActive && visibleSections.every((s) => s.cards.length === 0) && (
          <div className="text-[11px] text-slate-500 italic border border-dashed border-slate-700/60 rounded-lg px-3 py-4">
            You don't have permission to export anything yet — ask an owner to grant a download role.
          </div>
        )}

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Live consoles</h2>
            <p className="text-xs text-slate-500 mt-0.5">For real-time browsing instead of downloads.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {CROSS_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="group flex items-start gap-3 bg-slate-900/40 hover:bg-slate-800/60 border border-slate-700/40 hover:border-slate-600 rounded-lg p-3 transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-slate-800/60 text-slate-300 group-hover:text-white flex items-center justify-center">
                  <i className={`ph ${l.icon} text-lg`} />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white">{l.label}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{l.blurb}</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
        </div>
      </div>
    </AdminLayout>
  );
}
