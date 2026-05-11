/**
 * Shared System Audit panel — surfaces every mutating action recorded in the
 * audit log (settings changes, user lifecycle, device pairings, pickup overrides).
 *
 * Data source: GET /api/pickup/admin/audit-log (returns { entries, facets }).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const AUDIT_KIND_META = {
  'settings.update':         { icon: 'ph-gear-six',          tone: 'amber',   label: 'Settings updated' },
  'user.invite':             { icon: 'ph-user-plus',         tone: 'emerald', label: 'User invited' },
  'user.delete':             { icon: 'ph-user-minus',        tone: 'red',     label: 'User deleted' },
  'user.suspend':            { icon: 'ph-pause-circle',      tone: 'amber',   label: 'User suspended' },
  'user.unsuspend':          { icon: 'ph-play-circle',       tone: 'emerald', label: 'User unsuspended' },
  'user.role_change':        { icon: 'ph-user-gear',         tone: 'indigo',  label: 'Role changed' },
  'user.permissions':        { icon: 'ph-key',               tone: 'indigo',  label: 'Permissions updated' },
  'user.revoke':             { icon: 'ph-prohibit',          tone: 'red',     label: 'Access revoked' },
  'device.pair':             { icon: 'ph-device-tablet',     tone: 'sky',     label: 'TV paired' },
  'device.unpair':           { icon: 'ph-x-circle',          tone: 'red',     label: 'TV unpaired' },
  'device.revoke':           { icon: 'ph-prohibit-inset',    tone: 'amber',   label: 'TV revoked' },
  'pickup.officer_override': { icon: 'ph-shield-warning',    tone: 'amber',   label: 'Officer override' },
  'pickup.manual_release':   { icon: 'ph-hand-waving',       tone: 'sky',     label: 'Manual release' },
  'chaperone.enroll':        { icon: 'ph-user-circle-plus',  tone: 'emerald', label: 'Chaperone enrolled' },
  'chaperone.reenroll':      { icon: 'ph-arrows-clockwise',  tone: 'sky',     label: 'Chaperone re-enrolled' },
  'chaperone.reject':        { icon: 'ph-x-circle',          tone: 'red',     label: 'Chaperone rejected' },
};

const TONE_CLASSES = {
  amber:   'bg-amber-500/15 text-amber-200 border-amber-500/30',
  emerald: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
  red:     'bg-red-500/15 text-red-200 border-red-500/30',
  indigo:  'bg-indigo-500/15 text-indigo-200 border-indigo-500/30',
  sky:     'bg-sky-500/15 text-sky-200 border-sky-500/30',
  slate:   'bg-slate-500/15 text-slate-200 border-slate-500/30',
};

function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sec = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export default function AuditTrailPanel({ embedded = false }) {
  const [entries, setEntries] = useState([]);
  const [facets, setFacets] = useState({ kinds: [], actors: [] });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState({ kind: '', from: '', to: '', actor: '', q: '' });
  const [expanded, setExpanded] = useState(() => new Set());

  const fetchAudit = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ limit: '300' });
      Object.entries(filter).forEach(([k, v]) => { if (v) params.set(k, v); });
      const r = await fetch(`/api/pickup/admin/audit-log?${params.toString()}`, { credentials: 'include' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'Fetch failed');
      setEntries(Array.isArray(j.entries) ? j.entries : []);
      setFacets(j.facets || { kinds: [], actors: [] });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchAudit(); }, [fetchAudit]);

  const stats = useMemo(() => {
    const total = entries.length;
    const actorSet = new Set(entries.map(e => e.actor?.email).filter(Boolean));
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const last24 = entries.filter(e => {
      const t = e.at ? new Date(e.at).getTime() : 0;
      return t && t >= cutoff;
    }).length;
    const criticalKinds = /(delete|revoke|unpair|role_change|officer_override)/;
    const critical = entries.filter(e => criticalKinds.test(e.kind || '')).length;
    return { total, actors: actorSet.size, last24, critical };
  }, [entries]);

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className={embedded ? 'space-y-4' : 'h-full flex flex-col min-h-0'}>
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-shrink-0">
        {[
          { label: 'Total events',     value: stats.total,    icon: 'ph-database',        tone: 'sky' },
          { label: 'Unique actors',    value: stats.actors,   icon: 'ph-users-three',     tone: 'indigo' },
          { label: 'Last 24h',         value: stats.last24,   icon: 'ph-clock-clockwise', tone: 'emerald' },
          { label: 'Critical actions', value: stats.critical, icon: 'ph-warning-octagon', tone: 'amber' },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-3 flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${TONE_CLASSES[s.tone]}`}>
              <i className={`ph ${s.icon} text-lg`} />
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">{s.label}</div>
              <div className="text-xl font-light text-white leading-tight">{s.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-3 grid grid-cols-1 md:grid-cols-5 gap-2 flex-shrink-0">
        <input
          type="text"
          placeholder="Search summary, target, JSON…"
          value={filter.q}
          onChange={e => setFilter(f => ({ ...f, q: e.target.value }))}
          className="bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-slate-500 md:col-span-2"
        />
        <select value={filter.kind} onChange={e => setFilter(f => ({ ...f, kind: e.target.value }))}
          className="bg-slate-900/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-white">
          <option value="">All actions</option>
          {facets.kinds.map(k => (
            <option key={k} value={k}>{AUDIT_KIND_META[k]?.label || k}</option>
          ))}
        </select>
        <select value={filter.actor} onChange={e => setFilter(f => ({ ...f, actor: e.target.value }))}
          className="bg-slate-900/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-white">
          <option value="">All actors</option>
          {facets.actors.map(a => (<option key={a} value={a}>{a}</option>))}
        </select>
        <div className="flex gap-1.5">
          <input type="date" value={filter.from} onChange={e => setFilter(f => ({ ...f, from: e.target.value }))}
            className="bg-slate-900/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-white flex-1" />
          <input type="date" value={filter.to} onChange={e => setFilter(f => ({ ...f, to: e.target.value }))}
            className="bg-slate-900/60 border border-slate-700/50 rounded-lg px-2 py-1.5 text-xs text-white flex-1" />
        </div>
        <div className="md:col-span-5 flex items-center justify-between">
          <button onClick={() => setFilter({ kind: '', from: '', to: '', actor: '', q: '' })}
            className="text-[11px] text-slate-400 hover:text-white">
            <i className="ph ph-arrow-counter-clockwise mr-1" /> Reset filters
          </button>
          <button onClick={fetchAudit} disabled={loading}
            className="px-3 py-1 text-[11px] rounded-lg border border-slate-600/50 text-slate-200 hover:bg-slate-800/60 disabled:opacity-50">
            <i className={`ph ph-arrows-clockwise mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-200 flex-shrink-0">
          <i className="ph ph-warning-circle mr-2" />{err}
        </div>
      )}

      {/* Entries — scrollable */}
      <div className={`rounded-xl border border-slate-700/40 bg-slate-900/30 ${embedded ? '' : 'flex-1 min-h-0'} overflow-hidden flex flex-col`}>
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-900/80 backdrop-blur text-slate-400 uppercase tracking-wider text-[10px] sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2.5 text-left">When</th>
                <th className="px-3 py-2.5 text-left">Actor</th>
                <th className="px-3 py-2.5 text-left">Action</th>
                <th className="px-3 py-2.5 text-left">Target</th>
                <th className="px-3 py-2.5 text-left">Summary</th>
                <th className="px-3 py-2.5 text-right">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading && entries.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500"><i className="ph ph-spinner animate-spin mr-2" />Loading audit history…</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500">No audit entries match these filters.</td></tr>
              ) : entries.map(e => {
                const meta = AUDIT_KIND_META[e.kind] || { icon: 'ph-circle', tone: 'slate', label: e.kind };
                const isOpen = expanded.has(e.id);
                return (
                  <React.Fragment key={e.id}>
                    <tr className="hover:bg-slate-800/30 cursor-pointer" onClick={() => toggle(e.id)}>
                      <td className="px-3 py-2 text-slate-300 whitespace-nowrap" title={e.at}>{timeAgo(e.at)}</td>
                      <td className="px-3 py-2">
                        <div className="text-white text-xs">{e.actor?.email || <span className="text-slate-500 italic">unknown</span>}</div>
                        {e.actor?.role && <div className="text-[10px] text-slate-500">{e.actor.role}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] border ${TONE_CLASSES[meta.tone]}`}>
                          <i className={`ph ${meta.icon}`} /> {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-300">
                        {e.target?.label || e.target?.id || <span className="text-slate-500">—</span>}
                        {e.target?.type && <div className="text-[10px] text-slate-500">{e.target.type}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-300">{e.summary || <span className="text-slate-500">—</span>}</td>
                      <td className="px-3 py-2 text-right text-[10px] text-slate-500 font-mono">{e.ip || '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-900/40">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Before</div>
                              <pre className="bg-slate-950/70 border border-slate-800 rounded-md p-3 text-[11px] text-slate-300 overflow-auto max-h-60">{JSON.stringify(e.before || null, null, 2)}</pre>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">After</div>
                              <pre className="bg-slate-950/70 border border-slate-800 rounded-md p-3 text-[11px] text-slate-300 overflow-auto max-h-60">{JSON.stringify(e.after || null, null, 2)}</pre>
                            </div>
                          </div>
                          {e.metadata && Object.keys(e.metadata).length > 0 && (
                            <div className="mt-2">
                              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Metadata</div>
                              <pre className="bg-slate-950/70 border border-slate-800 rounded-md p-3 text-[11px] text-slate-300 overflow-auto max-h-40">{JSON.stringify(e.metadata, null, 2)}</pre>
                            </div>
                          )}
                          <div className="mt-2 text-[10px] text-slate-500 flex flex-wrap gap-x-6 gap-y-1">
                            <div><span className="text-slate-600">UA:</span> {e.userAgent || '—'}</div>
                            <div><span className="text-slate-600">ID:</span> <span className="font-mono">{e.id}</span></div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
