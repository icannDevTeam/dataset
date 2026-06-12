/**
 * /v2/system-interfaces
 *
 * PickupGuard Service Interfaces — Cisco "show interfaces" style NOC view.
 *
 * Displays every external service the system talks to as a named network
 * interface with realistic Cisco-style fields: hardware type, BW/DLY/load,
 * 5-minute input/output rates, full error counters, and UP/DOWN/DEGRADED status.
 *
 * Services shown:
 *   GigabitEthernet0/0  — Firebase / Firestore
 *   GigabitEthernet0/1  — Resend / Transactional Email
 *   Serial0/N           — Hikvision face terminal (one per registered device)
 *   Tunnel0/N           — WhatsApp Broadcast
 *   Tunnel0/N           — BINUS School API
 *   Loopback0           — Firebase Cloud Functions
 */
import Head from 'next/head';
import { useEffect, useRef, useState, useCallback } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import MonitorTopNav from '../../components/v2/MonitorTopNav';
import TopologyDiagram from '../../components/v2/topology/TopologyDiagram';

const REFRESH_SEC = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtBits(bitsPerSec) {
  if (bitsPerSec == null) return '0 bits/sec';
  if (bitsPerSec < 1000) return `${bitsPerSec} bits/sec`;
  if (bitsPerSec < 1_000_000) return `${(bitsPerSec / 1000).toFixed(1)} Kbits/sec`;
  return `${(bitsPerSec / 1_000_000).toFixed(1)} Mbits/sec`;
}
function fmtPkts(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
function fmtBytes(n) {
  if (!n) return '0';
  if (n < 1024) return `${n}`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1_048_576).toFixed(1)}M`;
}
function relTime(iso) {
  if (!iso) return '—';
  const d = Date.now() - Date.parse(iso);
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

// ─── Status helpers ───────────────────────────────────────────────────────────
const STATUS_COLOR = {
  up:           { line: 'text-emerald-400', badge: 'bg-emerald-900/60 text-emerald-300 border border-emerald-700' },
  degraded:     { line: 'text-amber-400',   badge: 'bg-amber-900/60   text-amber-300   border border-amber-700' },
  down:         { line: 'text-red-400',     badge: 'bg-red-900/60     text-red-300     border border-red-700' },
  unconfigured: { line: 'text-gray-500',    badge: 'bg-gray-800/60    text-gray-400    border border-gray-700' },
};
function sc(status) { return STATUS_COLOR[status] || STATUS_COLOR.unconfigured; }
function statusLabel(status) {
  if (status === 'up')           return 'UP';
  if (status === 'degraded')     return 'DEGRADED';
  if (status === 'down')         return 'DOWN';
  if (status === 'unconfigured') return 'UNCONFIGURED';
  return 'UNKNOWN';
}

// ─── Cisco Interface Card ─────────────────────────────────────────────────────
function ServiceInterfaceCard({ iface }) {
  const { counters: c } = iface;
  const col = sc(iface.status);
  const isDown = iface.status === 'down' || iface.status === 'unconfigured';
  const lineProto = iface.status === 'up' ? 'UP' : iface.status === 'degraded' ? 'UP' : 'DOWN';
  const lineProtoNote = iface.status === 'up' ? '(connected)' : iface.status === 'degraded' ? '(degraded)' : iface.status === 'unconfigured' ? '(not configured)' : '(protocol down)';

  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden font-mono text-xs">
      {/* Header bar */}
      <div className={`flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 ${isDown ? 'bg-gray-900/60' : 'bg-gray-900'}`}>
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider ${col.badge}`}>
          {statusLabel(iface.status)}
        </span>
        <span className="text-gray-200 font-semibold text-sm">{iface.ifName}</span>
        <span className="text-gray-400 text-xs">— {iface.name}</span>
        {iface.probe?.latencyMs != null && (
          <span className="ml-auto text-gray-500 text-[10px]">{iface.probe.latencyMs}ms</span>
        )}
      </div>

      {/* Cisco-style output */}
      <div className="px-4 pt-3 pb-4 space-y-0.5 leading-5">
        {/* Line 1: interface status */}
        <div>
          <span className={col.line}>
            {iface.ifName} is {statusLabel(iface.status)}, line protocol is {lineProto} {lineProtoNote}
          </span>
        </div>

        {/* Line 2: hardware */}
        <div className="text-gray-400">
          {'  '}Hardware is {iface.hardware}{iface.address ? `, internet address is ${iface.address}` : ''}
        </div>

        {/* Description */}
        {iface.description && (
          <div className="text-gray-500">{'  '}Description: {iface.description}</div>
        )}

        {/* MTU / BW / DLY */}
        <div className="text-gray-400">
          {'  '}MTU {iface.mtu} bytes, BW {(iface.bwKbps / 1000).toLocaleString()} Kbit/sec,{' '}
          DLY {iface.delayUsec.toLocaleString()} usec,{' '}
          rely {iface.reliabilityStr}, load {iface.txload}
        </div>

        <div className="text-gray-500">
          {'  '}Encapsulation {iface.encapsulation}, loopback not set
        </div>
        <div className="text-gray-500">
          {'  '}Keepalive set (30 sec)
        </div>
        <div className="text-gray-500">
          {'  '}Full-duplex, auto-speed, link type is auto
        </div>
        <div className="text-gray-500">
          {'  '}input flow-control is on, output flow-control is supported
        </div>

        {/* Last input / output */}
        <div className="text-gray-500">
          {'  '}Last input{' '}
          {iface.probe?.checkedAt ? relTime(iface.probe.checkedAt) : 'never'},{' '}
          output {iface.probe?.checkedAt ? relTime(iface.probe.checkedAt) : 'never'},{' '}
          output hang never
        </div>

        <div className="text-gray-600">
          {'  '}Last clearing of &quot;show interface&quot; counters: 24h rolling window
        </div>

        {/* Queues */}
        <div className="text-gray-500">
          {'  '}Input queue: 0/∞ (size/max/drops); Total output drops: {c.outputDrops}
        </div>
        <div className="text-gray-500">
          {'  '}Queueing strategy: weighted fair
        </div>
        <div className="text-gray-500">
          {'  '}Output queue: 0/∞ (size/max)
        </div>

        {/* Rate block — highlighted */}
        <div className="mt-1">
          <span className="text-cyan-400">
            {'  '}5 minute input rate {fmtBits(c.inputBitsRate5min)},{' '}
            {c.inputRate5min < 0.01 ? '0' : c.inputRate5min.toFixed(4)} packets/sec
          </span>
        </div>
        <div>
          <span className="text-cyan-400">
            {'  '}5 minute output rate {fmtBits(c.outputBitsRate5min)},{' '}
            {c.outputRate5min < 0.01 ? '0' : c.outputRate5min.toFixed(4)} packets/sec
          </span>
        </div>

        {/* Input counters */}
        <div className="mt-1 text-gray-400">
          {'     '}{fmtPkts(c.inputPackets)} packets input, {fmtBytes(c.inputBytes)} bytes, 0 no buffer
        </div>
        <div className="text-gray-500">
          {'     '}0 runts, 0 giants, 0 throttles
        </div>
        <div className={c.inputErrors > 0 ? 'text-amber-400' : 'text-gray-500'}>
          {'     '}{c.inputErrors} input errors, {c.crcErrors} CRC, {c.frameErrors} frame,{' '}
          {c.overruns} overrun, 0 ignored
        </div>

        {/* Output counters */}
        <div className="text-gray-400">
          {'     '}{fmtPkts(c.outputPackets)} packets output, {fmtBytes(c.outputBytes)} bytes, 0 underruns
        </div>
        <div className={c.outputErrors > 0 ? 'text-red-400' : 'text-gray-500'}>
          {'     '}{c.outputErrors} output errors, {c.collisions} collisions,{' '}
          {c.interfaceResets} interface resets
        </div>
        <div className="text-gray-500">
          {'     '}0 unknown protocol drops
        </div>
        <div className="text-gray-500">
          {'     '}0 babbles, 0 late collision, 0 deferred
        </div>
        <div className="text-gray-500">
          {'     '}0 lost carrier, 0 no carrier, 0 pause output
        </div>
        <div className="text-gray-500">
          {'     '}0 output buffer failures, 0 output buffers swapped out
        </div>

        {/* Probe error note */}
        {iface.probe?.error && (
          <div className="mt-1 text-red-400">
            {'  '}[probe error: {iface.probe.error}]
          </div>
        )}
        {iface.probe?.note && (
          <div className="mt-1 text-gray-500 italic">
            {'  '}# {iface.probe.note}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── API key panel ────────────────────────────────────────────────────────────
const KEY_LABELS = {
  RESEND_API_KEY:   'RESEND_API_KEY',
  API_KEY:          'API_KEY (BINUS)',
  HIKVISION_USER:   'HIKVISION_USER',
  HIKVISION_PASS:   'HIKVISION_PASS',
  WHATSAPP_WEBHOOK: 'WHATSAPP_WEBHOOK',
  FIREBASE:         'FIREBASE_PROJECT',
};

function KeyStatusDot({ status }) {
  if (status === 'ok' || status === 'configured')
    return <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-2" />;
  if (status === 'missing')
    return <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-2" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-gray-600 mr-2" />;
}

function ApiKeyPanel({ keys }) {
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 bg-gray-900 flex items-center gap-2">
        <i className="ph ph-key text-base text-amber-400" />
        <span className="text-gray-100 font-semibold text-sm">Credential & Key Status</span>
        <span className="ml-2 text-gray-500 text-xs font-mono">— masked server-side, raw values never transmitted</span>
      </div>
      <div className="p-4">
        <table className="w-full text-xs font-mono border-collapse">
          <thead>
            <tr className="text-gray-600 text-[10px] uppercase tracking-wider border-b border-gray-800">
              <th className="text-left pb-2 pr-6 font-medium">Key / Credential</th>
              <th className="text-left pb-2 pr-6 font-medium">Masked Value</th>
              <th className="text-left pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(keys).map(([k, v]) => (
              <tr key={k} className="border-b border-gray-900 last:border-0">
                <td className="py-2 pr-6 text-gray-300">{KEY_LABELS[k] || k}</td>
                <td className="py-2 pr-6 text-gray-500">
                  {v.masked ? <span className="text-amber-300/80">{v.masked}</span> : <span className="text-gray-700 italic">—</span>}
                </td>
                <td className="py-2">
                  <span className="flex items-center">
                    <KeyStatusDot status={v.status} />
                    <span className={
                      v.status === 'ok' || v.status === 'configured'
                        ? 'text-emerald-400'
                        : v.status === 'missing'
                        ? 'text-red-400'
                        : 'text-gray-500'
                    }>
                      {v.status === 'ok' ? 'OK' : v.status === 'configured' ? 'Configured' : v.status === 'missing' ? 'Not configured' : v.status}
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SystemInterfacesPage() {
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_SEC);
  const timerRef = useRef(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, hr] = await Promise.all([
        fetch('/api/pickup/admin/service-interfaces', { credentials: 'include' }),
        fetch('/api/pickup/admin/system-health', { credentials: 'include' }).catch(() => null),
      ]);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = await r.json();
      setData(j);
      if (hr && hr.ok) {
        const hj = await hr.json().catch(() => null);
        if (hj) setHealth(hj);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setCountdown(REFRESH_SEC);
    }
  }, []);

  // Initial load
  useEffect(() => { fetchData(); }, [fetchData]);

  // Countdown + auto-refresh
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) { fetchData(); return REFRESH_SEC; }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [fetchData]);

  const summary = data?.summary || {};
  const interfaces = data?.interfaces || [];
  const keys = data?.keys || {};

  return (
    <V2Layout>
      <Head><title>Service Interfaces — PickupGuard</title></Head>

      {/* Top monitor nav tabs */}
      <MonitorTopNav />

      <div className="px-4 sm:px-6 lg:px-8 pb-12 max-w-screen-2xl mx-auto">

        {/* Page header */}
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-gray-100 flex items-center gap-2">
              <i className="ph ph-plugs-connected text-xl text-cyan-400" />
              Service Interfaces
            </h1>
            <p className="text-gray-500 text-sm mt-0.5">
              External service connections modelled as Cisco network interfaces —{' '}
              <span className="font-mono text-[11px]">show interfaces</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data?.generatedAt && (
              <span className="text-gray-600 text-xs font-mono">
                Probed {relTime(data.generatedAt)}
              </span>
            )}
            <span className="text-gray-700 text-xs font-mono">
              Next refresh in <span className="text-cyan-500">{countdown}s</span>
            </span>
            <button
              onClick={fetchData}
              className="px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-900 text-gray-300 text-xs hover:border-gray-500 transition-colors flex items-center gap-1.5"
            >
              <i className={`ph ph-arrows-clockwise text-sm ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-red-950/50 border border-red-800 text-red-300 rounded-lg px-4 py-3 text-sm font-mono">
            Error: {error}
          </div>
        )}

        {/* Quick stat bar */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              {
                label: 'Interfaces UP',
                value: `${summary.upCount ?? '—'}/${summary.totalCount ?? '—'}`,
                icon: 'ph-activity',
                color: summary.upCount === summary.totalCount ? 'text-emerald-400' : 'text-amber-400',
              },
              {
                label: 'Hikvision Reachable',
                value: `${summary.hikReachable ?? '—'}/${summary.hikTotal ?? '—'}`,
                icon: 'ph-fingerprint',
                color: summary.hikReachable === summary.hikTotal ? 'text-emerald-400' : 'text-red-400',
              },
              {
                label: 'Keys Configured',
                value: `${summary.keyConfigured ?? '—'}/${summary.keyTotal ?? '—'}`,
                icon: 'ph-key',
                color: summary.keyConfigured === summary.keyTotal ? 'text-emerald-400' : 'text-amber-400',
              },
              {
                label: 'Firestore Latency',
                value: summary.fsLatencyMs != null ? `${summary.fsLatencyMs}ms` : '—',
                icon: 'ph-database',
                color: summary.fsLatencyMs != null && summary.fsLatencyMs < 200 ? 'text-emerald-400' : 'text-amber-400',
              },
            ].map((s) => (
              <div key={s.label} className="bg-gray-900/80 border border-gray-800 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2 text-gray-500 text-xs mb-1">
                  <i className={`ph ${s.icon} text-sm`} />
                  {s.label}
                </div>
                <div className={`text-2xl font-bold font-mono ${s.color}`}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Network topology diagram */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <i className="ph ph-graph text-sm text-purple-400" />
            <span className="text-gray-300 text-sm font-semibold">Live Network Topology</span>
            <span className="ml-2 text-gray-600 text-xs font-mono">— click a node for show interface detail</span>
          </div>
          <TopologyDiagram
            interfaces={interfaces}
            health={health}
            onSelect={(iface) => setSelected(iface.id)}
          />
        </div>

        {/* Interface cards */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <i className="ph ph-network text-sm text-cyan-400" />
            <h2 className="text-gray-200 text-sm font-semibold">Interface Status</h2>
            <span className="ml-2 text-gray-600 text-xs font-mono">
              — {interfaces.length} interfaces total
            </span>
          </div>
          {loading && !data && (
            <div className="text-gray-600 text-sm font-mono animate-pulse py-8 text-center">
              Probing interfaces…
            </div>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {interfaces.map((iface) => (
              <ServiceInterfaceCard key={iface.id} iface={iface} />
            ))}
          </div>
        </div>

        {/* API key panel */}
        {data && Object.keys(keys).length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <i className="ph ph-shield-check text-sm text-amber-400" />
              <h2 className="text-gray-200 text-sm font-semibold">Credential & Key Status</h2>
            </div>
            <ApiKeyPanel keys={keys} />
          </div>
        )}

        {/* Footer note */}
        <p className="text-gray-700 text-xs font-mono text-center mt-8">
          Packet counters are derived from Firestore query aggregations over rolling 24h windows.
          Rates are computed from 5-minute and 1-hour buckets. Hikvision terminals are probed live via ISAPI/Digest Auth.
        </p>
      </div>

      {/* Node detail slide-over */}
      {selected && (() => {
        const iface = interfaces.find((i) => i.id === selected);
        if (!iface) return null;
        return (
          <div className="v2-dark fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={() => setSelected(null)}>
            <div
              className="w-full max-w-2xl h-full overflow-y-auto bg-gray-950 border-l border-gray-800 p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-gray-100 font-semibold text-sm flex items-center gap-2">
                  <i className="ph ph-plugs-connected text-cyan-400" />
                  {iface.ifName} — {iface.name}
                </h2>
                <button
                  onClick={() => setSelected(null)}
                  className="px-2.5 py-1.5 rounded-lg border border-gray-700 bg-gray-900 text-gray-400 text-xs hover:border-gray-500"
                >
                  <i className="ph ph-x" /> Close
                </button>
              </div>
              <ServiceInterfaceCard iface={iface} />
            </div>
          </div>
        );
      })()}
    </V2Layout>
  );
}
