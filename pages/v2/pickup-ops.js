/**
 * /v2/pickup-ops
 *
 * PickupGuard Operations Interface — Cisco-style live metrics dashboard.
 *
 * Sections:
 *   1. Interface Status    — per-terminal "show interface" panel (dark monospace)
 *   2. Device Registry     — all paired TVs, tablets, and Hikvision terminals
 *   3. Live Event Ticker   — real-time SSE feed of pickup events
 *   4. Listener Console    — Python listener log tail with colored entries
 *   5. Throughput Table    — per-gate stats: 5m / 1h / 24h + error breakdown
 */
import Head from 'next/head';
import { useEffect, useRef, useState, useCallback } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import MonitorTopNav from '../../components/v2/MonitorTopNav';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function relTime(isoStr) {
  if (!isoStr) return '—';
  const delta = Date.now() - Date.parse(isoStr);
  if (delta < 0) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86400_000) return `${Math.round(delta / 3600_000)}h ago`;
  return new Date(isoStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function fmtUptime(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtLastSeen(ms) {
  if (!ms) return 'never';
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
function confidence_bar(pct) {
  if (pct == null) return '—';
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
function Card({ title, icon, children, className = '', action, dark = false }) {
  return (
    <div className={`border rounded-2xl shadow-sm ${dark ? 'bg-gray-950 border-gray-800' : 'bg-white border-gray-200'} ${className}`}>
      <div className={`flex items-center justify-between flex-wrap gap-2 px-5 py-3.5 border-b ${dark ? 'border-gray-800' : 'border-gray-100'}`}>
        <div className="flex items-center gap-2.5">
          <i className={`ph ${icon} text-lg ${dark ? 'text-cyan-400' : 'text-gray-500'}`}></i>
          <span className={`text-sm font-semibold ${dark ? 'text-gray-100' : 'text-gray-800'}`}>{title}</span>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function StatusDot({ status, pulse = false }) {
  const map = {
    up: 'bg-emerald-400', down: 'bg-red-500', unknown: 'bg-gray-400',
    paired: 'bg-emerald-400', unpaired: 'bg-gray-400', enabled: 'bg-blue-400',
    disabled: 'bg-gray-400', revoked: 'bg-red-400', online: 'bg-emerald-400',
    offline: 'bg-red-400',
  };
  const color = map[status] || 'bg-gray-400';
  return (
    <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${color} ${pulse ? 'animate-pulse' : ''}`}></span>
  );
}

function Badge({ variant = 'gray', children, mono = false }) {
  const map = {
    green: 'bg-emerald-100 text-emerald-700', red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-700',     blue: 'bg-blue-100 text-blue-700',
    gray:  'bg-gray-100 text-gray-600',       cyan: 'bg-cyan-100 text-cyan-700',
    dark:  'bg-gray-800 text-cyan-300',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${map[variant] || map.gray} ${mono ? 'font-mono' : ''}`}>
      {children}
    </span>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="h-5 w-5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin"></div>
    </div>
  );
}

// ─── Cisco-style "show interface" card ────────────────────────────────────────
const LOG_LEVEL_COLOR = {
  success: 'text-emerald-400',
  warn:    'text-amber-400',
  error:   'text-red-400',
  status:  'text-cyan-300 font-semibold',
  info:    'text-gray-300',
};

function InterfaceCard({ iface }) {
  const up = iface.status === 'up';
  const m = iface.metrics;
  const lastSeenStr = fmtLastSeen(iface.msSinceLastSeen);
  const lastEvAt = iface.lastEvent?.at;

  return (
    <div className={`rounded-xl border font-mono text-xs leading-relaxed overflow-hidden ${up ? 'border-emerald-800/60 bg-gray-950' : 'border-red-900/60 bg-gray-950'}`}>
      {/* Header line */}
      <div className={`px-4 py-2.5 border-b ${up ? 'border-emerald-900/50 bg-emerald-950/40' : 'border-red-900/50 bg-red-950/30'}`}>
        <span className={`font-bold ${up ? 'text-emerald-300' : 'text-red-400'}`}>
          {iface.name}
        </span>
        <span className="text-gray-500 mx-2">—</span>
        <span className={up ? 'text-emerald-400' : 'text-red-400'}>
          {up ? 'is UP' : 'is DOWN'}, line protocol is {up ? 'UP (active)' : 'DOWN'}
        </span>
        {!iface.enabled && <span className="ml-3 text-amber-400">[ADMINISTRATIVELY DISABLED]</span>}
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-0.5 text-gray-400">
        <div>
          <span className="text-gray-600 select-none">  Hardware is </span>
          <span className="text-gray-200">{iface.hardware || 'Hikvision Face Terminal'}</span>
          {iface.ip && <span className="text-gray-500">, IP address {iface.ip}</span>}
        </div>
        {(iface.gradeLabel || iface.gateLabel) && (
          <div>
            <span className="text-gray-600 select-none">  Description: </span>
            <span className="text-cyan-300">
              {[iface.gateLabel, iface.gradeLabel].filter(Boolean).join(' — ')}
            </span>
          </div>
        )}
        {(iface.windowOpen || iface.windowClose) && (
          <div>
            <span className="text-gray-600 select-none">  Gate window: </span>
            <span className="text-gray-300">{iface.windowOpen || '??:??'} – {iface.windowClose || '??:??'} WIB</span>
          </div>
        )}
        <div className="pt-1">
          <span className="text-gray-600 select-none">  Last input: </span>
          <span className="text-gray-200">{lastSeenStr}</span>
          <span className="text-gray-600">,  Last pickup event: </span>
          <span className="text-gray-200">{lastEvAt ? relTime(lastEvAt) : 'never'}</span>
        </div>
        <div>
          <span className="text-gray-600 select-none">  5 min scan rate: </span>
          <span className="text-yellow-300">{m.total5min} events</span>
          <span className="text-gray-600">  1-hour total: </span>
          <span className="text-yellow-300">{m.total1h} events</span>
          <span className="text-gray-600">  24-hour total: </span>
          <span className="text-yellow-300">{m.total24h} events</span>
        </div>
        <div>
          <span className="text-gray-600 select-none">  Scan rate: </span>
          <span className="text-gray-200">{m.ratePerMin} events/min avg (1h)</span>
        </div>
        {m.avgConfidence != null && (
          <div>
            <span className="text-gray-600 select-none">  Avg confidence: </span>
            <span className={m.avgConfidence >= 85 ? 'text-emerald-400' : m.avgConfidence >= 70 ? 'text-amber-400' : 'text-red-400'}>
              {confidence_bar(m.avgConfidence)}
            </span>
          </div>
        )}
        <div className="pt-1 border-t border-gray-800/50 mt-1">
          <span className="text-gray-600 select-none">  Input queue: </span>
          <span className="text-gray-300">0/∞ (size/max)</span>
          <span className="text-gray-600">; Total output drops: </span>
          <span className={m.outputDrops > 0 ? 'text-red-400' : 'text-gray-300'}>{m.outputDrops}</span>
        </div>
        <div>
          <span className="text-gray-600 select-none">  </span>
          <span className={m.inputErrors > 0 ? 'text-red-400' : 'text-gray-300'}>
            {m.inputErrors} input errors
          </span>
          <span className="text-gray-600">, </span>
          <span className={m.unknownChaperone > 0 ? 'text-red-400' : 'text-gray-300'}>
            {m.unknownChaperone} unknown chaperones
          </span>
          <span className="text-gray-600">, </span>
          <span className={m.spoofAttempts > 0 ? 'text-red-400' : 'text-gray-300'}>
            {m.spoofAttempts} spoof attempts
          </span>
        </div>
        <div>
          <span className="text-gray-600 select-none">  </span>
          <span className={m.lowConfidence > 0 ? 'text-amber-400' : 'text-gray-300'}>
            {m.lowConfidence} low confidence
          </span>
          <span className="text-gray-600">, </span>
          <span className={m.officerOverrides > 0 ? 'text-cyan-400' : 'text-gray-300'}>
            {m.officerOverrides} officer overrides
          </span>
          <span className="text-gray-600">, 0 interface resets</span>
        </div>
        {iface.lastEvent && (
          <div className="pt-1 border-t border-gray-800/50 mt-1 text-gray-500">
            <span>  Last event: </span>
            <span className={
              iface.lastEvent.cardState === 'green' ? 'text-emerald-400' :
              iface.lastEvent.cardState === 'yellow' ? 'text-amber-400' : 'text-red-400'
            }>
              {iface.lastEvent.studentName || iface.lastEvent.chaperoneId || 'chaperone'}
            </span>
            {iface.lastEvent.confidence != null && (
              <span className="text-gray-600"> — {iface.lastEvent.confidence}% confidence</span>
            )}
            {iface.lastEvent.officerOverride && <span className="text-cyan-400"> [OVERRIDE]</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Device row ───────────────────────────────────────────────────────────────
const TYPE_ICON = { terminal: 'ph-fingerprint', tv: 'ph-television', tablet: 'ph-device-tablet' };
const TYPE_LABEL = { terminal: 'Terminal', tv: 'TV Screen', tablet: 'Tablet' };

function DeviceRow({ device }) {
  const online = device.online;
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <StatusDot status={online ? 'online' : 'offline'} pulse={online} />
          <i className={`ph ${TYPE_ICON[device.type] || 'ph-cpu'} text-gray-400`}></i>
          <span className="text-sm font-medium text-gray-800 max-w-[160px] truncate">{device.name}</span>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <Badge variant={device.type === 'terminal' ? 'blue' : device.type === 'tv' ? 'purple' : 'gray'}>
          {TYPE_LABEL[device.type]}
        </Badge>
      </td>
      <td className="px-3 py-2.5">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${online ? 'text-emerald-700' : 'text-gray-400'}`}>
          <StatusDot status={online ? 'online' : 'offline'} />
          {online ? 'Online' : 'Offline'}
        </span>
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500 max-w-[120px] truncate">
        {device.gate || device.grade || '—'}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-400 whitespace-nowrap">
        {device.heartbeatAt ? relTime(device.heartbeatAt) : 'Never'}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-400 max-w-[140px] truncate">
        {device.profileName || device.releaseGroupName || device.ip || <span className="text-gray-300">—</span>}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-400 max-w-[120px] truncate">
        {device.hardware || '—'}
      </td>
    </tr>
  );
}

// ─── Live event ticker entry ──────────────────────────────────────────────────
const CARD_STATE_STYLE = {
  green:  { badge: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-400', label: 'CLEARED' },
  yellow: { badge: 'bg-amber-100 text-amber-700',     dot: 'bg-amber-400',   label: 'FLAGGED' },
  red:    { badge: 'bg-red-100 text-red-700',         dot: 'bg-red-500',     label: 'DENIED'  },
};

function EventRow({ ev, isNew }) {
  const cs = CARD_STATE_STYLE[ev.cardState] || CARD_STATE_STYLE.green;
  return (
    <div className={`flex items-start gap-3 py-2 border-b border-gray-50 last:border-0 transition-all duration-500 ${isNew ? 'bg-blue-50/60' : ''}`}>
      <span className={`mt-1 h-2 w-2 rounded-full flex-shrink-0 ${cs.dot}`}></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${cs.badge}`}>{cs.label}</span>
          <span className="text-sm font-medium text-gray-800 truncate">
            {ev.studentName || ev.chaperoneName || ev.chaperoneId || 'Unknown'}
          </span>
          {ev.officerOverride && <Badge variant="cyan">OVERRIDE</Badge>}
          {ev.spoofDetected && <Badge variant="red">SPOOF</Badge>}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
          <span><i className="ph ph-fingerprint mr-1"></i>{ev.gate}</span>
          {ev.confidence != null && <span>{ev.confidence}% conf</span>}
          <span>{relTime(ev.recordedAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Listener log entry ───────────────────────────────────────────────────────
function LogLine({ entry }) {
  const color = LOG_LEVEL_COLOR[entry.level] || 'text-gray-400';
  const termColor = {
    'Basement 1 Terminal': 'text-cyan-400',
    'PYP Lobby Entrance': 'text-yellow-400',
    'MYP Tower': 'text-purple-400',
  };
  const tc = entry.terminal ? (termColor[entry.terminal] || 'text-teal-400') : '';

  return (
    <div className="flex gap-2 py-0.5 font-mono text-xs leading-5 hover:bg-gray-800/30">
      {entry.ts && <span className="text-gray-600 flex-shrink-0 select-none">{entry.ts.slice(11)}</span>}
      {entry.terminal && (
        <span className={`flex-shrink-0 ${tc}`}>[{entry.terminal}]</span>
      )}
      <span className={`${color} break-all`}>{entry.message || entry.raw}</span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PickupOpsPage() {
  const [opsData, setOpsData]       = useState(null);
  const [opsErr, setOpsErr]         = useState(null);
  const [devices, setDevices]       = useState(null);
  const [listenerLog, setListenerLog] = useState(null);
  const [events, setEvents]         = useState([]);
  const [newEventIds, setNewEventIds] = useState(new Set());
  const [sseStatus, setSseStatus]   = useState('connecting');
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const sseRef = useRef(null);
  const eventsRef = useRef([]);
  const intervalRef = useRef(null);

  const fetchOps = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/ops-metrics');
      const j = await r.json();
      if (j.ok) { setOpsData(j); setOpsErr(null); }
      else setOpsErr(j.error || `HTTP ${r.status}`);
    } catch (e) { setOpsErr(e.message); }
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/devices-status');
      const j = await r.json();
      if (j.ok) setDevices(j);
    } catch { /* non-critical */ }
  }, []);

  const fetchLog = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/listener-log?lines=120');
      const j = await r.json();
      if (j.ok) setListenerLog(j);
    } catch { /* non-critical */ }
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    await Promise.all([fetchOps(), fetchDevices(), fetchLog()]);
    setLastRefresh(new Date());
    if (!silent) setRefreshing(false);
  }, [fetchOps, fetchDevices, fetchLog]);

  // SSE live events
  const connectSSE = useCallback(() => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    setSseStatus('connecting');

    const es = new EventSource('/api/pickup/admin/admin-event-stream');
    sseRef.current = es;

    es.addEventListener('pickup_event', (e) => {
      try {
        const ev = JSON.parse(e.data);
        setSseStatus('live');
        setEvents((prev) => {
          const next = [ev, ...prev].slice(0, 50);
          eventsRef.current = next;
          return next;
        });
        setNewEventIds((prev) => {
          const next = new Set(prev);
          next.add(ev.id);
          setTimeout(() => setNewEventIds((s) => { const n = new Set(s); n.delete(ev.id); return n; }), 3000);
          return next;
        });
      } catch { /* bad JSON */ }
    });

    es.addEventListener('heartbeat', () => setSseStatus('live'));
    es.onerror = () => {
      setSseStatus('reconnecting');
      setTimeout(connectSSE, 5000);
    };
  }, []);

  useEffect(() => {
    refresh();
    connectSSE();
    intervalRef.current = setInterval(() => refresh(true), 30_000);
    return () => {
      clearInterval(intervalRef.current);
      if (sseRef.current) sseRef.current.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const interfaces = opsData?.interfaces || [];
  const devList    = devices?.devices || [];
  const logEntries = listenerLog?.entries || [];
  const listenerStatus = listenerLog?.listenerStatus || [];

  const onlineDevices  = devList.filter((d) => d.online).length;
  const upInterfaces   = interfaces.filter((i) => i.status === 'up').length;
  const totalEvents24h = interfaces.reduce((s, i) => s + i.metrics.total24h, 0);
  const totalErrors    = interfaces.reduce((s, i) => s + i.metrics.inputErrors, 0);

  return (
    <>
      <Head><title>Operations Interface · PickupGuard</title></Head>
      <V2Layout>
        <div className="min-h-screen bg-gray-50 text-gray-900" style={{ colorScheme: 'light' }}>
          <MonitorTopNav />
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 pb-8">

            {/* ── Header ──────────────────────────────────────────────── */}
            <div className="flex items-end justify-between flex-wrap gap-3 mb-5">
              <div>
                <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                  <span className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-gray-900 shadow-sm">
                    <i className="ph ph-terminal-window text-cyan-400 text-lg"></i>
                  </span>
                  Operations Interface
                </h1>
                <p className="text-sm text-gray-500 mt-1">
                  Live terminal interfaces, device registry, and listener console.
                  {lastRefresh && <span className="ml-2 text-gray-400">Updated {lastRefresh.toLocaleTimeString('en-GB')}</span>}
                </p>
              </div>
              <button
                onClick={() => refresh()}
                disabled={refreshing}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800 disabled:opacity-50 shadow-sm"
              >
                <i className={`ph ph-arrows-clockwise ${refreshing ? 'animate-spin' : ''}`}></i>
                Refresh
              </button>
            </div>

            {/* ── Quick stats ──────────────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              {[
                { label: 'Interfaces UP', value: `${upInterfaces}/${interfaces.length}`, variant: upInterfaces === interfaces.length && interfaces.length > 0 ? 'up' : 'warn' },
                { label: 'Devices online', value: `${onlineDevices}/${devList.length}`, variant: onlineDevices > 0 ? 'up' : 'down' },
                { label: 'Events (24h)', value: totalEvents24h, variant: 'neutral' },
                { label: 'Input errors (24h)', value: totalErrors, variant: totalErrors > 0 ? 'err' : 'neutral' },
              ].map((s) => (
                <div key={s.label} className={`p-4 rounded-xl border ${
                  s.variant === 'up' ? 'bg-emerald-50 border-emerald-200' :
                  s.variant === 'down' ? 'bg-red-50 border-red-200' :
                  s.variant === 'warn' ? 'bg-amber-50 border-amber-200' :
                  s.variant === 'err' ? 'bg-red-50 border-red-200' :
                  'bg-gray-50 border-gray-100'
                }`}>
                  <p className="text-xs font-medium text-gray-500 mb-1">{s.label}</p>
                  <p className={`text-2xl font-bold tabular-nums ${
                    s.variant === 'up' ? 'text-emerald-700' :
                    s.variant === 'down' ? 'text-red-700' :
                    s.variant === 'warn' ? 'text-amber-700' :
                    s.variant === 'err' && totalErrors > 0 ? 'text-red-700' :
                    'text-gray-800'
                  }`}>{s.value ?? '—'}</p>
                </div>
              ))}
            </div>

            {/* ── Section 1: Interface status ─────────────────────────── */}
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
              <i className="ph ph-circles-three-plus text-gray-400"></i> Interface Status
              <span className="text-gray-300">— show interfaces detail</span>
            </h2>
            {!opsData && !opsErr && <div className="mb-6"><Spinner /></div>}
            {opsErr && (
              <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">⚠ {opsErr}</div>
            )}
            {interfaces.length > 0 && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
                {interfaces.map((iface) => (
                  <InterfaceCard key={iface.id || iface.name} iface={iface} />
                ))}
              </div>
            )}
            {opsData && interfaces.length === 0 && (
              <div className="mb-6 p-4 rounded-xl bg-gray-950 border border-gray-800 font-mono text-xs text-gray-500 text-center">
                No pickup events recorded yet — interfaces will appear once terminals start firing.
              </div>
            )}

            {/* ── Section 2 + 3: Devices + Live ticker side by side ───── */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-5">

              {/* Device registry — 2/3 width */}
              <div className="xl:col-span-2">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <i className="ph ph-devices text-gray-400"></i> Device Registry
                </h2>
                <Card title="All Paired Devices" icon="ph-devices" className="h-full">
                  {devices?.summary && (
                    <div className="flex flex-wrap gap-2 mb-4">
                      <Badge variant="blue">{devices.summary.terminalEnabled}/{devices.summary.terminalTotal} terminals</Badge>
                      <Badge variant="cyan">{devices.summary.tvPaired}/{devices.summary.tvTotal} TV screens</Badge>
                      <Badge variant="gray">{devices.summary.tabletPaired}/{devices.summary.tabletTotal} tablets</Badge>
                      <Badge variant={onlineDevices > 0 ? 'green' : 'red'}>{onlineDevices} online now</Badge>
                    </div>
                  )}
                  {!devices && <Spinner />}
                  {devList.length === 0 && devices && (
                    <p className="text-sm text-gray-400 text-center py-6">No devices registered yet.</p>
                  )}
                  {devList.length > 0 && (
                    <div className="overflow-x-auto rounded-xl border border-gray-100">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
                            <th className="px-3 py-2 text-left">Device</th>
                            <th className="px-3 py-2 text-left">Type</th>
                            <th className="px-3 py-2 text-left">State</th>
                            <th className="px-3 py-2 text-left">Gate / Grade</th>
                            <th className="px-3 py-2 text-left">Last seen</th>
                            <th className="px-3 py-2 text-left">Profile / Group</th>
                            <th className="px-3 py-2 text-left">Hardware</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 bg-white">
                          {devList.map((d) => <DeviceRow key={`${d.type}-${d.id}`} device={d} />)}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </div>

              {/* Live event ticker — 1/3 width */}
              <div>
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <i className="ph ph-broadcast text-gray-400"></i> Live Event Feed
                  <span className={`ml-1 h-2 w-2 rounded-full ${
                    sseStatus === 'live' ? 'bg-emerald-500 animate-pulse' :
                    sseStatus === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-gray-400'
                  }`}></span>
                  <span className="text-gray-300 text-xs capitalize">{sseStatus}</span>
                </h2>
                <Card title="Pickup Events — Realtime" icon="ph-lightning" className="h-full">
                  {events.length === 0 && (
                    <div className="py-8 text-center">
                      <div className="h-3 w-3 mx-auto mb-3 rounded-full bg-amber-400 animate-pulse"></div>
                      <p className="text-xs text-gray-400">Waiting for events…</p>
                      <p className="text-xs text-gray-300 mt-1">Connected via SSE</p>
                    </div>
                  )}
                  <div className="max-h-[480px] overflow-y-auto">
                    {events.map((ev) => (
                      <EventRow key={ev.id} ev={ev} isNew={newEventIds.has(ev.id)} />
                    ))}
                  </div>
                  {events.length > 0 && (
                    <p className="text-xs text-gray-400 text-center mt-3 pt-3 border-t border-gray-100">
                      Showing last {events.length} events
                    </p>
                  )}
                </Card>
              </div>
            </div>

            {/* ── Section 4: Listener console ──────────────────────────── */}
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
              <i className="ph ph-code text-gray-400"></i> Python Listener Console
              {listenerLog?.path && <span className="text-gray-600 text-xs font-mono font-normal">{listenerLog.path}</span>}
            </h2>
            <Card dark title="listeners.log — tail" icon="ph-terminal" className="mb-5"
              action={
                <div className="flex items-center gap-3 flex-wrap">
                  {listenerStatus.length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {listenerStatus.map((ls) => (
                        <span key={ls.terminal} className={`text-xs font-mono flex items-center gap-1 ${ls.running ? 'text-emerald-400' : 'text-red-400'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${ls.running ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`}></span>
                          {ls.terminal.split(' ')[0]}
                          {ls.pid && <span className="text-gray-600">/{ls.pid}</span>}
                          {ls.uptime && <span className="text-gray-600"> up {ls.uptime}</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  <button onClick={fetchLog} className="text-xs text-cyan-400 hover:text-cyan-300">Reload</button>
                </div>
              }
            >
              {!listenerLog && <Spinner />}
              {listenerLog?._note && (
                <p className="font-mono text-xs text-amber-400">{listenerLog._note}</p>
              )}
              {logEntries.length > 0 && (
                <div className="max-h-72 overflow-y-auto scroll-smooth">
                  <div className="space-y-0">
                    {logEntries.map((entry, i) => <LogLine key={i} entry={entry} />)}
                  </div>
                </div>
              )}
              {listenerLog && logEntries.length === 0 && (
                <p className="font-mono text-xs text-gray-600">— No log entries —</p>
              )}
            </Card>

            {/* ── Section 5: Throughput table ──────────────────────────── */}
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
              <i className="ph ph-chart-bar text-gray-400"></i> Throughput &amp; Error Breakdown
            </h2>
            {opsData && interfaces.length > 0 && (
              <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm mb-6">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <th className="px-4 py-3 text-left">Interface / Gate</th>
                      <th className="px-4 py-3 text-center">Status</th>
                      <th className="px-4 py-3 text-right">5m events</th>
                      <th className="px-4 py-3 text-right">1h events</th>
                      <th className="px-4 py-3 text-right">24h events</th>
                      <th className="px-4 py-3 text-right">Rate/min</th>
                      <th className="px-4 py-3 text-right">Avg conf</th>
                      <th className="px-4 py-3 text-right">Unknown</th>
                      <th className="px-4 py-3 text-right">Spoof</th>
                      <th className="px-4 py-3 text-right">Low conf</th>
                      <th className="px-4 py-3 text-right">Overrides</th>
                      <th className="px-4 py-3 text-left">Last scan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {interfaces.map((iface) => {
                      const m = iface.metrics;
                      const up = iface.status === 'up';
                      return (
                        <tr key={iface.id || iface.name} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <StatusDot status={iface.status} />
                              <div>
                                <p className="font-medium text-gray-800">{iface.name}</p>
                                {iface.hardware && <p className="text-xs text-gray-400">{iface.hardware}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-xs font-bold ${up ? 'text-emerald-600' : 'text-red-500'}`}>
                              {up ? 'UP' : 'DOWN'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-gray-700">{m.total5min}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-gray-700">{m.total1h}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-800">{m.total24h}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-gray-500 text-xs">{m.ratePerMin}</td>
                          <td className="px-4 py-3 text-right">
                            {m.avgConfidence != null ? (
                              <span className={`text-xs font-semibold ${m.avgConfidence >= 85 ? 'text-emerald-600' : m.avgConfidence >= 70 ? 'text-amber-600' : 'text-red-600'}`}>
                                {m.avgConfidence}%
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={m.unknownChaperone > 0 ? 'text-red-600 font-semibold' : 'text-gray-300'}>{m.unknownChaperone}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={m.spoofAttempts > 0 ? 'text-red-600 font-semibold' : 'text-gray-300'}>{m.spoofAttempts}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={m.lowConfidence > 0 ? 'text-amber-600 font-semibold' : 'text-gray-300'}>{m.lowConfidence}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={m.officerOverrides > 0 ? 'text-cyan-600 font-semibold' : 'text-gray-300'}>{m.officerOverrides}</span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                            {iface.lastEvent?.at ? relTime(iface.lastEvent.at) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {/* Totals row */}
                  <tfoot>
                    <tr className="bg-gray-50 border-t-2 border-gray-200 font-semibold">
                      <td className="px-4 py-3 text-gray-700" colSpan={2}>TOTAL</td>
                      <td className="px-4 py-3 text-right tabular-nums">{interfaces.reduce((s, i) => s + i.metrics.total5min, 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{interfaces.reduce((s, i) => s + i.metrics.total1h, 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{totalEvents24h}</td>
                      <td className="px-4 py-3 text-right text-xs tabular-nums text-gray-500">
                        {(interfaces.reduce((s, i) => s + i.metrics.ratePerMin, 0)).toFixed(2)}
                      </td>
                      <td className="px-4 py-3"></td>
                      <td className="px-4 py-3 text-right tabular-nums text-red-600">{interfaces.reduce((s, i) => s + i.metrics.unknownChaperone, 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-red-600">{interfaces.reduce((s, i) => s + i.metrics.spoofAttempts, 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-amber-600">{interfaces.reduce((s, i) => s + i.metrics.lowConfidence, 0)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-cyan-600">{interfaces.reduce((s, i) => s + i.metrics.officerOverrides, 0)}</td>
                      <td className="px-4 py-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <div className="flex items-center justify-between text-xs text-gray-400 pb-4">
              <span>Auto-refreshes every 30 seconds · Live events via SSE · All times WIB (UTC+7)</span>
              <span>PickupGuard Ops · BINUSFace</span>
            </div>

          </div>
        </div>
      </V2Layout>
    </>
  );
}
