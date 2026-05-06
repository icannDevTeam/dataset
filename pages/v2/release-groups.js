/**
 * /v2/release-groups — Phase 2 admin UI for grade-level release groups.
 *
 * A release group binds N terminals (Hikvision face terminals) to 1 paired
 * iPad. Teachers see only events from terminals in their group's list.
 *
 * Workflow:
 *   1. Admin creates "PYP Grade 4" group, picks terminals (PYP Lobby + Basement).
 *   2. Admin clicks "Pair iPad" → 6-char code shown.
 *   3. Teacher opens /pickup/teacher on iPad, types code → bound permanently.
 *   4. Subsequent scans on those terminals appear on that iPad only.
 */
import Head from 'next/head';
import { useEffect, useState, useCallback } from 'react';
import V2Layout from '../../components/v2/V2Layout';

export default function ReleaseGroupsPage() {
  const [groups, setGroups] = useState([]);
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newGroup, setNewGroup] = useState({ name: '', gradeLabel: '', terminalIds: [] });
  const [busy, setBusy] = useState({});
  const [pairCode, setPairCode] = useState({}); // groupId -> { code, expiresAt }

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

  const create = async () => {
    if (!newGroup.name.trim()) { alert('Group name is required.'); return; }
    if (!newGroup.terminalIds.length) { alert('Pick at least one terminal — a release group with no terminals will never receive scan events.'); return; }
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
      await reload();
    } catch (e) { alert(e.message); }
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
      await reload();
    } catch (e) { alert(e.message); }
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
      await reload();
    } catch (e) { alert(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const removeGroup = async (id) => {
    if (!confirm('Delete this release group? Bound iPad will be revoked.')) return;
    const r = await fetch(`/api/pickup/admin/release-groups?id=${id}`, {
      method: 'DELETE', credentials: 'include',
    });
    const j = await r.json();
    if (!r.ok) { alert(j.error || 'failed'); return; }
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
    } catch (e) { alert(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  return (
    <V2Layout>
      <Head><title>Release Groups · PickupGuard</title></Head>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-100">Release Groups</h1>
          <p className="text-sm text-slate-400 mt-1">
            Bind N terminals to 1 teacher iPad. Group also doubles as a pairing scope —
            iPads paired here only see events from these terminals.
          </p>
        </div>

        {err && <div className="mb-4 p-3 rounded bg-red-950/60 border border-red-500/40 text-red-200 text-sm">{err}</div>}

        {/* Create new */}
        <div className="mb-6 p-4 rounded-lg border border-slate-800 bg-slate-900/40">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">+ New release group</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              value={newGroup.name}
              onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
              placeholder="Group name (e.g. PYP Grade 4)"
              className="px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 text-sm"
            />
            <input
              value={newGroup.gradeLabel}
              onChange={(e) => setNewGroup({ ...newGroup, gradeLabel: e.target.value })}
              placeholder="Grade label (e.g. G4)"
              className="px-3 py-2 bg-slate-900 border border-slate-700 rounded text-slate-200 text-sm"
            />
            <button
              onClick={create}
              disabled={creating}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50">
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
          <div className="mt-3">
            <div className="text-xs text-slate-400 mb-1">Terminals (pick at least one):</div>
            {terminals.length === 0 ? (
              <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-500/40 rounded px-2 py-1.5">
                No Hikvision terminals registered yet. Add one in <a href="/v2/terminals" className="underline">Terminals</a> first — a release group needs at least one terminal to receive scan events.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {terminals.map((t) => (
                  <label key={t.id} className="inline-flex items-center gap-1 text-xs text-slate-300 px-2 py-1 rounded bg-slate-800 border border-slate-700">
                    <input
                      type="checkbox"
                      checked={newGroup.terminalIds.includes(t.id)}
                      onChange={(e) => {
                        const ids = new Set(newGroup.terminalIds);
                        if (e.target.checked) ids.add(t.id); else ids.delete(t.id);
                        setNewGroup({ ...newGroup, terminalIds: Array.from(ids) });
                      }}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {loading ? <div className="text-slate-400">Loading…</div> : (
          groups.length === 0 ? (
            <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-8 text-center text-slate-400">
              No release groups yet. Create one above.
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => {
                const code = pairCode[g.id]?.code || g.pairingCode;
                const exp = pairCode[g.id]?.expiresAt
                  ? new Date(pairCode[g.id].expiresAt).toLocaleTimeString()
                  : (g.pairingExpiresAt ? new Date(g.pairingExpiresAt).toLocaleTimeString() : null);
                return (
                  <div key={g.id} className="p-4 rounded-lg border border-slate-800 bg-slate-900/40">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="text-lg font-semibold text-slate-100">{g.name}</div>
                        <div className="text-xs text-slate-500">
                          {g.gradeLabel || '—'} · status: <span className={g.status === 'paired' ? 'text-emerald-400' : 'text-amber-400'}>{g.status}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {g.tabletDeviceId ? (
                          <button onClick={() => unpair(g.id)} disabled={busy[g.id]}
                            className="px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white text-xs">
                            Unpair iPad
                          </button>
                        ) : (
                          <button onClick={() => startPair(g.id)} disabled={busy[g.id]}
                            className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs">
                            Pair iPad
                          </button>
                        )}
                        <button onClick={() => removeGroup(g.id)}
                          className="px-3 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white text-xs">
                          Delete
                        </button>
                      </div>
                    </div>

                    {code && (
                      <div className="mb-3 p-3 rounded bg-emerald-950/40 border border-emerald-500/40">
                        <div className="text-xs text-emerald-200 mb-1">Enter this on the iPad at <code>/pickup/teacher</code>:</div>
                        <div className="text-3xl font-bold tracking-widest text-emerald-100 font-mono">{code}</div>
                        {exp && <div className="text-xs text-emerald-300 mt-1">Expires at {exp}</div>}
                      </div>
                    )}

                    <div>
                      <div className="text-xs text-slate-400 mb-1">Terminals in group:</div>
                      <div className="flex flex-wrap gap-2">
                        {terminals.map((t) => {
                          const checked = (g.terminalIds || []).includes(t.id);
                          return (
                            <label key={t.id}
                              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${checked ? 'bg-blue-900/40 border-blue-500/40 text-blue-100' : 'bg-slate-800 border-slate-700 text-slate-300'}`}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const ids = new Set(g.terminalIds || []);
                                  if (e.target.checked) ids.add(t.id); else ids.delete(t.id);
                                  updateTerminals(g.id, Array.from(ids));
                                }}
                              />
                              {t.name}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </V2Layout>
  );
}
