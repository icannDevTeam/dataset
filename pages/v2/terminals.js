/**
 * /v2/terminals — Phase 2 admin UI for the Hikvision face-terminal registry.
 *
 * Lists tenants/{t}/terminals (auto-synced from backend devices.json on each
 * listener startup). Admin can:
 *   - Edit gradeLabel / gateLabel
 *   - Bind to a release group
 *   - Open / Close / Auto the gate (per-terminal override)
 *   - Disable a terminal (hide from feeds / kiosks)
 */
import Head from 'next/head';
import { useEffect, useState, useCallback } from 'react';
import V2Layout from '../../components/v2/V2Layout';

export default function TerminalsPage() {
  const [terminals, setTerminals] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});  // id -> bool
  const [drafts, setDrafts] = useState({}); // id -> partial patch

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

  const setDraft = (id, patch) => setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));

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
      setDrafts((prev) => { const n = { ...prev }; delete n[id]; return n; });
      await reload();
    } catch (e) {
      alert(e.message);
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
      await reload();
    } catch (e) { alert(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  return (
    <V2Layout>
      <Head><title>Terminals · PickupGuard</title></Head>
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">Hikvision Terminals</h1>
            <p className="text-sm text-slate-400 mt-1">
              Auto-synced from <code>backend/devices.json</code> on listener startup.
              Bind each terminal to a release group + control its gate.
            </p>
          </div>
          <button onClick={reload} disabled={loading}
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm">
            <i className="ph ph-arrows-clockwise mr-2"></i>Refresh
          </button>
        </div>

        {err && <div className="mb-4 p-3 rounded bg-red-950/60 border border-red-500/40 text-red-200 text-sm">{err}</div>}
        {loading ? <div className="text-slate-400">Loading…</div> : (
          terminals.length === 0 ? (
            <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-8 text-center text-slate-400">
              No terminals registered yet. Start the Pandora backend (run_listeners.py) to auto-register.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-900/60 text-slate-300 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="px-3 py-2 text-left">IP</th>
                    <th className="px-3 py-2 text-left">Grade label</th>
                    <th className="px-3 py-2 text-left">Gate label</th>
                    <th className="px-3 py-2 text-left">Release group</th>
                    <th className="px-3 py-2 text-left">Gate</th>
                    <th className="px-3 py-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {terminals.map((t) => {
                    const draft = drafts[t.id] || {};
                    const dirty = Object.keys(draft).length > 0;
                    const effectiveGroup = draft.releaseGroupId !== undefined ? draft.releaseGroupId : t.releaseGroupId;
                    return (
                      <tr key={t.id} className="border-t border-slate-800 hover:bg-slate-900/30">
                        <td className="px-3 py-2 text-slate-100">
                          <div className="font-medium">{t.name}</div>
                          <div className="text-xs text-slate-500">{t.id}</div>
                        </td>
                        <td className="px-3 py-2 text-slate-300 font-mono text-xs">{t.ip || '—'}</td>
                        <td className="px-3 py-2">
                          <input
                            value={draft.gradeLabel ?? t.gradeLabel ?? ''}
                            onChange={(e) => setDraft(t.id, { gradeLabel: e.target.value })}
                            placeholder="e.g. PYP G3-G5"
                            className="w-32 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-xs"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={draft.gateLabel ?? t.gateLabel ?? ''}
                            onChange={(e) => setDraft(t.id, { gateLabel: e.target.value })}
                            placeholder="e.g. PYP Lobby"
                            className="w-32 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-xs"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={effectiveGroup || ''}
                            onChange={(e) => setDraft(t.id, { releaseGroupId: e.target.value || null })}
                            className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-xs"
                          >
                            <option value="">— none —</option>
                            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <div className="inline-flex rounded overflow-hidden border border-slate-700 text-xs">
                            <button
                              onClick={() => setGate(t.id, 'open')}
                              disabled={busy[t.id]}
                              className={`px-2 py-1 ${t.gateOverride === 'open' ? 'bg-emerald-700 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
                              Open
                            </button>
                            <button
                              onClick={() => setGate(t.id, null)}
                              disabled={busy[t.id]}
                              className={`px-2 py-1 ${!t.gateOverride ? 'bg-slate-700 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
                              Auto
                            </button>
                            <button
                              onClick={() => setGate(t.id, 'closed')}
                              disabled={busy[t.id]}
                              className={`px-2 py-1 ${t.gateOverride === 'closed' ? 'bg-rose-700 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
                              Close
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-2">
                            <button
                              onClick={() => save(t.id)}
                              disabled={!dirty || busy[t.id]}
                              className={`px-3 py-1 rounded text-xs ${dirty ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-slate-800 text-slate-500'}`}>
                              {busy[t.id] ? '…' : 'Save'}
                            </button>
                            {t.enabled === false && <span className="text-xs text-slate-500">disabled</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </V2Layout>
  );
}
