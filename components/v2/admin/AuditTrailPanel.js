/**
 * Shared System Audit panel — surfaces every mutating action recorded in the
 * audit log (settings changes, user lifecycle, device pairings, pickup overrides).
 *
 * Data source: GET /api/pickup/admin/audit-log (returns { entries, facets }).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FEATURES } from '../../../lib/permissions';

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

// ── Human-readable diff helpers ──────────────────────────────────────
// Pretty-print a permission feature key using FEATURES metadata when
// available; otherwise title-case the snake_case key.
function featureLabel(key) {
  if (FEATURES?.[key]?.label) return FEATURES[key].label;
  return String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function prettyKey(k) {
  return String(k)
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function diffArray(beforeArr, afterArr) {
  const b = new Set(Array.isArray(beforeArr) ? beforeArr : []);
  const a = new Set(Array.isArray(afterArr)  ? afterArr  : []);
  const added   = [...a].filter(x => !b.has(x));
  const removed = [...b].filter(x => !a.has(x));
  return { added, removed };
}

// Compare two permission maps. Each value can be a bool (top-level toggle)
// or an object of action→bool. Returns { granted, revoked } lists of
// human-readable descriptions.
function diffPermissions(before, after) {
  const granted = [];
  const revoked = [];
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after  || {}),
  ]);
  for (const key of keys) {
    const bv = (before || {})[key];
    const av = (after  || {})[key];
    if (valuesEqual(bv, av)) continue;

    const label = featureLabel(key);

    // Bool-shaped (matches user sample: { ai_parameters: false, ... })
    if (typeof bv === 'boolean' || typeof av === 'boolean'
        || (bv == null && typeof av === 'boolean')
        || (av == null && typeof bv === 'boolean')) {
      if (av === true && bv !== true) granted.push(label);
      else if (av !== true && bv === true) revoked.push(label);
      continue;
    }

    // Action-map shape: { view: bool, edit: bool, ... }
    if (isPlainObject(bv) || isPlainObject(av)) {
      const actions = new Set([
        ...Object.keys(bv || {}),
        ...Object.keys(av  || {}),
      ]);
      for (const action of actions) {
        const ba = (bv || {})[action];
        const aa = (av || {})[action];
        if (ba === aa) continue;
        const display = `${label} · ${prettyKey(action)}`;
        if (aa === true && ba !== true) granted.push(display);
        else if (aa !== true && ba === true) revoked.push(display);
      }
      continue;
    }

    // Fallback: any other change → just show the transition
    if (av) granted.push(`${label} (${JSON.stringify(av)})`);
    if (bv) revoked.push(`${label} (${JSON.stringify(bv)})`);
  }
  granted.sort((a, b) => a.localeCompare(b));
  revoked.sort((a, b) => a.localeCompare(b));
  return { granted, revoked };
}

function ChipList({ items, tone }) {
  if (!items || items.length === 0) return null;
  const cls = tone === 'add'
    ? 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30'
    : tone === 'remove'
    ? 'bg-red-500/10 text-red-200 border-red-500/30'
    : 'bg-slate-500/10 text-slate-200 border-slate-500/30';
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it, i) => (
        <span key={`${tone}-${i}`} className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border ${cls}`}>
          {it}
        </span>
      ))}
    </div>
  );
}

function ChangeRow({ icon, iconClass, label, children }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <i className={`ph ${icon} ${iconClass} text-sm mt-0.5`} />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
        <div className="text-xs text-slate-200 mt-0.5">{children}</div>
      </div>
    </div>
  );
}

// Detect entries whose before/after carry RBAC-shaped fields. Used to
// decide between human-readable and raw rendering.
function isRbacShape(before, after) {
  const fields = ['role', 'classScopes', 'permissions'];
  const has = obj => isPlainObject(obj) && fields.some(f => f in obj);
  return has(before) || has(after);
}

function HumanDiff({ before, after }) {
  const rows = [];
  const bRole = (before || {}).role;
  const aRole = (after  || {}).role;
  if (bRole !== aRole && (bRole || aRole)) {
    rows.push(
      <ChangeRow key="role" icon="ph-user-gear" iconClass="text-indigo-300" label="Role">
        <span className="font-mono text-slate-400">{bRole || '—'}</span>
        <i className="ph ph-arrow-right text-slate-500 mx-1.5" />
        <span className="font-mono text-white">{aRole || '—'}</span>
      </ChangeRow>
    );
  }

  const scopes = diffArray((before || {}).classScopes, (after || {}).classScopes);
  if (scopes.added.length || scopes.removed.length) {
    rows.push(
      <ChangeRow key="scopes" icon="ph-stack" iconClass="text-sky-300" label="Class scopes">
        <div className="space-y-1">
          {scopes.added.length   > 0 && (<div className="flex items-center gap-1.5 flex-wrap"><span className="text-[10px] text-emerald-400">added</span><ChipList items={scopes.added}   tone="add" /></div>)}
          {scopes.removed.length > 0 && (<div className="flex items-center gap-1.5 flex-wrap"><span className="text-[10px] text-red-400">removed</span><ChipList items={scopes.removed} tone="remove" /></div>)}
        </div>
      </ChangeRow>
    );
  }

  const perms = diffPermissions((before || {}).permissions, (after || {}).permissions);
  if (perms.granted.length || perms.revoked.length) {
    rows.push(
      <ChangeRow key="perms" icon="ph-key" iconClass="text-amber-300" label="Permissions">
        <div className="space-y-1">
          {perms.granted.length > 0 && (<div className="flex items-center gap-1.5 flex-wrap"><span className="text-[10px] text-emerald-400">granted</span><ChipList items={perms.granted} tone="add" /></div>)}
          {perms.revoked.length > 0 && (<div className="flex items-center gap-1.5 flex-wrap"><span className="text-[10px] text-red-400">revoked</span><ChipList items={perms.revoked} tone="remove" /></div>)}
        </div>
      </ChangeRow>
    );
  }

  // Surface any other top-level field changes generically.
  const handled = new Set(['role', 'classScopes', 'permissions']);
  const otherKeys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after  || {}),
  ].filter(k => !handled.has(k)));
  for (const k of otherKeys) {
    const bv = (before || {})[k];
    const av = (after  || {})[k];
    if (valuesEqual(bv, av)) continue;
    rows.push(
      <ChangeRow key={`other-${k}`} icon="ph-pencil-simple" iconClass="text-slate-400" label={prettyKey(k)}>
        <span className="font-mono text-slate-400 break-all">{bv == null ? '—' : (typeof bv === 'string' ? bv : JSON.stringify(bv))}</span>
        <i className="ph ph-arrow-right text-slate-500 mx-1.5" />
        <span className="font-mono text-white break-all">{av == null ? '—' : (typeof av === 'string' ? av : JSON.stringify(av))}</span>
      </ChangeRow>
    );
  }

  if (rows.length === 0) {
    return <div className="text-[11px] text-slate-500 italic">No detectable changes between before and after.</div>;
  }
  return <div className="divide-y divide-slate-800/60">{rows}</div>;
}

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
  const [rawOpen, setRawOpen]   = useState(() => new Set());

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

  const toggleRaw = (id) => {
    setRawOpen(prev => {
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
                          {(() => {
                            const hasBefore = e.before != null;
                            const hasAfter  = e.after  != null;
                            const useHuman  = (hasBefore || hasAfter) && isRbacShape(e.before, e.after);
                            const showRaw   = rawOpen.has(e.id);
                            if (useHuman && !showRaw) {
                              return (
                                <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="text-[10px] uppercase tracking-wider text-slate-500">Changes</div>
                                    <button type="button" onClick={() => toggleRaw(e.id)} className="text-[10px] text-slate-400 hover:text-white">
                                      <i className="ph ph-code mr-1" />View raw JSON
                                    </button>
                                  </div>
                                  <HumanDiff before={e.before} after={e.after} />
                                </div>
                              );
                            }
                            return (
                              <>
                                {useHuman && (
                                  <div className="flex justify-end mb-2">
                                    <button type="button" onClick={() => toggleRaw(e.id)} className="text-[10px] text-slate-400 hover:text-white">
                                      <i className="ph ph-eye mr-1" />Hide raw JSON
                                    </button>
                                  </div>
                                )}
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
                              </>
                            );
                          })()}
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
