import { useEffect, useState } from 'react';

export const STATUS_COLOR = {
  up:           { line: 'text-emerald-400', badge: 'bg-emerald-900/60 text-emerald-300 border border-emerald-700' },
  degraded:     { line: 'text-amber-400',   badge: 'bg-amber-900/60   text-amber-300   border border-amber-700' },
  down:         { line: 'text-red-400',     badge: 'bg-red-900/60     text-red-300     border border-red-700' },
  unconfigured: { line: 'text-gray-500',    badge: 'bg-gray-800/60    text-gray-400    border border-gray-700' },
};

export function sc(status) { return STATUS_COLOR[status] || STATUS_COLOR.unconfigured; }

export function statusLabel(status) {
  if (status === 'up')           return 'UP';
  if (status === 'degraded')     return 'DEGRADED';
  if (status === 'down')         return 'DOWN';
  if (status === 'unconfigured') return 'UNCONFIGURED';
  return 'UNKNOWN';
}

export function relTime(iso) {
  if (!iso) return '—';
  const d = Date.now() - Date.parse(iso);
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

function fmtRate(r) {
  if (r == null || r < 0.01) return '0';
  return r.toFixed(2);
}

// ─── Collapsible section ──────────────────────────────────────────────────────
export function Section({ id, icon, iconColor, title, note, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    try {
      const v = localStorage.getItem(`si-sec:${id}`);
      if (v != null) setOpen(v === '1');
    } catch { /* ignore */ }
  }, [id]);
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem(`si-sec:${id}`, o ? '0' : '1'); } catch { /* ignore */ }
    return !o;
  });
  return (
    <div className="mb-6">
      <button onClick={toggle} className="w-full flex items-center gap-2 mb-3 group text-left">
        <i className={`ph ${icon} text-sm ${iconColor}`} />
        <span className="text-gray-200 text-sm font-semibold">{title}</span>
        {note && <span className="ml-2 text-gray-600 text-xs font-mono hidden sm:inline">{note}</span>}
        <i className={`ph ph-caret-down ml-auto text-gray-600 group-hover:text-gray-400 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && children}
    </div>
  );
}

// ─── Compact interface table ──────────────────────────────────────────────────
export function InterfaceTable({ interfaces, onSelect }) {
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-x-auto">
      <table className="w-full text-xs font-mono whitespace-nowrap">
        <thead>
          <tr className="text-gray-600 text-[10px] uppercase tracking-wider border-b border-gray-800">
            <th className="text-left px-4 py-2.5 font-medium">Status</th>
            <th className="text-left px-4 py-2.5 font-medium">Interface</th>
            <th className="text-left px-4 py-2.5 font-medium">Service</th>
            <th className="text-right px-4 py-2.5 font-medium">In pps</th>
            <th className="text-right px-4 py-2.5 font-medium">Out pps</th>
            <th className="text-right px-4 py-2.5 font-medium">Latency</th>
            <th className="text-right px-4 py-2.5 font-medium">Probed</th>
            <th className="px-2 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {interfaces.map((iface) => {
            const col = sc(iface.status);
            return (
              <tr
                key={iface.id}
                onClick={() => onSelect(iface.id)}
                className="border-b border-gray-900 last:border-0 hover:bg-gray-900/60 cursor-pointer"
              >
                <td className="px-4 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${col.badge}`}>
                    {statusLabel(iface.status)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-200 font-semibold">{iface.ifName}</td>
                <td className="px-4 py-2.5 text-gray-400">{iface.name}</td>
                <td className="px-4 py-2.5 text-right text-cyan-400">{fmtRate(iface.counters?.inputRate5min)}</td>
                <td className="px-4 py-2.5 text-right text-cyan-400">{fmtRate(iface.counters?.outputRate5min)}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">
                  {iface.probe?.latencyMs != null ? `${iface.probe.latencyMs}ms` : '—'}
                </td>
                <td className="px-4 py-2.5 text-right text-gray-500">{relTime(iface.probe?.checkedAt)}</td>
                <td className="px-2 py-2.5 text-gray-600"><i className="ph ph-caret-right" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Security monitor ─────────────────────────────────────────────────────────
export function SecurityMonitor({ health }) {
  const sec = health?.security;
  const rl = health?.rateLimit;
  const q = health?.emailQueue || {};
  const blocked15 = rl?.blockedLast15min ?? 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Security incidents */}
      <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <i className="ph ph-shield-warning text-base text-red-400" />
          <span className="text-gray-200 text-xs font-semibold">Security Incidents</span>
        </div>
        <div className="flex gap-6">
          <div>
            <div className={`text-2xl font-bold font-mono ${(sec?.last1h ?? 0) > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              {sec?.last1h ?? '—'}
            </div>
            <div className="text-gray-600 text-[10px] uppercase tracking-wider mt-0.5">Last hour</div>
          </div>
          <div>
            <div className={`text-2xl font-bold font-mono ${(sec?.last24h ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {sec?.last24h ?? '—'}
            </div>
            <div className="text-gray-600 text-[10px] uppercase tracking-wider mt-0.5">Last 24h</div>
          </div>
        </div>
        <p className="text-gray-600 text-[10px] font-mono mt-3">
          GPS spoofing, liveness failures, forged tokens, unauthorized pickups
        </p>
      </div>

      {/* Rate limiting / abuse */}
      <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <i className="ph ph-gauge text-base text-amber-400" />
          <span className="text-gray-200 text-xs font-semibold">Rate Limiting / Abuse</span>
        </div>
        {rl ? (
          <>
            <div className="flex gap-6">
              <div>
                <div className={`text-2xl font-bold font-mono ${blocked15 > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {blocked15}
                </div>
                <div className="text-gray-600 text-[10px] uppercase tracking-wider mt-0.5">Blocked 15min</div>
              </div>
              <div>
                <div className="text-2xl font-bold font-mono text-gray-300">{rl.blockedTotal}</div>
                <div className="text-gray-600 text-[10px] uppercase tracking-wider mt-0.5">Blocked total</div>
              </div>
              <div>
                <div className="text-2xl font-bold font-mono text-gray-300">{rl.allowedTotal}</div>
                <div className="text-gray-600 text-[10px] uppercase tracking-wider mt-0.5">Allowed</div>
              </div>
            </div>
            {rl.recentBlocks?.length > 0 ? (
              <div className="mt-3 space-y-1">
                {rl.recentBlocks.slice(0, 3).map((b, i) => (
                  <div key={i} className="text-[10px] font-mono text-red-400/80">
                    429 · {b.bucket} · {b.ip} · {relTime(b.at)}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-600 text-[10px] font-mono mt-3">
                No 429s — per-IP limits active on public endpoints
              </p>
            )}
          </>
        ) : (
          <p className="text-gray-600 text-xs font-mono">no telemetry yet — counters reset on instance restart</p>
        )}
      </div>

      {/* Email queue */}
      <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <i className="ph ph-envelope-simple text-base text-cyan-400" />
          <span className="text-gray-200 text-xs font-semibold">Email Queue (24h)</span>
        </div>
        <div className="flex gap-6 flex-wrap">
          {[
            { label: 'Pending', value: q.pending, color: (q.pending ?? 0) > 0 ? 'text-amber-400' : 'text-gray-300' },
            { label: 'Sent', value: q.sent, color: 'text-emerald-400' },
            { label: 'Failed', value: q.failed, color: (q.failed ?? 0) > 0 ? 'text-red-400' : 'text-gray-300' },
            { label: 'Retrying', value: q.retrying, color: (q.retrying ?? 0) > 0 ? 'text-amber-400' : 'text-gray-300' },
          ].map((s) => (
            <div key={s.label}>
              <div className={`text-2xl font-bold font-mono ${s.color}`}>{s.value ?? '—'}</div>
              <div className="text-gray-600 text-[10px] uppercase tracking-wider mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
        {q.recentErrors?.length > 0 && (
          <div className="mt-3 space-y-1">
            {q.recentErrors.slice(0, 2).map((e) => (
              <div key={e.id} className="text-[10px] font-mono text-red-400/80 truncate">
                ✕ {e.templateType || 'email'} → {e.to || '?'} · {e.error}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
