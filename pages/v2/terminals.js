/**
 * /v2/terminals — Hikvision face-terminal registry, modern card view.
 *
 * Each terminal is a hero card with:
 *  - Color-coded gate state (emerald=open, rose=closed, slate=disabled,
 *    amber=manual override).
 *  - One-tap Open / Auto / Close.
 *  - Inline edit for grade/gate label, release-group binding, and the
 *    daily WIB pickup window.
 *  - Live "last seen" + auto-synced from backend/devices.json on listener
 *    startup.
 */
import Head from 'next/head';
import { useEffect, useState, useCallback, useMemo } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import TerminalAddModal from '../../components/v2/terminals/TerminalAddModal';
import TerminalRenameModal from '../../components/v2/terminals/TerminalRenameModal';

// Compute effective gate state in WIB, mirroring lib/terminal-gate.js so the
// card can show what the relay is actually doing without a round-trip.
function computeEffective(t, now) {
  const override = t.gateOverride === 'open' || t.gateOverride === 'closed' ? t.gateOverride : null;
  const parse = (s) => /^\d{2}:\d{2}$/.test(s || '')
    ? (parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3), 10))
    : null;
  const o = parse(t.windowOpen), c = parse(t.windowClose);
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const cur = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  let scheduledOpen = true, configured = false;
  if (o != null && c != null) {
    configured = true;
    scheduledOpen = o <= c ? (cur >= o && cur <= c) : (cur >= o || cur <= c);
  }
  if (override === 'closed') return { open: false, reason: 'manual close', override, configured };
  if (override === 'open')   return { open: true,  reason: 'manual open',  override, configured };
  if (configured)            return { open: scheduledOpen, reason: scheduledOpen ? 'in window' : 'out of window', override: null, configured };
  return { open: true, reason: 'always open', override: null, configured: false };
}

