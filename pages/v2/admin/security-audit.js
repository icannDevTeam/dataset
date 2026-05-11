/**
 * /v2/admin/security-audit
 *
 * Sign-in events + device fingerprints + filterable access log. Pulls from the
 * existing /api/auth/access-log endpoint that the legacy Settings page used.
 */
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AdminLayout from '../../../components/v2/AdminLayout';

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

export default function SecurityAuditPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [logFilter, setLogFilter] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('all');

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/access-log?limit=300');
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const filtered = useMemo(() => {
    const q = logFilter.trim().toLowerCase();
    return logs.filter(l => {
      if (deviceFilter !== 'all' && l.device !== deviceFilter) return false;
      if (!q) return true;
      return ['ip', 'email', 'name', 'browser', 'os', 'device'].some(k => (l[k] || '').toLowerCase().includes(q));
    });
  }, [logs, logFilter, deviceFilter]);

  const stats = useMemo(() => {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const last24 = logs.filter(l => l.timestamp && new Date(l.timestamp).getTime() >= cutoff).length;
    const uniqueIPs = new Set(logs.map(l => l.ip).filter(Boolean)).size;
    const uniqueDevices = new Set(logs.map(l => `${l.ip}-${l.browser}`)).size;
    const uniqueUsers = new Set(logs.map(l => l.email).filter(Boolean)).size;
    return { total: logs.length, last24, uniqueIPs, uniqueDevices, uniqueUsers };
  }, [logs]);

  const byDevice = useMemo(() => {
    const out = { Desktop: 0, Mobile: 0, Tablet: 0, Other: 0 };
    logs.forEach(l => {
      const k = ['Desktop', 'Mobile', 'Tablet'].includes(l.device) ? l.device : 'Other';
      out[k]++;
    });
    return out;
  }, [logs]);

  const refreshAction = (
    <button onClick={fetchLogs}
      className="px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors">
      <i className={`ph ph-arrows-clockwise mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
    </button>
  );

  const STAT_TONE = {
    sky:     'bg-sky-500/10 text-sky-300 border-sky-500/30',
    emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    indigo:  'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',
    amber:   'bg-amber-500/10 text-amber-300 border-amber-500/30',
    fuchsia: 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30',
    slate:   'bg-slate-500/10 text-slate-300 border-slate-500/30',
  };

  return (
    <AdminLayout title="Security Audit" subtitle="Sign-in events, device fingerprints and IPs" actions={refreshAction}>
      <Head><title>Security Audit · Admin</title></Head>

      <div className="h-full flex flex-col min-h-0 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 flex-shrink-0">
          {[
            { label: 'Total events',    v: stats.total,         icon: 'ph-database',         tone: 'sky' },
            { label: 'Last 24h',        v: stats.last24,        icon: 'ph-clock-clockwise',  tone: 'emerald' },
            { label: 'Unique users',    v: stats.uniqueUsers,   icon: 'ph-users',            tone: 'indigo' },
            { label: 'Unique IPs',      v: stats.uniqueIPs,     icon: 'ph-globe',            tone: 'amber' },
            { label: 'Unique devices',  v: stats.uniqueDevices, icon: 'ph-devices',          tone: 'fuchsia' },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-3 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${STAT_TONE[s.tone]}`}>
                <i className={`ph ${s.icon} text-lg`} />
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider">{s.label}</div>
                <div className="text-xl font-light text-white leading-tight">{s.v}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Filters + device breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 flex-shrink-0">
          <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-3 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <i className="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm" />
              <input
                value={logFilter}
                onChange={e => setLogFilter(e.target.value)}
                placeholder="Filter by IP, user, browser, OS…"
                className="w-full pl-8 pr-8 py-1.5 text-xs bg-slate-900/60 border border-slate-700/60 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-brand-500"
              />
              {logFilter && (
                <button onClick={() => setLogFilter('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
                  <i className="ph ph-x text-sm" />
                </button>
              )}
            </div>
            <select value={deviceFilter} onChange={e => setDeviceFilter(e.target.value)}
              className="bg-slate-900/60 border border-slate-700/60 rounded-lg px-3 py-1.5 text-xs text-white">
              <option value="all">All devices</option>
              <option value="Desktop">Desktop</option>
              <option value="Mobile">Mobile</option>
              <option value="Tablet">Tablet</option>
            </select>
            {(logFilter || deviceFilter !== 'all') && (
              <span className="text-[10px] text-slate-500 ml-1">{filtered.length} of {logs.length}</span>
            )}
          </div>

          <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 px-3 py-2 flex items-center gap-3 text-[11px]">
            {[
              { k: 'Desktop', icon: 'ph-desktop',        cls: 'bg-slate-500/10 text-slate-300 border-slate-500/30' },
              { k: 'Mobile',  icon: 'ph-device-mobile',  cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
              { k: 'Tablet',  icon: 'ph-device-tablet',  cls: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30' },
            ].map(d => (
              <div key={d.k} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${d.cls}`}>
                <i className={`ph ${d.icon}`} />
                <span className="font-mono">{byDevice[d.k] || 0}</span>
                <span className="text-[10px] uppercase tracking-wider opacity-70">{d.k}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Log table fills remaining height */}
        <div className="flex-1 min-h-0 rounded-xl border border-slate-700/40 bg-slate-900/30 overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 overflow-auto">
            {loading && logs.length === 0 ? (
              <div className="p-12 text-center"><div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" /></div>
            ) : filtered.length === 0 ? (
              <div className="p-12 text-center text-xs text-slate-500">
                {logs.length === 0 ? 'No access logs yet — they appear after the next sign-in.' : 'No logs match your filters.'}
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-900/80 backdrop-blur text-slate-400 uppercase tracking-wider text-[10px] sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2.5 text-left">User</th>
                    <th className="px-3 py-2.5 text-left">IP</th>
                    <th className="px-3 py-2.5 text-left">Device</th>
                    <th className="px-3 py-2.5 text-left">Browser</th>
                    <th className="px-3 py-2.5 text-left">OS</th>
                    <th className="px-3 py-2.5 text-right">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {filtered.map(log => (
                    <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-3 py-2">
                        <div className="font-medium text-white text-xs">{log.name || '—'}</div>
                        <div className="text-[10px] text-slate-500">{log.email}</div>
                      </td>
                      <td className="px-3 py-2">
                        <code className="text-[10px] font-mono text-slate-300 bg-slate-800/50 px-1.5 py-0.5 rounded">{log.ip || '—'}</code>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 text-[11px] ${
                          log.device === 'Mobile' ? 'text-amber-400' :
                          log.device === 'Tablet' ? 'text-indigo-400' : 'text-slate-300'
                        }`}>
                          <i className={`ph ${log.device === 'Mobile' ? 'ph-device-mobile' : log.device === 'Tablet' ? 'ph-device-tablet' : 'ph-desktop'}`} />
                          {log.device || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[11px] text-slate-300">{log.browser || '—'}</td>
                      <td className="px-3 py-2 text-[11px] text-slate-400">{log.os || '—'}</td>
                      <td className="px-3 py-2 text-right text-[11px] text-slate-400 whitespace-nowrap">{timeAgo(log.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
