/**
 * /v2/release-groups — Phase 2 admin UI for grade-level release groups.
 *
 * A release group binds N terminals (Hikvision face terminals) to 1 paired
 * iPad. Teachers see only events from terminals in their group's list.
 *
 * Visual polish round:
 *  - 2-col card grid with status chips (unbound / pending / paired)
 *  - Pairing code shown prominently with one-click copy
 *  - Terminal pills resolved to *names* (not IDs) so renames flow through
 *  - Collapsible terminal-binding editor
 *  - Muted timestamps in the footer
 */
import Head from 'next/head';
import { useEffect, useState, useCallback, useMemo } from 'react';
import V2Layout from '../../components/v2/V2Layout';

function fmtTime(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return null; }
}
function fmtDate(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return null; }
}

const STATUS_TONE = {
  paired:  { ring: 'border-emerald-500/40', halo: 'bg-emerald-500', chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', icon: 'ph-check-circle', label: 'Paired' },
  pending: { ring: 'border-amber-500/40',   halo: 'bg-amber-500',   chip: 'bg-amber-500/15 text-amber-300 border-amber-500/40',     icon: 'ph-hourglass-medium', label: 'Pending pair' },
  unbound: { ring: 'border-slate-700',      halo: 'bg-slate-600',   chip: 'bg-slate-700/40 text-slate-300 border-slate-600',         icon: 'ph-link-break', label: 'Unbound' },
};

export default function ReleaseGroupsPage() {
  const [groups, setGroups] = useState([]);
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newGroup, setNewGroup] = useState({ name: '', gradeLabel: '', terminalIds: [] });
  const [busy, setBusy] = useState({});
  const [pairCode, setPairCode] = useState({}); // groupId -> { code, expiresAt }
  const [editTerminals, setEditTerminals] = useState({}); // groupId -> bool
  const [copied, setCopied] = useState(null);
  const [toast, setToast] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [g, t] = await Promise.all([
        fetch('/api/pickup/admin/release-groups', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/pickup/admin/terminals', { credentials: 'include' }).then((r) => r.json()),
      ]);
      if (!g.ok) throw new Error(g.error || 'failed loading groups');
      setGroups(g.groups || []);
      setTerminals(t.terminals || []);
      setErr(null);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const terminalsById = useMemo(() => {
    const m = new Map();
    terminals.forEach((t) => m.set(t.id, t));
    return m;
  }, [terminals]);

  const showToast = (kind, message, ttl = 3000) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), ttl);
  };

  const create = async () => {
    if (!newGroup.name.trim()) { showToast('error', 'Group name is required.'); return; }
    if (!newGroup.terminalIds.length) { showToast('error', 'Pick at least one terminal.'); return; }
    setCreating(true);
    try {
      const r = await fetch('/api/pickup/admin/release-groups', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newGroup),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setNewGroup({ name: '', gradeLabel: '', terminalIds: [] });
      setShowNew(false);
      showToast('success', 'Release group created.');
      await reload();
    } catch (e) { showToast('error', e.message); }
    finally { setCreating(false); }
  };

  const startPair = async (id) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/release-groups?action=start-pair&id=${id}`, {
        method: 'POST', credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setPairCode((p) => ({ ...p, [id]: { code: j.pairingCode, expiresAt: j.expiresAt } }));
      showToast('success', 'Pairing code generated.');
      await reload();
    } catch (e) { showToast('error', e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const unpair = async (id) => {
    if (!confirm('Revoke the currently paired iPad? It will need to re-pair.')) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/release-groups?action=unpair&id=${id}`, {
        method: 'POST', credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setPairCode((p) => { const n = { ...p }; delete n[id]; return n; });
      showToast('success', 'iPad unpaired.');
      await reload();
    } catch (e) { showToast('error', e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const removeGroup = async (id) => {
    if (!confirm('Delete this release group? Bound iPad will be revoked.')) return;
    const r = await fetch(`/api/pickup/admin/release-groups?id=${id}`, {
      method: 'DELETE', credentials: 'include',
    });
    const j = await r.json();
    if (!r.ok) { showToast('error', j.error || 'failed'); return; }
    showToast('success', 'Group deleted.');
    await reload();
  };

  const updateTerminals = async (id, terminalIds) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/release-groups?id=${id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminalIds }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      await reload();
    } catch (e) { showToast('error', e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const copyCode = (code) => {
    if (!code) return;
    try {
      navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(null), 1500);
    } catch { showToast('error', 'Could not copy'); }
  };

  const stats = useMemo(() => {
    let paired = 0, pending = 0, unbound = 0;
    groups.forEach((g) => {
      if (g.tabletDeviceId) paired++;
      else if (g.pairingCode || g.status === 'pending') pending++;
      else unbound++;
    });
    return { total: groups.length, paired, pending, unbound };
  }, [groups]);

  return (
    <V2Layout>
      <Head><title>Release Groups · Pickup System</title></Head>

      <div className="p-6 max-w-7xl mx-auto space-y-5">
        {/* Hero header */}
        <div className="rounded-2xl border border-brand-500/20 bg-gradient-to-br from-brand-500/10 via-slate-900/40 to-slate-900/40 p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center flex-shrink-0">
                <i className="ph ph-device-tablet-speaker text-brand-300 text-2xl"></i>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">Release Groups</h1>
                <p className="text-sm text-slate-300 mt-1 max-w-2xl">
                  Bind <em>N</em> terminals to 1 teacher iPad. Teachers see only events from terminals in their group's list.
                  Pairing codes expire on first use.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowNew((v) => !v)}
                className="px-3 py-2 text-sm rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold border border-emerald-400 shadow-md shadow-emerald-500/20">
                <i className={`ph ${showNew ? 'ph-x' : 'ph-plus'} mr-1`}></i>{showNew ? 'Cancel' : 'New group'}
              </button>
              <button onClick={reload} disabled={loading}
                className="px-3 py-2 text-sm rounded-lg bg-slate-800/70 border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                <i className={`ph ph-arrows-clockwise ${loading ? 'animate-spin' : ''} mr-1`}></i>Refresh
              </button>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatChip label="Total"        value={stats.total}   icon="ph-device-tablet-speaker" tone="slate" />
          <StatChip label="Paired"       value={stats.paired}  icon="ph-check-circle"          tone="emerald" />
          <StatChip label="Pending pair" value={stats.pending} icon="ph-hourglass-medium"      tone="amber" />
          <StatChip label="Unbound"      value={stats.unbound} icon="ph-link-break"            tone="zinc" />
        </div>

        {err && (
          <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
            <i className="ph ph-warning-circle mr-1"></i>{err}
          </div>
        )}

        {/* Create panel */}
        {showNew && (
          <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-slate-900/40 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <i className="ph ph-plus-circle text-emerald-400 text-lg"></i>
              <h2 className="text-sm font-bold text-white">New release group</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Name" required>
                <input
                  value={newGroup.name}
                  onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                  placeholder="e.g. PYP Grade 4"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
                />
              </Field>
              <Field label="Grade label" hint="e.g. G4">
                <input
                  value={newGroup.gradeLabel}
                  onChange={(e) => setNewGroup({ ...newGroup, gradeLabel: e.target.value })}
                  placeholder="—"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
                />
              </Field>
            </div>

            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
                Terminals (pick at least one)
              </label>
              {terminals.length === 0 ? (
                <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2.5 py-1.5">
                  No terminals registered yet. Add one in <a href="/v2/terminals" className="underline">Terminals</a> first.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {terminals.map((t) => {
                    const checked = newGroup.terminalIds.includes(t.id);
                    return (
                      <label key={t.id}
                        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border cursor-pointer transition ${
                          checked ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
                        }`}>
                        <input
                          type="checkbox"
                          className="rounded border-slate-700 bg-slate-950"
                          checked={checked}
                          onChange={(e) => {
                            const ids = new Set(newGroup.terminalIds);
                            if (e.target.checked) ids.add(t.id); else ids.delete(t.id);
                            setNewGroup({ ...newGroup, terminalIds: Array.from(ids) });
                          }}
                        />
                        <i className="ph ph-cpu opacity-70"></i>
                        {t.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => { setShowNew(false); setNewGroup({ name: '', gradeLabel: '', terminalIds: [] }); }}
                disabled={creating}
                className="px-3 py-1.5 text-xs rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={create} disabled={creating}
                className="px-4 py-1.5 text-xs rounded-md font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 border border-emerald-400 disabled:opacity-50">
                {creating
                  ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Creating…</>
                  : <><i className="ph ph-check mr-1"></i>Create group</>}
              </button>
            </div>
          </div>
        )}

        {/* Group cards */}
        {loading && groups.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            <i className="ph ph-spinner-gap animate-spin text-3xl"></i>
            <div className="mt-2 text-sm">Loading groups…</div>
          </div>
        ) : groups.length === 0 ? (
          <div className="p-16 text-center rounded-xl bg-slate-900/40 border border-slate-800">
            <i className="ph ph-device-tablet-speaker text-5xl text-slate-600"></i>
            <div className="mt-3 text-base font-semibold text-slate-300">No release groups yet</div>
            <div className="mt-1 text-xs text-slate-500">Click <span className="text-emerald-300 font-semibold">+ New group</span> above to create one.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {groups.map((g) => {
              const tone = g.tabletDeviceId ? STATUS_TONE.paired
                : (g.pairingCode || g.status === 'pending') ? STATUS_TONE.pending
                : STATUS_TONE.unbound;
              const code = pairCode[g.id]?.code || g.pairingCode;
              const exp = pairCode[g.id]?.expiresAt || g.pairingExpiresAt;
              const editing = !!editTerminals[g.id];
              const ids = g.terminalIds || [];
              return (
                <div key={g.id} className={`relative rounded-2xl border ${tone.ring} bg-gradient-to-br from-slate-900/60 to-slate-950/40 overflow-hidden`}>
                  <div className={`h-1 w-full ${tone.halo}`}></div>

                  <div className="px-5 pt-4 pb-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-base font-bold text-white truncate">{g.name}</h3>
                        {g.gradeLabel && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                            {g.gradeLabel}
                          </span>
                        )}
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border inline-flex items-center gap-1 ${tone.chip}`}>
                          <i className={`ph ${tone.icon}`}></i>{tone.label}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 font-mono truncate" title={g.id}>id: {g.id}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      {g.tabletDeviceId ? (
                        <button onClick={() => unpair(g.id)} disabled={busy[g.id]}
                          title="Unpair iPad"
                          className="px-2.5 py-1.5 rounded-md text-xs bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 disabled:opacity-50">
                          <i className="ph ph-link-break mr-1"></i>Unpair
                        </button>
                      ) : (
                        <button onClick={() => startPair(g.id)} disabled={busy[g.id]}
                          title="Generate a fresh pairing code"
                          className="px-2.5 py-1.5 rounded-md text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 disabled:opacity-50">
                          <i className="ph ph-device-tablet-speaker mr-1"></i>{code ? 'Re-pair' : 'Pair iPad'}
                        </button>
                      )}
                      <button onClick={() => removeGroup(g.id)}
                        title="Delete group"
                        className="p-1.5 rounded-md text-xs bg-slate-800/60 text-slate-400 border border-slate-700 hover:text-rose-300 hover:bg-rose-500/10 hover:border-rose-500/30">
                        <i className="ph ph-trash"></i>
                      </button>
                    </div>
                  </div>

                  {/* Pairing code (when pending) */}
                  {code && !g.tabletDeviceId && (
                    <div className="mx-5 mb-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/30">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold">
                          <i className="ph ph-key mr-1"></i>Pairing code
                        </div>
                        {exp && <div className="text-[10px] text-emerald-400/70">Expires {fmtTime(exp)}</div>}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-3xl font-bold tracking-[0.3em] text-emerald-100 font-mono select-all flex-1">
                          {code}
                        </div>
                        <button onClick={() => copyCode(code)}
                          className="px-3 py-2 rounded-md bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold border border-emerald-400 flex-shrink-0">
                          {copied === code
                            ? <><i className="ph ph-check mr-1"></i>Copied</>
                            : <><i className="ph ph-copy mr-1"></i>Copy</>}
                        </button>
                      </div>
                      <div className="text-[10px] text-emerald-400/70 mt-1.5">
                        Enter on the iPad at <code className="font-mono text-emerald-200">/pickup/teacher</code>.
                      </div>
                    </div>
                  )}

                  {/* Bound terminals */}
                  <div className="px-5 pb-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                        <i className="ph ph-cpu mr-1"></i>Terminals · {ids.length}
                      </div>
                      <button onClick={() => setEditTerminals((m) => ({ ...m, [g.id]: !m[g.id] }))}
                        className="text-[10px] text-slate-400 hover:text-brand-300 transition">
                        {editing ? 'Done' : 'Edit'}
                      </button>
                    </div>

                    {!editing ? (
                      ids.length === 0 ? (
                        <div className="text-[11px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5">
                          No terminals bound — this group will never receive scan events.
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {ids.map((tid) => {
                            const t = terminalsById.get(tid);
                            return (
                              <span key={tid}
                                className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border ${
                                  t ? 'bg-slate-800/70 border-slate-700 text-slate-200'
                                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                                }`}>
                                <i className={`ph ${t ? 'ph-cpu' : 'ph-warning'} opacity-70`}></i>
                                {t?.name || `missing: ${tid}`}
                              </span>
                            );
                          })}
                        </div>
                      )
                    ) : (
                      terminals.length === 0 ? (
                        <div className="text-[11px] text-amber-300 bg-amber-500/5 border border-amber-500/30 rounded px-2 py-1.5">
                          No terminals registered. Add one in Terminals.
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {terminals.map((t) => {
                            const checked = ids.includes(t.id);
                            return (
                              <label key={t.id}
                                className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border cursor-pointer transition ${
                                  checked ? 'bg-brand-500/15 border-brand-500/40 text-brand-100'
                                          : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
                                }`}>
                                <input type="checkbox"
                                  className="rounded border-slate-700 bg-slate-950"
                                  checked={checked}
                                  onChange={(e) => {
                                    const next = new Set(ids);
                                    if (e.target.checked) next.add(t.id); else next.delete(t.id);
                                    updateTerminals(g.id, Array.from(next));
                                  }}
                                />
                                <i className="ph ph-cpu opacity-70"></i>{t.name}
                              </label>
                            );
                          })}
                        </div>
                      )
                    )}
                  </div>

                  {/* Footer meta */}
                  {(g.createdAt || g.updatedAt || g.tabletDeviceId) && (
                    <div className="px-5 py-2 border-t border-slate-800/60 bg-slate-950/30 text-[10px] text-slate-500 flex items-center gap-3 flex-wrap">
                      {g.tabletDeviceId && (
                        <span className="font-mono truncate max-w-[180px]" title={g.tabletDeviceId}>
                          <i className="ph ph-device-tablet mr-1"></i>{g.tabletDeviceId}
                        </span>
                      )}
                      {g.updatedAt && <span><i className="ph ph-clock mr-1"></i>updated {fmtDate(g.updatedAt)}</span>}
                      {g.createdAt && <span className="text-slate-600">· created {fmtDate(g.createdAt)}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-2xl border text-sm max-w-sm ${
          toast.kind === 'success' ? 'bg-emerald-500/95 border-emerald-400 text-white'
          : 'bg-rose-500/95 border-rose-400 text-white'
        }`}>
          <i className={`ph ${toast.kind === 'success' ? 'ph-check-circle' : 'ph-x-circle'} mr-2`}></i>
          {toast.message}
        </div>
      )}
    </V2Layout>
  );
}

function StatChip({ label, value, icon, tone }) {
  const tones = {
    slate:   'from-slate-800/40 to-slate-900/40 border-slate-800 text-slate-300',
    emerald: 'from-emerald-500/10 to-emerald-900/10 border-emerald-500/30 text-emerald-300',
    amber:   'from-amber-500/10 to-amber-900/10 border-amber-500/30 text-amber-300',
    zinc:    'from-zinc-700/30 to-zinc-900/30 border-zinc-700/50 text-zinc-400',
  };
  return (
    <div className={`rounded-xl bg-gradient-to-br border p-3 ${tones[tone] || tones.slate}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider opacity-80 font-semibold">{label}</span>
        <i className={`ph ${icon} text-base opacity-60`}></i>
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

function Field({ label, hint, required, children }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
        {label}{required && <span className="text-rose-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <div className="text-[10px] text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}
