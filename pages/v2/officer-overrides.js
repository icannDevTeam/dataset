/**
 * /v2/officer-overrides
 *
 * Admin surface for the officer-override workflow (#16).
 *
 *   - Live "Pending" panel: any flagged event from the last 10 minutes that
 *     still has its 6-digit overrideCode unused. Officers + admins can punch
 *     the code into the inline pad to approve.
 *   - History panel: every officer_override security_incident from the last
 *     N days, with who approved, when, gate and chaperone.
 *
 * This is the desk-side companion to the mobile /pickup/officer pad.
 */
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';

const GATE_POLL_MS = 6000;

const POLL_MS = 4000;
const DECISION_LABEL = {
  unknown_chaperone: 'Unknown chaperone',
  suspended: 'Suspended chaperone',
  reenroll_overdue: 'Re-enrollment overdue',
};
const DECISION_TONE = {
  unknown_chaperone: 'red',
  suspended: 'red',
  reenroll_overdue: 'amber',
};

function fmtAge(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!t) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-GB', { hour12: false });
}

export default function OfficerOverridesPage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(() => {
    setLoading(true);
    fetch(`/api/pickup/admin/officer-overrides-list?days=${days}`)
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
        else { setData(j); setErr(null); }
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  // Initial + poll
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Tick for "Xs ago"
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ─── Gate Control ───────────────────────────────────────────────────
  const [gate, setGate] = useState(null);   // API response
  const [gateBusy, setGateBusy] = useState(null); // profileId or '__global'
  const [gateErr, setGateErr] = useState(null);

  const refreshGate = useCallback(() => {
    fetch('/api/pickup/admin/gate-control', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (j.ok) setGate(j); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshGate();
    const t = setInterval(refreshGate, GATE_POLL_MS);
    return () => clearInterval(t);
  }, [refreshGate]);

  async function setGateOverride(profileId, val) {
    setGateErr(null);
    try {
      const busyKey = profileId || '__global';
      setGateBusy(busyKey);
      const r = await fetch('/api/pickup/admin/gate-control', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, gateOverride: val }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      refreshGate();
    } catch (e) { setGateErr(e.message); }
    finally { setGateBusy(null); }
  }

  return (
    <>
      <Head><title>Officer Overrides · BINUSFace</title></Head>
      <V2Layout>
        <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[90rem] mx-auto">
          {/* Header */}
          <div className="flex items-end justify-between flex-wrap gap-3 mb-5">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                <i className="ph ph-shield-check text-emerald-400"></i>
                Officer Overrides
              </h1>
              <p className="text-sm text-slate-400 mt-1">
                Admin desk for approving flagged pickups. Anything red or yellow on the
                TV displays a 6-digit code — punch it here (or on /pickup/officer)
                to release the chaperone.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {[7, 14, 30].map((d) => (
                <button key={d} onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                    days === d
                      ? 'bg-brand-500 border-brand-400 text-white'
                      : 'bg-white/5 border-slate-800 text-slate-300 hover:bg-white/10'
                  }`}>{d}d history</button>
              ))}
              <button onClick={refresh}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border bg-white/5 border-slate-800 text-slate-300 hover:bg-white/10">
                <i className="ph ph-arrows-clockwise"></i> Refresh
              </button>
            </div>
          </div>

          {err && (
            <div className="mb-4 px-4 py-3 rounded-lg border border-red-500/40 bg-red-500/10 text-red-200 text-sm">
              {err}
            </div>
          )}

          {/* ── Gate Control Panel ───────────────────────────────────────── */}
          <GateControlPanel gate={gate} busy={gateBusy} err={gateErr} onSet={setGateOverride} />

          {/* Stat strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <Stat label="Awaiting officer" value={data?.pending?.length ?? '—'} tone="amber" icon="ph-hourglass-medium" />
            <Stat label="Approved (window)" value={data?.history?.length ?? '—'} tone="emerald" icon="ph-check-circle" />
            <Stat label="History window" value={`${days} days`} tone="slate" icon="ph-clock-counter-clockwise" />
            <Stat label="Live refresh" value={`${POLL_MS / 1000}s`} tone="brand" icon="ph-broadcast" />
          </div>

          {/* Quick override pad */}
          <QuickOverridePad onSuccess={refresh} />

          {/* Pending */}
          <Section
            title="Awaiting officer (last 10 minutes)"
            icon="ph-hourglass-medium"
            tone="amber"
            count={data?.pending?.length ?? 0}>
            {(!data || loading) && !data?.pending && (
              <div className="text-slate-400 text-sm py-6 text-center">Loading…</div>
            )}
            {data?.pending?.length === 0 && (
              <div className="text-slate-400 text-sm py-6 text-center">
                <i className="ph ph-check-circle text-emerald-400 mr-2"></i>
                No flagged pickups waiting. Gate is calm.
              </div>
            )}
            {data?.pending?.length > 0 && (
              <ul className="divide-y divide-slate-800/60">
                {data.pending.map((p) => (
                  <PendingRow key={p.id} ev={p} now={now} onSuccess={refresh} />
                ))}
              </ul>
            )}
          </Section>

          {/* History */}
          <Section
            title={`Approved history (last ${days} days)`}
            icon="ph-clock-counter-clockwise"
            tone="emerald"
            count={data?.history?.length ?? 0}>
            {data?.history?.length === 0 && (
              <div className="text-slate-400 text-sm py-6 text-center">
                No officer overrides recorded in this window.
              </div>
            )}
            {data?.history?.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-400 uppercase tracking-wider">
                    <tr className="border-b border-slate-800">
                      <th className="text-left font-semibold py-2 pr-3">When</th>
                      <th className="text-left font-semibold py-2 pr-3">Chaperone</th>
                      <th className="text-left font-semibold py-2 pr-3">Gate</th>
                      <th className="text-left font-semibold py-2 pr-3">Approved by</th>
                      <th className="text-left font-semibold py-2 pr-3">Note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {data.history.map((h) => (
                      <tr key={h.id} className="text-slate-200">
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <div>{fmtDateTime(h.createdAt)}</div>
                          <div className="text-xs text-slate-500">{fmtAge(h.createdAt)}</div>
                        </td>
                        <td className="py-2 pr-3">
                          <div className="font-medium">{h.chaperoneName || '—'}</div>
                          <div className="text-xs text-slate-500 font-mono">{h.employeeNo || '—'}</div>
                        </td>
                        <td className="py-2 pr-3 text-slate-300">{h.gate || '—'}</td>
                        <td className="py-2 pr-3 text-emerald-300">{h.override?.by || '—'}</td>
                        <td className="py-2 pr-3 text-slate-400 italic max-w-md truncate">
                          {h.override?.note || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      </V2Layout>
    </>
  );
}

// ─── Components ─────────────────────────────────────────────────────────

function Stat({ label, value, tone = 'slate', icon }) {
  const toneRing = {
    amber: 'border-amber-500/30 bg-amber-500/5',
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
    red: 'border-red-500/30 bg-red-500/5',
    brand: 'border-brand-500/30 bg-brand-500/5',
    slate: 'border-slate-700/40 bg-white/5',
  }[tone];
  const toneIcon = {
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
    red: 'text-red-400',
    brand: 'text-brand-400',
    slate: 'text-slate-400',
  }[tone];
  return (
    <div className={`rounded-xl border ${toneRing} px-4 py-3`}>
      <div className="text-xs text-slate-400 flex items-center gap-2">
        {icon && <i className={`ph ${icon} ${toneIcon}`}></i>}
        {label}
      </div>
      <div className="text-2xl font-bold text-white mt-1">{value}</div>
    </div>
  );
}

function Section({ title, icon, tone, count, children }) {
  const toneIcon = {
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
    red: 'text-red-400',
    slate: 'text-slate-400',
  }[tone || 'slate'];
  return (
    <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2 text-white font-semibold">
          {icon && <i className={`ph ${icon} ${toneIcon}`}></i>}
          {title}
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">
          {count}
        </span>
      </div>
      <div className="p-2 sm:p-4">{children}</div>
    </div>
  );
}

function PendingRow({ ev, now, onSuccess }) {
  const tone = DECISION_TONE[ev.decision] || 'slate';
  const dot = {
    red: 'bg-red-500', amber: 'bg-amber-500', slate: 'bg-slate-500',
  }[tone];
  return (
    <li className="flex items-center gap-3 sm:gap-4 py-3 px-2">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot} animate-pulse shrink-0`}></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-white truncate">{ev.chaperoneName || '—'}</span>
          <span className={`text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded ${
            tone === 'red' ? 'bg-red-500/20 text-red-300'
            : tone === 'amber' ? 'bg-amber-500/20 text-amber-300'
            : 'bg-slate-700 text-slate-300'
          }`}>
            {DECISION_LABEL[ev.decision] || ev.decision}
          </span>
        </div>
        <div className="text-xs text-slate-400 mt-0.5">
          <span className="inline-block mr-3">{ev.gate || '—'}</span>
          <span className="inline-block mr-3">{fmtAge(ev.recordedAt)}</span>
          {ev.students?.length > 0 && (
            <span className="inline-block">→ {ev.students.slice(0, 3).join(', ')}{ev.students.length > 3 ? ` +${ev.students.length - 3}` : ''}</span>
          )}
        </div>
      </div>
      <div className="font-mono font-bold text-2xl tracking-[0.2em] text-white bg-slate-800 px-3 py-1 rounded-md select-all hidden sm:block">
        {ev.overrideCode}
      </div>
      <ApproveButton code={ev.overrideCode} onSuccess={onSuccess} />
    </li>
  );
}

function ApproveButton({ code, onSuccess }) {
  const [open, setOpen] = useState(false);
  const [officer, setOfficer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Pre-fill officer from localStorage so admin desk doesn't retype
  useEffect(() => {
    try {
      const stored = localStorage.getItem('pgtv_officer_name');
      if (stored) setOfficer(stored);
    } catch {}
  }, [open]);

  async function submit() {
    if (officer.trim().length < 2) {
      setErr('Officer name required');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      try { localStorage.setItem('pgtv_officer_name', officer.trim()); } catch {}
      const r = await fetch('/api/pickup/admin/officer-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, officer: officer.trim(), note: note.trim() || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setOpen(false);
      setNote('');
      onSuccess?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white shrink-0">
        Approve
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1 items-stretch w-full sm:w-auto sm:flex-row sm:items-center bg-slate-800 p-2 rounded-lg">
      <input value={officer} onChange={(e) => setOfficer(e.target.value)}
        placeholder="Your name"
        className="px-2 py-1 text-xs rounded bg-slate-900 border border-slate-700 text-white w-full sm:w-32" />
      <input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="px-2 py-1 text-xs rounded bg-slate-900 border border-slate-700 text-white w-full sm:w-48" />
      <div className="flex gap-1">
        <button disabled={busy} onClick={submit}
          className="px-2.5 py-1 text-xs font-semibold rounded bg-emerald-500 hover:bg-emerald-400 text-white disabled:opacity-50">
          {busy ? '…' : 'OK'}
        </button>
        <button onClick={() => { setOpen(false); setErr(''); }}
          className="px-2 py-1 text-xs rounded bg-slate-700 text-slate-300">
          ✕
        </button>
      </div>
      {err && <span className="text-[10px] text-red-300 sm:ml-2 sm:self-center">{err}</span>}
    </div>
  );
}

function QuickOverridePad({ onSuccess }) {
  const [code, setCode] = useState('');
  const [officer, setOfficer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {type:'ok'|'err', text}

  useEffect(() => {
    try {
      const stored = localStorage.getItem('pgtv_officer_name');
      if (stored) setOfficer(stored);
    } catch {}
  }, []);

  async function submit(e) {
    e?.preventDefault?.();
    if (!/^\d{6}$/.test(code)) {
      setMsg({ type: 'err', text: 'Code must be 6 digits' });
      return;
    }
    if (officer.trim().length < 2) {
      setMsg({ type: 'err', text: 'Officer name required' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      try { localStorage.setItem('pgtv_officer_name', officer.trim()); } catch {}
      const r = await fetch('/api/pickup/admin/officer-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, officer: officer.trim(), note: note.trim() || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setMsg({ type: 'ok', text: `Approved · ${j.chaperone || 'event'} at ${j.gate || ''}` });
      setCode('');
      setNote('');
      onSuccess?.();
    } catch (e2) {
      setMsg({ type: 'err', text: e2.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
      <div className="flex-1 min-w-0">
        <label className="block text-xs text-slate-400 mb-1">6-digit code from TV</label>
        <input value={code} maxLength={6} inputMode="numeric"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white font-mono text-2xl tracking-[0.4em] text-center" />
      </div>
      <div className="sm:w-44">
        <label className="block text-xs text-slate-400 mb-1">Officer name</label>
        <input value={officer} onChange={(e) => setOfficer(e.target.value)}
          placeholder="Your name"
          className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white" />
      </div>
      <div className="sm:w-64">
        <label className="block text-xs text-slate-400 mb-1">Note (optional)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. ID verified"
          className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white" />
      </div>
      <button type="submit" disabled={busy}
        className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white font-semibold disabled:opacity-50 shrink-0">
        {busy ? 'Approving…' : 'Approve'}
      </button>
      {msg && (
        <div className={`text-xs sm:ml-3 sm:self-center ${
          msg.type === 'ok' ? 'text-emerald-300' : 'text-red-300'
        }`}>
          {msg.text}
        </div>
      )}
    </form>
  );
}

// ─── Gate Control Panel ────────────────────────────────────────────────────
function GateControlPanel({ gate, busy, err, onSet }) {
  if (!gate) {
    return (
      <div className="mb-6 rounded-2xl border border-slate-800 bg-white/5 px-5 py-4 animate-pulse">
        <div className="h-5 w-40 bg-slate-700 rounded" />
      </div>
    );
  }

  const profiles = gate.profiles || [];
  const openCount = profiles.filter((p) => p.effective?.open).length;
  const closedCount = Math.max(0, profiles.length - openCount);

  return (
    <div className="mb-6 rounded-2xl border border-slate-700/70 bg-slate-950/70 px-5 py-4">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-3">
          <i className="ph ph-door-open text-2xl text-brand-300" />
          <div>
            <div className="text-lg font-bold text-white">Gate Control (Per Claimed Gate)</div>
            <div className="text-xs text-slate-400">
              Open/Close now applies to a specific kiosk profile so security can target exactly which claimed gate to override.
            </div>
          </div>
        </div>
        <div className="text-xs text-slate-300 bg-white/5 border border-slate-700 rounded-lg px-3 py-1.5">
          Open: <span className="text-emerald-300 font-semibold">{openCount}</span>
          <span className="mx-2 text-slate-500">|</span>
          Closed: <span className="text-red-300 font-semibold">{closedCount}</span>
        </div>
      </div>

      {profiles.length === 0 && (
        <div className="text-xs text-slate-400">No kiosk profiles found.</div>
      )}

      {profiles.length > 0 && (
        <div className="space-y-2">
          {profiles.map((p) => {
            const effOpen = !!p.effective?.open;
            const sched = p.scheduled || {};
            const override = p.override || null;
            const isBusy = busy === p.id;
            return (
              <div
                key={p.id}
                className={`rounded-xl border px-3 py-3 ${
                  effOpen
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : 'border-red-500/30 bg-red-500/5'
                }`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2">
                      <i className={`ph ${effOpen ? 'ph-door-open text-emerald-300' : 'ph-door text-red-300'}`} />
                      <span className="font-semibold text-white">{p.name}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-bold ${
                        effOpen ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
                      }`}>
                        {effOpen ? 'Open' : 'Closed'}
                      </span>
                      {override && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          Manual
                        </span>
                      )}
                    </div>

                    <div className="text-[11px] text-slate-400 mt-1">
                      Claimed gate(s): {(p.gates || []).length ? p.gates.join(', ') : 'All gates'}
                    </div>

                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Schedule: {sched.configured ? `${sched.opensAt} - ${sched.closesAt}` : 'No schedule (always open)'}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      disabled={!!busy || (override === 'open')}
                      onClick={() => onSet(p.id, 'open')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/35 disabled:opacity-50"
                    >
                      <i className="ph ph-door-open mr-1" />
                      {isBusy ? 'Applying…' : 'Open'}
                    </button>
                    <button
                      disabled={!!busy || (override === 'closed')}
                      onClick={() => onSet(p.id, 'closed')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/35 disabled:opacity-50"
                    >
                      <i className="ph ph-door mr-1" />
                      {isBusy ? 'Applying…' : 'Close'}
                    </button>
                    <button
                      disabled={!!busy || !override}
                      onClick={() => onSet(p.id, null)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 text-slate-300 border border-slate-700 hover:bg-white/10 disabled:opacity-50"
                    >
                      Schedule
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {err && (
        <p className="mt-3 text-xs text-red-400">{err}</p>
      )}
    </div>
  );
}
