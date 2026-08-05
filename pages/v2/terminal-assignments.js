import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import PageGuard from '../../components/v2/PageGuard';

function SeverityPill({ severity }) {
  const s = String(severity || '').toLowerCase();
  const cls = s === 'high'
    ? 'bg-red-500/15 border-red-500/40 text-red-300'
    : s === 'medium'
      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
      : 'bg-slate-500/15 border-slate-500/40 text-slate-300';
  return <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase ${cls}`}>{s || 'low'}</span>;
}

function formatGradeLabel(terminal) {
  const label = String(terminal?.gradeLabel || '').trim();
  if (label) return label;
  const scopes = Array.isArray(terminal?.gradeScopes) ? terminal.gradeScopes.map(String).map((s) => s.trim()).filter(Boolean) : [];
  if (scopes.length > 0) return scopes.join(', ');
  return terminal?.name || '—';
}

// Short terminal tag: "Terminal 05" → "T05".
function shortTerminalName(terminal) {
  const name = String(terminal?.name || '').trim();
  const m = name.match(/^Terminal\s+(\d+)$/i);
  if (m) return `T${m[1].padStart(2, '0')}`;
  return name || '—';
}

// Chaperone's grade tokens: '4A'→'4', 'EY3'→'EY3', 'EY'→'EY'.
function chapScopeTokens(chap) {
  const out = new Set();
  const raw = [...(chap?.studentGrades || []), ...(chap?.studentClasses || [])];
  for (const r of raw) {
    const t = String(r || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!t) continue;
    const ey = t.match(/^EY(\d*)/);
    if (ey) { out.add(ey[1] ? `EY${ey[1]}` : 'EY'); continue; }
    const num = t.match(/^(\d+)/);
    if (num) { out.add(num[1]); continue; }
    out.add(t);
  }
  return out;
}

// Which of the terminal's gradeScopes justify THIS chaperone being on it.
// e.g. Agung (EY3 kid only) on a Pole 3 terminal (EY3+3) → ['EY3'], not 'EY3, 3'.
function matchedScopesFor(chap, terminal) {
  const ts = (terminal?.gradeScopes || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  if (ts.length === 0) return [];
  const cs = chapScopeTokens(chap);
  if (cs.size === 0) return [];
  return ts.filter((t) => cs.has(t) || (cs.has('EY') && t.startsWith('EY')));
}

// Chip label: "T05 · EY3" — terminal tag + the grade(s) that matched the
// chaperone. Falls back to the terminal's own grade label (override cases).
function chipLabel(chap, terminal) {
  const matched = matchedScopesFor(chap, terminal);
  const grades = matched.length ? matched.join(', ') : formatGradeLabel(terminal);
  return `${shortTerminalName(terminal)} · ${grades}`;
}

function EditOverrideModal({ open, chaperone, terminals, onCancel, onSave, saving }) {
  const [selected, setSelected] = useState({});

  useEffect(() => {
    if (!open || !chaperone) return;
    const next = {};
    (chaperone.allowedTerminalIds || []).forEach((id) => { next[id] = true; });
    setSelected(next);
  }, [open, chaperone]);

  if (!open || !chaperone) return null;

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm p-4 flex items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800">
          <div className="text-sm font-semibold text-white">Terminal Override</div>
          <div className="text-xs text-slate-400 mt-0.5">{chaperone.name} · {chaperone.employeeNo || 'no employeeNo'}</div>
        </div>

        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-2">
          {terminals.map((t) => (
            <label key={t.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/40 hover:bg-slate-900/80 cursor-pointer">
              <input
                type="checkbox"
                checked={!!selected[t.id]}
                onChange={(e) => setSelected((s) => ({ ...s, [t.id]: e.target.checked }))}
                className="accent-brand-500"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white truncate">{t.name}{t.ip ? ` (${t.ip})` : ''}</div>
                <div className="text-[11px] text-slate-500 truncate" title={t.id}>scopes: {(t.gradeScopes || []).join(', ') || 'all'}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-2">
          <div className="text-xs text-slate-400">Selected: {selectedIds.length}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(selectedIds)}
              disabled={saving || selectedIds.length === 0}
              className="px-3 py-1.5 text-xs rounded-lg border border-brand-500/40 bg-brand-500/20 text-brand-200 hover:bg-brand-500/30 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save override'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RemoveFromTerminalsModal({ open, chaperone, terminals, onCancel, onRemove, saving }) {
  const [selected, setSelected] = useState({});

  useEffect(() => {
    if (!open || !chaperone) return;
    // Default: every terminal selected — wipes stale enrolments too.
    const next = {};
    terminals.forEach((t) => { next[t.id] = true; });
    setSelected(next);
  }, [open, chaperone, terminals]);

  if (!open || !chaperone) return null;

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const allSelected = selectedIds.length === terminals.length;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm p-4 flex items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="w-full max-w-2xl bg-slate-900 border border-red-500/40 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-slate-800">
          <div className="text-sm font-semibold text-red-300 flex items-center gap-2">
            <i className="ph ph-user-minus"></i>Remove from terminals
          </div>
          <div className="text-xs text-slate-400 mt-0.5">{chaperone.name} · {chaperone.employeeNo || 'no employeeNo'}</div>
          <div className="text-[11px] text-amber-300/90 mt-2">
            Deletes the face record AND access-control user from the selected terminals.
            The chaperone stays in the registry — re-enroll later after fixing the photo.
          </div>
        </div>

        <div className="px-5 py-2 border-b border-slate-800 flex items-center gap-2">
          <button type="button" onClick={() => { const n = {}; terminals.forEach((t) => { n[t.id] = true; }); setSelected(n); }} className="text-[11px] px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-white/5">Select all</button>
          <button type="button" onClick={() => setSelected({})} className="text-[11px] px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-white/5">Clear</button>
          <span className="text-[11px] text-slate-500">{allSelected ? 'All terminals (also clears stale enrolments)' : `${selectedIds.length} of ${terminals.length} terminals`}</span>
        </div>

        <div className="p-4 max-h-[50vh] overflow-y-auto space-y-2">
          {terminals.map((t) => (
            <label key={t.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/40 hover:bg-slate-900/80 cursor-pointer">
              <input
                type="checkbox"
                checked={!!selected[t.id]}
                onChange={(e) => setSelected((s) => ({ ...s, [t.id]: e.target.checked }))}
                className="accent-red-500"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white truncate">{t.name}{t.ip ? ` (${t.ip})` : ''}</div>
                <div className="text-[11px] text-slate-500 truncate" title={t.id}>scopes: {(t.gradeScopes || []).join(', ') || 'all'}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-2">
          <div className="text-xs text-slate-400">Selected: {selectedIds.length}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onRemove(selectedIds, allSelected)}
              disabled={saving || selectedIds.length === 0}
              className="px-3 py-1.5 text-xs rounded-lg border border-red-500/40 bg-red-500/20 text-red-200 hover:bg-red-500/30 disabled:opacity-40"
            >
              {saving ? 'Removing…' : `Remove from ${selectedIds.length} terminal${selectedIds.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TerminalAssignmentsPage() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [query, setQuery] = useState('');
  const [modeFilter, setModeFilter] = useState('ALL');
  const [gradeFilter, setGradeFilter] = useState('ALL');
  const [data, setData] = useState({ terminals: [], items: [] });
  const [diag, setDiag] = useState({ summary: null, items: [] });
  const [editTarget, setEditTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [assignRes, diagRes] = await Promise.all([
        fetch('/api/pickup/admin/chaperone-assignment?limit=600', { credentials: 'include' }),
        fetch('/api/pickup/admin/enrollment-diagnostics', { credentials: 'include' }),
      ]);
      const assignJson = await assignRes.json();
      const diagJson = await diagRes.json();
      if (!assignRes.ok) throw new Error(assignJson.error || assignJson.message || 'Failed loading assignments');
      if (!diagRes.ok) throw new Error(diagJson.error || diagJson.message || 'Failed loading diagnostics');
      setData({ terminals: assignJson.terminals || [], items: assignJson.items || [] });
      setDiag({ summary: diagJson.summary || null, items: diagJson.items || [] });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Terminal registry lookup: id → { name, ip } for human-readable labels,
  // sorted naturally (Terminal 01, 02, … 10) so lists read in order.
  const terminalsById = useMemo(() => {
    const m = new Map();
    (data.terminals || []).forEach((t) => m.set(t.id, t));
    return m;
  }, [data.terminals]);

  const terminalIpById = useMemo(() => {
    const m = new Map();
    (data.terminals || []).forEach((t) => {
      if (t?.id && t?.ip) m.set(t.id, t.ip);
    });
    return m;
  }, [data.terminals]);

  const sortedTerminals = useMemo(() => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...(data.terminals || [])].sort((a, b) => collator.compare(a.name || a.id, b.name || b.id));
  }, [data.terminals]);

  const terminalLabel = useCallback((id) => {
    const t = terminalsById.get(id);
    if (!t) return id;
    return `${t.name || id}${t.ip ? ` (${t.ip})` : ''}`;
  }, [terminalsById]);

  const sortTerminalIds = useCallback((ids) => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...(ids || [])].sort((a, b) => collator.compare(terminalLabel(a), terminalLabel(b)));
  }, [terminalLabel]);

  const gradeOptions = useMemo(() => {
    const uniq = new Set();
    data.items.forEach((it) => (it.studentGrades || []).forEach((g) => uniq.add(String(g))));
    const collator = new Intl.Collator(undefined, { numeric: true });
    return ['ALL', ...[...uniq].sort((a, b) => collator.compare(a, b))];
  }, [data.items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.items.filter((it) => {
      // Keep this table focused on actionable records only.
      if (!it.deviceEnrolled) return false;
      if (modeFilter !== 'ALL' && it.assignmentMode !== modeFilter) return false;
      if (gradeFilter !== 'ALL' && !(it.studentGrades || []).map(String).includes(gradeFilter)) return false;
      if (!q) return true;
      const hay = [
        it.name,
        it.employeeNo,
        ...(it.studentClasses || []),
        ...(it.studentGrades || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [data.items, query, modeFilter, gradeFilter]);

  const removeFromTerminals = async (chaperone, terminalIds, allSelected) => {
    setSaving(true);
    try {
      const ipByTerminalId = new Map(data.terminals.map((t) => [t.id, t.ip]));
      const deviceIps = terminalIds.map((id) => ipByTerminalId.get(id)).filter(Boolean);
      const body = { chaperoneIds: [chaperone.id] };
      if (!allSelected) body.deviceIps = deviceIps;
      const r = await fetch('/api/pickup/admin/unenroll', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || 'Failed to remove');
      const s = j.summary?.[0];
      const fails = (s?.devices || []).filter((d) => !d.ok);
      if (fails.length) {
        setToast({ kind: 'err', text: `Removed with ${fails.length} failure(s): ${fails.map((f) => `${f.name}: ${String(f.error).slice(0, 60)}`).join(' · ')}` });
      } else {
        setToast({ kind: 'ok', text: `${chaperone.name} removed from ${s?.devices?.length || 0} terminal(s).` });
      }
      setRemoveTarget(null);
      await load();
    } catch (e) {
      setToast({ kind: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const setOverride = async (chaperoneId, terminalIds) => {
    setSaving(true);
    try {
      const r = await fetch('/api/pickup/admin/chaperone-assignment', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chaperoneId, allowedTerminalIds: terminalIds }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'Failed to save override');
      setToast({ kind: 'ok', text: 'Override saved.' });
      setEditTarget(null);
      await load();
    } catch (e) {
      setToast({ kind: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const clearOverride = async (chaperoneId) => {
    if (!window.confirm('Clear terminal override and return to derived assignment?')) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/pickup/admin/chaperone-assignment?chaperoneId=${encodeURIComponent(chaperoneId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'Failed to clear override');
      setToast({ kind: 'ok', text: 'Override cleared.' });
      await load();
    } catch (e) {
      setToast({ kind: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const reconcileChaperone = async (chaperone) => {
    const desiredIds = sortTerminalIds(chaperone?.derivedTerminalIds || []);
    if (desiredIds.length === 0) {
      setToast({ kind: 'err', text: `${chaperone?.name || 'Chaperone'} has no derived terminals to reconcile.` });
      return;
    }

    const desiredSet = new Set(desiredIds);
    const allTerminalIds = (data.terminals || []).map((t) => t.id);
    const wrongIds = allTerminalIds.filter((id) => !desiredSet.has(id));
    const desiredIps = desiredIds.map((id) => terminalIpById.get(id)).filter(Boolean);
    const wrongIps = wrongIds.map((id) => terminalIpById.get(id)).filter(Boolean);

    setSaving(true);
    try {
      const overrideRes = await fetch('/api/pickup/admin/chaperone-assignment', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chaperoneId: chaperone.id, allowedTerminalIds: desiredIds }),
      });
      const overrideJson = await overrideRes.json();
      if (!overrideRes.ok) throw new Error(overrideJson.error || overrideJson.message || 'Failed to save override');

      if (wrongIps.length > 0) {
        const unenrollRes = await fetch('/api/pickup/admin/unenroll', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chaperoneIds: [chaperone.id], deviceIps: wrongIps }),
        });
        const unenrollJson = await unenrollRes.json();
        if (!unenrollRes.ok) throw new Error(unenrollJson.error || unenrollJson.message || 'Failed to remove wrong terminals');
      }

      const reenrollRes = await fetch('/api/pickup/admin/reenroll', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chaperoneIds: [chaperone.id], deviceIps: desiredIps }),
      });
      const reenrollJson = await reenrollRes.json();
      if (!reenrollRes.ok) throw new Error(reenrollJson.error || reenrollJson.message || 'Failed to re-push to desired terminals');

      const pushed = (reenrollJson.summary || []).find((x) => x.chaperoneId === chaperone.id);
      const okDevices = (pushed?.devices || []).filter((d) => d.ok).length;
      setToast({
        kind: 'ok',
        text: `${chaperone.name} reconciled to ${desiredIds.map(terminalLabel).join(', ')}${wrongIps.length ? `; removed from ${wrongIps.length} other terminal(s)` : ''}${okDevices ? `; pushed to ${okDevices} terminal(s)` : ''}.`,
      });
      await load();
    } catch (e) {
      setToast({ kind: 'err', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Head><title>Terminal Assignments · BINUSFace</title></Head>
      <V2Layout>
        <PageGuard feature="pickup_admin" action="view" what="manage terminal assignments">
          <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[95rem] mx-auto space-y-4">
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
                  <i className="ph ph-shuffle text-brand-400"></i>
                  Terminal Assignment Fix Portal
                </h1>
                <p className="text-sm text-slate-400 mt-1">Set per-chaperone terminal overrides and review enrollment diagnostics in one screen.</p>
              </div>
              <button onClick={load} className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-white/5 text-slate-300 hover:bg-white/10">
                <i className="ph ph-arrows-clockwise mr-1"></i>Refresh
              </button>
            </div>

            {toast && (
              <div className={`rounded-lg border p-3 text-sm ${toast.kind === 'ok' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200' : 'bg-red-500/10 border-red-500/30 text-red-200'}`}>
                {toast.text}
              </div>
            )}
            {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 text-red-200 p-3 text-sm">{error}</div>}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wider text-slate-500">Diagnostics</div>
                <div className="mt-2 text-2xl font-bold text-white">{diag.summary?.total || 0}</div>
                <div className="text-xs text-slate-400 mt-1">High: {diag.summary?.high || 0} · Medium: {diag.summary?.medium || 0} · Low: {diag.summary?.low || 0}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wider text-slate-500">Chaperones</div>
                <div className="mt-2 text-2xl font-bold text-white">{data.items.length}</div>
                <div className="text-xs text-slate-400 mt-1">Override: {data.items.filter((x) => x.assignmentMode === 'override').length} · Derived: {data.items.filter((x) => x.assignmentMode !== 'override').length}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wider text-slate-500">Terminals</div>
                <div className="mt-2 text-2xl font-bold text-white">{data.terminals.length}</div>
                <div className="text-xs text-slate-400 mt-1">Active registry used for override validation and safe reconcile.</div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                <div className="text-sm font-semibold text-white">Enrollment Diagnostics Queue</div>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {diag.items.slice(0, 40).map((it, idx) => (
                  <div key={`${it.type}-${it.chaperoneId || 'lock'}-${idx}`} className="px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/40 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-white font-medium truncate">{it.chaperoneName || 'Unknown'} · {it.type}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{it.message}</div>
                    </div>
                    <SeverityPill severity={it.severity} />
                  </div>
                ))}
                {diag.items.length === 0 && (
                  <div className="text-xs text-slate-500">No diagnostics issues detected.</div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                <div className="text-sm font-semibold text-white">Chaperone Assignment Overrides</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-slate-500 hidden sm:inline">
                    Reconcile keeps shared parents on every grade they are authorized for.
                  </span>
                  <select
                    value={modeFilter}
                    onChange={(e) => setModeFilter(e.target.value)}
                    className="px-2.5 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200"
                  >
                    <option value="ALL">All modes</option>
                    <option value="override">Override</option>
                    <option value="derived">Derived</option>
                  </select>
                  <select
                    value={gradeFilter}
                    onChange={(e) => setGradeFilter(e.target.value)}
                    className="px-2.5 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-700 text-slate-200"
                  >
                    {gradeOptions.map((g) => (
                      <option key={g} value={g}>{g === 'ALL' ? 'All grades' : `Grade ${g}`}</option>
                    ))}
                  </select>
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search name, employeeNo, class, grade, terminal"
                    className="w-full sm:w-72 px-3 py-1.5 text-sm rounded-lg bg-slate-950 border border-slate-700 text-slate-200 placeholder-slate-500"
                  />
                  <span className="text-[11px] text-slate-500">{visible.length} enrolled shown</span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-slate-400 bg-slate-950/50">
                    <tr>
                      <th className="px-3 py-2 text-left">Chaperone</th>
                      <th className="px-3 py-2 text-left">Class / Grade</th>
                      <th className="px-3 py-2 text-left">Mode</th>
                      <th className="px-3 py-2 text-left">Device status</th>
                      <th className="px-3 py-2 text-left">Effective terminals</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((it) => (
                      <tr key={it.id} className="border-t border-slate-800 hover:bg-white/5">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2.5">
                            {it.photoUrl ? (
                              <img
                                src={it.photoUrl}
                                alt={it.name}
                                loading="lazy"
                                className="h-9 w-9 rounded-full object-cover border border-slate-700 bg-slate-900 shrink-0"
                                onError={(e) => { e.currentTarget.style.display = 'none'; if (e.currentTarget.nextSibling) e.currentTarget.nextSibling.style.display = 'flex'; }}
                              />
                            ) : null}
                            <div
                              className="h-9 w-9 rounded-full border border-slate-700 bg-slate-800 text-slate-300 text-[11px] font-semibold items-center justify-center shrink-0"
                              style={{ display: it.photoUrl ? 'none' : 'flex' }}
                            >
                              {String(it.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
                            </div>
                            <div>
                              <div className="text-white font-medium">{it.name}</div>
                              <div className="text-[11px] text-slate-500">{it.employeeNo || '—'} · {it.status || '—'}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-[11px]">
                          <div className="text-slate-200">{(it.studentClasses || []).join(', ') || '—'}</div>
                          <div className="text-slate-500">{(it.studentGrades || []).join(', ') || '—'}</div>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase ${it.assignmentMode === 'override' ? 'bg-brand-500/15 border-brand-500/40 text-brand-300' : 'bg-slate-500/15 border-slate-500/40 text-slate-300'}`}>
                            {it.assignmentMode}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {it.deviceEnrolled ? (
                            <span className="text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase bg-emerald-500/15 border-emerald-500/40 text-emerald-300">Enrolled</span>
                          ) : it.deviceEnrollAttemptedAt && (it.deviceEnrollErrors || []).length > 0 ? (
                            <span className="text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase bg-red-500/15 border-red-500/40 text-red-300" title={(it.deviceEnrollErrors || []).join('\n')}>Failed</span>
                          ) : it.deviceUnenrollAttemptedAt ? (
                            <span className="text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase bg-amber-500/15 border-amber-500/40 text-amber-300">Removed</span>
                          ) : (
                            <span className="text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase bg-slate-500/15 border-slate-500/40 text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-slate-300">
                          {it.effectiveTerminalIds?.length ? (
                            <div className="flex flex-wrap gap-1">
                              {sortTerminalIds(it.effectiveTerminalIds).map((tid) => (
                                <span key={tid} className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-950/60 whitespace-nowrap" title={`${terminalsById.get(tid)?.name || tid} · serves ${formatGradeLabel(terminalsById.get(tid))}`}>
                                  {chipLabel(it, terminalsById.get(tid))}
                                </span>
                              ))}
                            </div>
                          ) : 'none'}
                          {it.missingOverrideTerminalIds?.length > 0 && (
                            <div className="text-red-300 mt-0.5">missing: {sortTerminalIds(it.missingOverrideTerminalIds).map((tid) => chipLabel(it, terminalsById.get(tid))).join(', ')}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setEditTarget(it)}
                              className="px-2.5 py-1 text-xs rounded-lg border border-brand-500/40 bg-brand-500/20 text-brand-200 hover:bg-brand-500/30"
                            >
                              Edit override
                            </button>
                            <button
                              type="button"
                              onClick={() => reconcileChaperone(it)}
                              disabled={saving}
                              title="Re-save the derived terminal set, remove wrong terminals, and re-push only to the correct ones"
                              className="px-2.5 py-1 text-xs rounded-lg border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40"
                            >
                              Reconcile
                            </button>
                            <button
                              type="button"
                              onClick={() => clearOverride(it.id)}
                              disabled={saving || it.assignmentMode !== 'override'}
                              className="px-2.5 py-1 text-xs rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 disabled:opacity-40"
                            >
                              Reset derived
                            </button>
                            <button
                              type="button"
                              onClick={() => setRemoveTarget(it)}
                              disabled={saving}
                              title="Remove face + user from terminals (e.g. mistaken enrolment)"
                              className="px-2.5 py-1 text-xs rounded-lg border border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-40"
                            >
                              <i className="ph ph-user-minus mr-1"></i>Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {visible.length === 0 && !loading && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500 text-xs">No matching chaperones.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </PageGuard>

        <EditOverrideModal
          open={!!editTarget}
          chaperone={editTarget}
          terminals={sortedTerminals}
          saving={saving}
          onCancel={() => setEditTarget(null)}
          onSave={(terminalIds) => setOverride(editTarget.id, terminalIds)}
        />

        <RemoveFromTerminalsModal
          open={!!removeTarget}
          chaperone={removeTarget}
          terminals={sortedTerminals}
          saving={saving}
          onCancel={() => setRemoveTarget(null)}
          onRemove={(terminalIds, allSelected) => removeFromTerminals(removeTarget, terminalIds, allSelected)}
        />
      </V2Layout>
    </>
  );
}
