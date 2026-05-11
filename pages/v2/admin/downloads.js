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

function DownloadCard({ card }) {
  const tone = TONES[card.tone] || TONES.teal;
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [format, setFormat] = useState('xlsx');
  const [filters, setFilters] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const setRange = (n) => { setFrom(daysAgo(n - 1)); setTo(today()); };

  const generate = useCallback(async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(card.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card.needsRange ? { format, from, to, filters } : { format }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.error || j.message || detail; } catch {}
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
          {fmtPills({ value: format, onChange: setFormat, disabled: busy })}
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg text-white flex items-center gap-1.5 ${tone.btn} disabled:opacity-50`}
        >
          {busy
            ? (<><i className="ph ph-circle-notch animate-spin" /> Generating…</>)
            : (<><i className="ph ph-download-simple" /> Generate</>)}
        </button>
      </div>

      {msg && (
        <div className={`text-[11px] rounded px-2 py-1 ${
          msg.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
        }`}>
          {msg.text}
        </div>
      )}
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

      <div className="space-y-8">
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
    </AdminLayout>
  );
}