function relativeTime(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function TerminalsPage() {
  const [terminals, setTerminals] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});
  const [drafts, setDrafts] = useState({});
  const [now, setNow] = useState(() => new Date());
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [renaming, setRenaming] = useState(null); // terminal object or null
  const [showLockedWindow, setShowLockedWindow] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, gRes] = await Promise.all([
        fetch('/api/pickup/admin/terminals', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/pickup/admin/release-groups', { credentials: 'include' }).then((r) => r.json()),
      ]);
      if (!tRes.ok) throw new Error(tRes.error || 'failed loading terminals');
      setTerminals(tRes.terminals || []);
      setGroups(gRes.groups || []);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { const t = setInterval(reload, 20000); return () => clearInterval(t); }, [reload]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const showToast = (kind, message, ttl = 3500) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), ttl);
  };

  const setDraft = (id, patch) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));

  const discardDraft = (id) =>
    setDrafts((prev) => { const n = { ...prev }; delete n[id]; return n; });

  const save = async (id) => {
    const patch = drafts[id];
    if (!patch || Object.keys(patch).length === 0) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'save failed');
      discardDraft(id);
      showToast('success', 'Terminal updated.');
      await reload();
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const setGate = async (id, value) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateOverride: value }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      showToast('success', value === null ? 'Switched to Auto.' : `Forced ${value}.`);
      await reload();
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const toggleEnabled = async (t) => {
    if (t.enabled !== false && !confirm(`Disable "${t.name}"? It will stop serving feeds and kiosks until re-enabled.`)) return;
    setBusy((b) => ({ ...b, [t.id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${t.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: t.enabled === false }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      showToast('success', t.enabled === false ? 'Terminal enabled.' : 'Terminal disabled.');
      await reload();
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setBusy((b) => ({ ...b, [t.id]: false }));
    }
  };

  const archiveTerminal = async (t) => {
    if (!confirm(`Archive "${t.name}"? It will remain in history but stop running.`)) return;
    setBusy((b) => ({ ...b, [t.id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${t.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'archive failed');
      showToast('warn', 'Terminal archived.');
      await reload();
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setBusy((b) => ({ ...b, [t.id]: false }));
    }
  };

  const hardDeleteTerminal = async (t) => {
    if (!confirm(`Delete "${t.name}" permanently? This cannot be undone.`)) return;
    if (!confirm('Final confirmation: permanently delete this terminal record?')) return;
    setBusy((b) => ({ ...b, [t.id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${t.id}&hard=1`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'delete failed');
      showToast('warn', 'Terminal permanently deleted.');
      await reload();
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setBusy((b) => ({ ...b, [t.id]: false }));
    }
  };

  // Effective state, filtered + searched.
  const decorated = useMemo(() => terminals.map((t) => ({ t, eff: computeEffective(t, now) })), [terminals, now]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return decorated.filter(({ t, eff }) => {
      if (q) {
        const hay = [t.name, t.ip, t.gradeLabel, t.gateLabel, t.id].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter === 'open')      return t.enabled !== false && eff.open;
      if (filter === 'closed')    return t.enabled !== false && !eff.open;
      if (filter === 'manual')    return t.enabled !== false && !!eff.override;
      if (filter === 'down')      return t.healthStatus === 'down';
      if (filter === 'disabled')  return t.enabled === false;
      if (filter === 'unbound')   return !t.releaseGroupId;
      return true;
    });
  }, [decorated, filter, search]);

  const stats = useMemo(() => {
    let total = 0, open = 0, closed = 0, down = 0, disabled = 0, manual = 0, unbound = 0;
    decorated.forEach(({ t, eff }) => {
      total++;
      if (t.enabled === false) { disabled++; return; }
      if (t.healthStatus === 'down') down++;
      if (eff.open) open++; else closed++;
      if (eff.override) manual++;
      if (!t.releaseGroupId) unbound++;
    });
    return { total, open, closed, down, disabled, manual, unbound };
  }, [decorated]);

  return (
    <V2Layout>
      <Head><title>Hikvision Terminals · Pickup System</title></Head>

      <div className="space-y-5">
        {/* Hero header */}
        <div className="rounded-2xl border border-brand-500/20 bg-gradient-to-br from-brand-500/10 via-slate-900/40 to-slate-900/40 p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center flex-shrink-0">
                <i className="ph ph-cpu text-brand-300 text-2xl"></i>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">Hikvision Terminals</h1>
                <p className="text-sm text-slate-300 mt-1 max-w-2xl">
                  Source of truth is Firestore terminal registry.
                  Bind a release group, set a daily pickup window, or force-open / force-close. Manual override always wins.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowAdd(true)}
                className="px-3 py-2 text-sm rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold border border-emerald-400 shadow-md shadow-emerald-500/20">
                <i className="ph ph-plus mr-1"></i>Add terminal
              </button>
              <button onClick={reload} disabled={loading}
                className="px-3 py-2 text-sm rounded-lg bg-slate-800/70 border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                <i className={`ph ph-arrows-clockwise ${loading ? 'animate-spin' : ''} mr-1`}></i>Refresh
              </button>
            </div>
          </div>
        </div>

        {/* Stat cards (clickable filters) */}
        <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
          <StatCard active={filter === 'all'}      onClick={() => setFilter('all')}      label="Total"     value={stats.total}    icon="ph-cpu"          tone="slate" />
          <StatCard active={filter === 'open'}     onClick={() => setFilter('open')}     label="Open now"  value={stats.open}     icon="ph-door-open"    tone="emerald" />
          <StatCard active={filter === 'closed'}   onClick={() => setFilter('closed')}   label="Closed"    value={stats.closed}   icon="ph-door"         tone="rose" />
          <StatCard active={filter === 'down'}     onClick={() => setFilter('down')}     label="Down"      value={stats.down}     icon="ph-plug"         tone="rose" />
          <StatCard active={filter === 'manual'}   onClick={() => setFilter('manual')}   label="Manual"    value={stats.manual}   icon="ph-hand-tap"     tone="amber" />
          <StatCard active={filter === 'unbound'}  onClick={() => setFilter('unbound')}  label="No group"  value={stats.unbound}  icon="ph-link-break"   tone="violet" />
          <StatCard active={filter === 'disabled'} onClick={() => setFilter('disabled')} label="Disabled"  value={stats.disabled} icon="ph-prohibit"     tone="zinc" />
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-900/40 border border-slate-800">
          <div className="relative flex-1 min-w-[200px]">
            <i className="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm"></i>
            <input
              placeholder="Search by name, IP, label…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-xs pl-8 pr-3 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-slate-200 placeholder-slate-500"
            />
          </div>
          {filter !== 'all' && (
            <button onClick={() => setFilter('all')}
              className="text-xs px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700">
              Clear filter
            </button>
          )}
        </div>

        {/* Body */}
        {err && (
          <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
            <i className="ph ph-warning-circle mr-1"></i>{err}
          </div>
        )}
        {!err && loading && terminals.length === 0 && (
          <div className="p-12 text-center text-slate-500">
            <i className="ph ph-spinner-gap animate-spin text-3xl"></i>
            <div className="mt-2 text-sm">Loading terminals…</div>
          </div>
        )}
        {!err && !loading && visible.length === 0 && (
          <div className="p-16 text-center rounded-xl bg-slate-900/40 border border-slate-800">
            <i className="ph ph-cpu text-5xl text-slate-600"></i>
            <div className="mt-3 text-base font-semibold text-slate-300">
              {terminals.length === 0 ? 'No terminals registered yet' : 'Nothing matches the filters'}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {terminals.length === 0
                ? <>No terminal docs found in Firestore yet. Add a terminal from this page or run listener bootstrap once.</>
                : 'Try clearing the search or filter.'}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {visible.map(({ t, eff }) => (
            <TerminalCard
              key={t.id}
              t={t}
              eff={eff}
              groups={groups}
              draft={drafts[t.id] || {}}
              busy={!!busy[t.id]}
              onDraft={(p) => setDraft(t.id, p)}
              onDiscard={() => discardDraft(t.id)}
              onSave={() => save(t.id)}
              onGate={(v) => setGate(t.id, v)}
              onToggleEnabled={() => toggleEnabled(t)}
              onArchive={() => archiveTerminal(t)}
              onDelete={() => hardDeleteTerminal(t)}
              onRename={() => setRenaming(t)}
              onLockedWindow={() => setShowLockedWindow(true)}
            />
          ))}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-2xl border text-sm max-w-sm ${
          toast.kind === 'success' ? 'bg-emerald-500/95 border-emerald-400 text-white'
          : toast.kind === 'warn'  ? 'bg-amber-500/95 border-amber-400 text-white'
          : 'bg-rose-500/95 border-rose-400 text-white'
        }`}>
          <i className={`ph ${
            toast.kind === 'success' ? 'ph-check-circle' :
            toast.kind === 'warn'    ? 'ph-warning' : 'ph-x-circle'
          } mr-2`}></i>
          {toast.message}
        </div>
      )}

      {/* Add modal */}
      <TerminalAddModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onCreated={(t) => {
          showToast('success', `Terminal "${t?.name || 'new'}" created.`);
          reload();
        }}
      />

      {/* Rename modal */}
      <TerminalRenameModal
        open={!!renaming}
        terminal={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={(t) => {
          showToast('success', `Renamed to "${t?.name || ''}".`);
          reload();
        }}
      />

      {/* Locked-pickup-window popup */}
      {showLockedWindow && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
          onClick={() => setShowLockedWindow(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl overflow-hidden"
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-800 bg-amber-500/5">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
                <i className="ph ph-lock-simple-fill text-xl text-amber-300"></i>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Pickup window is locked</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">Manual entries are protected to prevent dismissal-time errors.</p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-3 text-sm text-slate-300">
              <p>
                The open and close times for each terminal are set centrally in
                <span className="text-white font-semibold"> Pickup Settings</span> and
                cannot be changed from this page.
              </p>
              <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2.5 text-xs text-slate-300">
                <i className="ph ph-phone-call text-amber-300 mr-1"></i>
                Please contact <span className="text-white font-semibold">ACOP</span> for this feature to be activated or modified.
              </div>
            </div>
            <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/40 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowLockedWindow(false)}
                className="text-xs px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </V2Layout>
  );
}

// ── Stat card (clickable filter pill) ─────────────────────────────────
function StatCard({ label, value, icon, tone, active, onClick }) {
  const tones = {
    slate:   { bg: 'from-slate-800/40 to-slate-900/40',    border: 'border-slate-800',         text: 'text-slate-300',   activeBorder: 'border-slate-500' },
    emerald: { bg: 'from-emerald-500/10 to-emerald-900/10', border: 'border-emerald-500/30',   text: 'text-emerald-300', activeBorder: 'border-emerald-400' },
    rose:    { bg: 'from-rose-500/10 to-rose-900/10',       border: 'border-rose-500/30',      text: 'text-rose-300',    activeBorder: 'border-rose-400' },
    amber:   { bg: 'from-amber-500/10 to-amber-900/10',     border: 'border-amber-500/30',     text: 'text-amber-300',   activeBorder: 'border-amber-400' },
    violet:  { bg: 'from-violet-500/10 to-violet-900/10',   border: 'border-violet-500/30',    text: 'text-violet-300',  activeBorder: 'border-violet-400' },
    zinc:    { bg: 'from-zinc-700/30 to-zinc-900/30',       border: 'border-zinc-700/50',      text: 'text-zinc-400',    activeBorder: 'border-zinc-500' },
  };
  const c = tones[tone] || tones.slate;
  return (
    <button onClick={onClick}
      className={`text-left rounded-xl bg-gradient-to-br border p-3 transition-all hover:scale-[1.02] ${
        c.bg} ${c.text} ${active ? `${c.activeBorder} ring-2 ring-offset-2 ring-offset-slate-950 ring-current/30` : c.border
      }`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider opacity-80 font-semibold">{label}</span>
        <i className={`ph ${icon} text-base opacity-60`}></i>
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </button>
  );
}

// ── Terminal card ─────────────────────────────────────────────────────
function TerminalCard({ t, eff, groups, draft, busy, onDraft, onDiscard, onSave, onGate, onToggleEnabled, onArchive, onDelete, onRename, onLockedWindow }) {
  const dirty = Object.keys(draft).length > 0;
  const disabled = t.enabled === false;
  const isDown = t.healthStatus === 'down';
  const isUnknown = t.healthStatus === 'unknown';
  const listenerKnown = typeof t.listenerRunning === 'boolean';
  const lastSeen = relativeTime(t.lastSeenAt);
  const overrideAt = relativeTime(t.gateOverrideAt);

  // Card framing (color-coded by state)
  const frame = disabled
    ? { ring: 'border-zinc-700', glow: 'from-zinc-700/10 to-zinc-900/20', halo: 'bg-zinc-700' }
    : isDown
      ? { ring: 'border-red-500/50', glow: 'from-red-500/15 to-slate-900/40', halo: 'bg-red-500' }
    : eff.open
      ? { ring: 'border-emerald-500/40', glow: 'from-emerald-500/10 to-slate-900/40', halo: 'bg-emerald-500' }
      : { ring: 'border-rose-500/40',    glow: 'from-rose-500/10 to-slate-900/40',    halo: 'bg-rose-500' };

  const effectiveGroup = draft.releaseGroupId !== undefined ? draft.releaseGroupId : t.releaseGroupId;
  const groupName = (id) => groups.find((g) => g.id === id)?.name || null;

  return (
    <div className={`relative rounded-2xl border ${frame.ring} bg-gradient-to-br ${frame.glow} overflow-hidden`}>
      {/* Top status bar (color stripe) */}
      <div className={`h-1 w-full ${frame.halo}`}></div>

      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex items-start gap-3">
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
          disabled ? 'bg-zinc-700/30 text-zinc-400'
          : eff.open ? 'bg-emerald-500/20 text-emerald-300'
          : 'bg-rose-500/20 text-rose-300'
        }`}>
          <i className={`ph ${disabled ? 'ph-prohibit' : eff.open ? 'ph-door-open' : 'ph-door'} text-2xl`}></i>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-bold text-white truncate" title={t.name}>{t.name}</h3>
            {disabled ? (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider bg-zinc-700/50 text-zinc-300 border border-zinc-600">Disabled</span>
            ) : (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                eff.open ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
              }`}>
                {eff.open ? 'Open' : 'Closed'}
              </span>
            )}
            {isDown && !disabled && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider bg-red-500/20 text-red-300 border border-red-500/40 inline-flex items-center gap-1">
                <i className="ph ph-plug"></i>Down
              </span>
            )}
            {!disabled && listenerKnown && (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider inline-flex items-center gap-1 ${
                t.listenerRunning
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-red-500/20 text-red-300 border border-red-500/40'
              }`}>
                <i className={`ph ${t.listenerRunning ? 'ph-play-circle' : 'ph-stop-circle'}`}></i>
                Listener {t.listenerRunning ? 'On' : 'Off'}
              </span>
            )}
            {isUnknown && !disabled && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider bg-slate-600/30 text-slate-300 border border-slate-600 inline-flex items-center gap-1">
                <i className="ph ph-question"></i>No heartbeat
              </span>
            )}
            {eff.override && !disabled && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 inline-flex items-center gap-0.5">
                <i className="ph ph-hand-tap"></i>Manual
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
            <span className="font-mono"><i className="ph ph-globe text-slate-500 mr-0.5"></i>{t.ip || '—'}</span>
            {lastSeen && (
              <span className="text-slate-500">
                <i className="ph ph-clock-clockwise mr-0.5"></i>seen {lastSeen}
              </span>
            )}
            {!lastSeen && (
              <span className="text-slate-600">
                <i className="ph ph-clock mr-0.5"></i>never seen
              </span>
            )}
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5 font-mono truncate" title={t.id}>id: {t.id}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRename}
            disabled={busy}
            title="Rename terminal"
            className="p-1.5 rounded-md text-xs bg-slate-800/60 text-slate-400 border border-slate-700 hover:text-brand-300 hover:bg-brand-500/10 hover:border-brand-500/30 disabled:opacity-50"
          >
            <i className="ph ph-pencil-simple"></i>
          </button>
          <button
            onClick={onToggleEnabled}
            disabled={busy}
            title={disabled ? 'Enable terminal' : 'Disable terminal'}
            className={`p-1.5 rounded-md text-xs ${
              disabled ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25'
                       : 'bg-slate-800/60 text-slate-400 border border-slate-700 hover:text-rose-300 hover:bg-rose-500/10 hover:border-rose-500/30'
            } disabled:opacity-50`}
          >
            <i className={`ph ${disabled ? 'ph-power' : 'ph-prohibit'}`}></i>
          </button>
          <button
            onClick={onArchive}
            disabled={busy || disabled}
            title="Archive terminal"
            className="p-1.5 rounded-md text-xs bg-slate-800/60 text-slate-400 border border-slate-700 hover:text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/30 disabled:opacity-50"
          >
            <i className="ph ph-archive-box"></i>
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            title="Delete terminal permanently"
            className="p-1.5 rounded-md text-xs bg-slate-800/60 text-slate-400 border border-slate-700 hover:text-red-300 hover:bg-red-500/10 hover:border-red-500/30 disabled:opacity-50"
          >
            <i className="ph ph-trash"></i>
          </button>
        </div>
      </div>

      {/* State summary line */}
      <div className="px-4 pb-3 text-[11px] text-slate-400 flex items-center gap-1.5">
        <i className="ph ph-info text-slate-500"></i>
        <span>State: <span className="text-slate-200 font-medium">{eff.reason}</span></span>
        {!disabled && isDown && (
          <span className="text-red-300">
            · {t.healthSource === 'listener' ? 'listener is down' : 'terminal heartbeat is down'}
          </span>
        )}
        {!disabled && listenerKnown && t.listenerPid && (
          <span className="text-slate-500">· PID {t.listenerPid}</span>
        )}
        {!disabled && listenerKnown && t.listenerUptime && (
          <span className="text-slate-600">· up {t.listenerUptime}</span>
        )}
        {overrideAt && eff.override && (
          <span className="text-slate-600">· since {overrideAt}</span>
        )}
      </div>

      {/* Gate controls (big, color-coded) */}
      <div className="px-4 pb-3">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
          <i className="ph ph-traffic-signal mr-1"></i>Gate control
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <button
            onClick={() => onGate('open')}
            disabled={busy || disabled || t.gateOverride === 'open'}
            title="Force open (overrides schedule)"
            className={`px-2 py-2 rounded-lg text-xs font-semibold border transition ${
              t.gateOverride === 'open'
                ? 'bg-emerald-500 border-emerald-400 text-white shadow-md shadow-emerald-500/30'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <i className="ph ph-door-open mr-1"></i>Open
          </button>
          <button
            onClick={() => onGate(null)}
            disabled={busy || disabled || !t.gateOverride}
            title="Follow schedule"
            className={`px-2 py-2 rounded-lg text-xs font-semibold border transition ${
              !t.gateOverride
                ? 'bg-slate-700 border-slate-500 text-white shadow-md'
                : 'bg-slate-800/40 border-slate-700 text-slate-300 hover:bg-slate-800'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <i className="ph ph-clock mr-1"></i>Auto
          </button>
          <button
            onClick={() => onGate('closed')}
            disabled={busy || disabled || t.gateOverride === 'closed'}
            title="Force close (overrides schedule)"
            className={`px-2 py-2 rounded-lg text-xs font-semibold border transition ${
              t.gateOverride === 'closed'
                ? 'bg-rose-500 border-rose-400 text-white shadow-md shadow-rose-500/30'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <i className="ph ph-door mr-1"></i>Close
          </button>
        </div>
      </div>

      {/* Edit panel */}
      <div className="px-4 py-3 border-t border-slate-800/60 bg-slate-950/30 space-y-2.5">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          <i className="ph ph-pencil-simple mr-1"></i>Configuration
        </div>

        <Field
          label="Grades served"
          hint={(() => {
            const sc = draft.gradeScopes ?? t.gradeScopes ?? [];
            if (!sc || sc.length === 0) return 'All grades (shared gate)';
            return `Routes chaperones for grade${sc.length > 1 ? 's' : ''} ${sc.join(', ')} here`;
          })()}
          hintTone={((draft.gradeScopes ?? t.gradeScopes ?? []).length === 0) ? 'amber' : 'emerald'}
        >
          <GradeScopeChips
            value={draft.gradeScopes ?? t.gradeScopes ?? []}
            onChange={(next) => onDraft({ gradeScopes: next })}
          />
        </Field>

        <Field label="Gate label" hint="Display name only — e.g. PYP Lobby">
          <input
            value={draft.gateLabel ?? t.gateLabel ?? ''}
            onChange={(e) => onDraft({ gateLabel: e.target.value })}
            placeholder="—"
            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-slate-200 text-xs focus:border-brand-500 focus:outline-none"
          />
        </Field>

        <Field label="Release group" hint={!effectiveGroup ? 'Unbound — won\'t serve scheduled releases' : null} hintTone={!effectiveGroup ? 'amber' : null}>
          <select
            value={effectiveGroup || ''}
            onChange={(e) => onDraft({ releaseGroupId: e.target.value || null })}
            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-slate-200 text-xs focus:border-brand-500 focus:outline-none"
          >
            <option value="">— none —</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          {effectiveGroup && groupName(effectiveGroup) && (
            <div className="text-[10px] text-emerald-400 mt-0.5">
              <i className="ph ph-link mr-0.5"></i>Bound to {groupName(effectiveGroup)}
            </div>
          )}
        </Field>

        <Field label={<span className="flex items-center gap-1">Pickup window (WIB) <i className="ph ph-lock-simple text-[10px] text-slate-500" title="Locked — managed by ACOP"></i></span>}
          hint={
            ((draft.windowOpen ?? t.windowOpen) && (draft.windowClose ?? t.windowClose))
              ? 'Locked · managed in Pickup Settings by ACOP'
              : 'Always open · contact ACOP to enable a schedule'
          }
          hintTone={
            ((draft.windowOpen ?? t.windowOpen) && (draft.windowClose ?? t.windowClose))
              ? 'emerald' : 'slate'
          }
        >
          {/* Click-trap wrapper — any interaction triggers the lock popup. */}
          <div
            role="button"
            tabIndex={0}
            onClick={onLockedWindow}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLockedWindow?.(); } }}
            title="Locked — contact ACOP to change pickup window"
            className="relative cursor-not-allowed group"
          >
            <div className="flex items-center gap-1.5 pointer-events-none">
              <div className="flex-1 px-2 py-1.5 bg-slate-950/60 border border-slate-800 rounded text-slate-300 text-xs select-none">
                {t.windowOpen || <span className="text-slate-600">--:--</span>}
              </div>
              <span className="text-slate-600 text-xs">→</span>
              <div className="flex-1 px-2 py-1.5 bg-slate-950/60 border border-slate-800 rounded text-slate-300 text-xs select-none">
                {t.windowClose || <span className="text-slate-600">--:--</span>}
              </div>
              <i className="ph ph-lock-simple text-slate-500 text-sm ml-1"></i>
            </div>
          </div>
          <button
            type="button"
            onClick={onLockedWindow}
            className="inline-flex items-center gap-1 mt-1.5 text-[11px] text-slate-400 hover:text-slate-300"
          >
            <i className="ph ph-info"></i> Why is this locked?
          </button>
        </Field>

        {/* Save / discard */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {dirty && (
            <button
              onClick={onDiscard}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              Discard
            </button>
          )}
          <button
            onClick={onSave}
            disabled={!dirty || busy}
            className={`text-xs px-3 py-1.5 rounded-md font-semibold border ${
              dirty && !busy
                ? 'bg-brand-500 border-brand-400 text-white hover:bg-brand-600 shadow-md shadow-brand-500/20'
                : 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed'
            }`}
          >
            {busy ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Saving…</> : <><i className="ph ph-floppy-disk mr-1"></i>Save</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, hintTone, children }) {
  const hintColor = {
    emerald: 'text-emerald-400',
    amber:   'text-amber-400',
    slate:   'text-slate-500',
  }[hintTone] || 'text-slate-500';
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">{label}</label>
      {children}
      {hint && <div className={`text-[10px] mt-0.5 ${hintColor}`}>{hint}</div>}
    </div>
  );
}

// ── Grade scope multi-select chips ────────────────────────────────────
// Canonical grades: EY1–EY3 and 1–5. Empty selection = shared gate (all grades).
const GRADE_OPTIONS = ['EY1', 'EY2', 'EY3', '1', '2', '3', '4', '5'];
function GradeScopeChips({ value, onChange }) {
  const selected = new Set((value || []).map(String));
  const toggle = (g) => {
    const next = new Set(selected);
    if (next.has(g)) next.delete(g); else next.add(g);
    onChange(GRADE_OPTIONS.filter((x) => next.has(x)));
  };
  const all = selected.size === 0;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button
        type="button"
        onClick={() => onChange([])}
        title="Shared gate — every grade enrols here"
        className={`px-2 py-1 rounded text-[11px] font-semibold border transition ${
          all
            ? 'bg-amber-500/25 border-amber-400 text-amber-200'
            : 'bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-800'
        }`}
      >
        All
      </button>
      <span className="text-slate-700 text-xs">·</span>
      {GRADE_OPTIONS.map((g) => {
        const on = selected.has(g);
        return (
          <button
            key={g}
            type="button"
            onClick={() => toggle(g)}
            className={`min-w-7 h-7 px-1.5 rounded text-[11px] font-bold border transition ${
              on
                ? 'bg-brand-500 border-brand-400 text-white shadow-sm shadow-brand-500/30'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {g}
          </button>
        );
      })}
    </div>
  );
}
