/**
 * /v2/admin/downloads
 *
 * The Downloads Hub — one-stop compliance/operations export desk.
 * Wires five branded report endpoints behind a uniform date-range
 * + format picker UI. Access is gated by the `downloads` feature in
 * lib/permissions.js (owner + admin by default).
 */
import Head from 'next/head';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import AdminLayout from '../../../components/v2/AdminLayout';
import ReauthModal from '../../../components/v2/ReauthModal';

const today = () => {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
const daysAgo = (n) => {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

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
      },
      {
        id: 'chaperone-roster',
        endpoint: '/api/downloads/chaperone-roster',
        icon: 'ph-users-three',
        title: 'Chaperone Roster',
        blurb: 'Full directory of registered pickup chaperones / guardians.',
        tone: 'green',
        needsRange: false,
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
      },
      {
        id: 'terminals',
        endpoint: '/api/downloads/terminals',
        icon: 'ph-device-tablet',
        title: 'Terminals & Devices',
        blurb: 'All face terminals & gate devices with online / heartbeat status.',
        tone: 'indigo',
        needsRange: false,
      },
      {
        id: 'system-health',
        endpoint: '/api/downloads/system-health',
        icon: 'ph-heartbeat',
        title: 'System Health Snapshot',
        blurb: 'Live terminal status + today’s attendance + 24h pickup volume.',
        tone: 'red',
        needsRange: false,
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
      },
      {
        id: 'access-logs',
        endpoint: '/api/downloads/access-logs',
        icon: 'ph-sign-in',
        title: 'Dashboard Access Log',
        blurb: 'Every sign-in to the admin console — user, IP, device, time.',
        tone: 'sky',
        needsRange: true,
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

function fmtPills({ value, onChange, disabled }) {
  return ['xlsx', 'pdf', 'csv'].map((f) => (
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

function PreviewModal({ data, tone, format, onClose, onConfirm }) {
  const cols = data.columns || [];
  const rows = data.sampleRows || [];
  const more = Math.max(0, (data.totalRows || 0) - rows.length);

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

function DownloadCard({ card }) {
  const tone = TONES[card.tone] || TONES.teal;
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [format, setFormat] = useState('xlsx');
  const [filters, setFilters] = useState({});
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [msg, setMsg] = useState(null);
  const [reauthOpen, setReauthOpen] = useState(false);

  const setRange = (n) => { setFrom(daysAgo(n - 1)); setTo(today()); };

  const buildBody = (extra = {}) => (
    card.needsRange ? { format, from, to, filters, ...extra } : { format, ...extra }
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

  // Public "Generate" button → ALWAYS prompts for password first.
  const generate = useCallback(() => {
    setMsg(null);
    setReauthOpen(true);
  }, []);

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
    <div className={`bg-slate-900/60 border ${tone.ring} rounded-xl p-4 flex flex-col gap-3`}>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${tone.bg} ${tone.fg}`}>
          <i className={`ph ${card.icon} text-xl`} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white">{card.title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{card.blurb}</p>
        </div>
      </div>

      {card.needsRange && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRange(n)}
                className="px-2 py-0.5 text-[10px] font-medium rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500"
              >
                Last {n}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-0.5 w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
              />
            </label>
            <label className="text-[10px] uppercase tracking-wide text-slate-500">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-0.5 w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
              />
            </label>
          </div>
        </>
      )}

      {card.filters?.includes('class') && (
        <input
          type="text"
          placeholder="Homeroom (optional, e.g. 4A)"
          value={filters.class || ''}
          onChange={(e) => setFilters((f) => ({ ...f, class: e.target.value }))}
          className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
        />
      )}
      {card.filters?.includes('status') && (
        <select
          value={filters.status || ''}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
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
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
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
          onChange={(e) => setFilters((f) => ({ ...f, kind: e.target.value }))}
          className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
        />
      )}

      <div className="flex items-center justify-between gap-2 pt-1 mt-auto">
        <div className="flex items-center gap-1">
          {fmtPills({ value: format, onChange: setFormat, disabled: busy || previewing })}
        </div>
        <div className="flex items-center gap-1.5">
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
              : (<><i className="ph ph-download-simple" /> Generate</>)}
          </button>
        </div>
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
        />
      )}

      <ReauthModal
        open={reauthOpen}
        title="Confirm download"
        action={`download the ${card.title.toLowerCase()}`}
        onCancel={() => setReauthOpen(false)}
        onConfirm={(token) => { setReauthOpen(false); runGenerate(token); }}
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

export default function DownloadsPage() {
  const allCards = useMemo(() => SECTIONS.flatMap((s) => s.cards), []);
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
              <h2 className="text-base font-semibold text-white">One-stop compliance desk</h2>
              <p className="text-xs text-slate-300 mt-1 max-w-2xl">
                Every export below is fully branded (BINUS cover page, theme colours, zebra striping),
                rate-limited and recorded in the audit log. Use the cards to pull the slice you need;
                switch between XLSX, PDF and CSV with one click.
              </p>
              <p className="text-[11px] text-slate-400 mt-2">
                {allCards.length} exports available · Owner &amp; Admin roles only
              </p>
            </div>
          </div>
        </div>

        {SECTIONS.map((section) => (
          <section key={section.heading} className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">{section.heading}</h2>
              <p className="text-xs text-slate-500 mt-0.5">{section.description}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {section.cards.map((c) => (<DownloadCard key={c.id} card={c} />))}
            </div>
          </section>
        ))}

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
