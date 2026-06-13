/**
 * /v2/pickup-monitor
 *
 * PickupGuard System Monitor — light-mode operational dashboard.
 *
 * Panels:
 *   1. System Health Bar    — Firestore, Resend email, WhatsApp, Firebase Functions
 *   2. API Endpoint Status  — latency probe of key pickup routes
 *   3. Notification Log     — email queue jobs: sent / failed / pending + errors
 *   4. Security Events      — recent incidents, 24h / 1h counts, kind breakdown
 *   5. Onboarding & Flow    — pending approvals, recent pickup events, live rate
 *   6. Campaign History     — bulk email campaigns sent
 */
import Head from 'next/head';
import { useEffect, useRef, useState, useCallback } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import MonitorTopNav from '../../components/v2/MonitorTopNav';
import { useAuth } from '../../lib/AuthContext';
import rbac from '../../lib/rbac';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function relTime(isoStr) {
  if (!isoStr) return '—';
  const delta = Date.now() - Date.parse(isoStr);
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86400_000) return `${Math.round(delta / 3600_000)}h ago`;
  return new Date(isoStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function fmtTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
function Card({ title, icon, children, className = '', action }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-2xl shadow-sm ${className}`}>
      <div className="flex items-center justify-between flex-wrap gap-2 px-5 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          <i className={`ph ${icon} text-lg text-gray-500`}></i>
          <span className="text-sm font-semibold text-gray-800">{title}</span>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

const STATUS_CONFIG = {
  ok:    { bg: 'bg-emerald-50',  text: 'text-emerald-700',  border: 'border-emerald-200', dot: 'bg-emerald-500',  label: 'OK' },
  warn:  { bg: 'bg-amber-50',    text: 'text-amber-700',    border: 'border-amber-200',   dot: 'bg-amber-500',    label: 'WARN' },
  error: { bg: 'bg-red-50',      text: 'text-red-700',      border: 'border-red-200',     dot: 'bg-red-500',      label: 'ERROR' },
  checking: { bg: 'bg-gray-50',  text: 'text-gray-500',     border: 'border-gray-200',    dot: 'bg-gray-400',     label: '…' },
};

function StatusPill({ status, label, detail, latencyMs }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.checking;
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${cfg.bg} ${cfg.border}`}>
      <span className={`mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0 ${cfg.dot} ${status === 'checking' ? 'animate-pulse' : ''}`}></span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold uppercase tracking-wide ${cfg.text}`}>{cfg.label}</span>
          <span className="text-sm font-medium text-gray-800">{label}</span>
          {latencyMs != null && <span className="text-xs text-gray-400">{latencyMs}ms</span>}
        </div>
        {detail && <p className="text-xs text-gray-500 mt-0.5 truncate">{detail}</p>}
      </div>
    </div>
  );
}

function Badge({ variant = 'gray', children }) {
  const map = {
    green:  'bg-emerald-100 text-emerald-700',
    red:    'bg-red-100 text-red-700',
    amber:  'bg-amber-100 text-amber-700',
    blue:   'bg-blue-100 text-blue-700',
    gray:   'bg-gray-100 text-gray-600',
    purple: 'bg-purple-100 text-purple-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${map[variant] || map.gray}`}>
      {children}
    </span>
  );
}

function StatBox({ label, value, sub, variant = 'default' }) {
  const accent = {
    default: 'text-gray-900',
    green:   'text-emerald-600',
    red:     'text-red-600',
    amber:   'text-amber-600',
    blue:    'text-blue-600',
  };
  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
      <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${accent[variant] || accent.default}`}>{value ?? '—'}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="h-6 w-6 rounded-full border-2 border-blue-600 border-t-transparent animate-spin"></div>
    </div>
  );
}

function ErrBox({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
      <i className="ph ph-warning-circle mt-0.5"></i>
      <span>{message}</span>
    </div>
  );
}

// Status badge variant by job status
const JOB_VARIANT = { sent: 'green', failed: 'red', pending: 'amber', retrying: 'blue' };

// Security kind labels
const KIND_LABEL = {
  unknown_chaperone: 'Unknown chaperone',
  suspended: 'Suspended',
  reenroll_overdue: 'Re-enroll overdue',
  officer_override: 'Officer override',
};
const KIND_VARIANT = {
  unknown_chaperone: 'red',
  suspended: 'red',
  reenroll_overdue: 'amber',
  officer_override: 'green',
};

// ─── API Probe helper ─────────────────────────────────────────────────────────
async function probeEndpoint(label, url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000) });
    const latencyMs = Math.round(performance.now() - t0);
    if (r.ok) return { label, status: 'ok', latencyMs };
    if (r.status === 401 || r.status === 403) return { label, status: 'ok', latencyMs, note: `Auth: ${r.status}` };
    return { label, status: r.status >= 500 ? 'error' : 'warn', latencyMs, note: `HTTP ${r.status}` };
  } catch (e) {
    return { label, status: 'error', latencyMs: Math.round(performance.now() - t0), note: e.message };
  }
}

const API_PROBES = [
  { label: 'Analytics',        url: '/api/pickup/admin/analytics' },
  { label: 'Onboarding list',  url: '/api/pickup/admin/onboarding-list' },
  { label: 'Security heatmap', url: '/api/pickup/admin/security-heatmap?days=1' },
  { label: 'Audit log',        url: '/api/pickup/admin/audit-log?limit=1' },
  { label: 'Kiosk profiles',   url: '/api/pickup/admin/kiosk-profiles' },
  { label: 'Terminals',        url: '/api/pickup/admin/terminals' },
  { label: 'TV feed',          url: '/api/pickup/tv/feed' },
];

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PickupMonitorPage() {
  const { permissions } = useAuth();
  const canView = rbac.can(permissions, 'system_monitor.view');

  const [health, setHealth]     = useState(null);
  const [healthErr, setHealthErr] = useState(null);
  const [notifLog, setNotifLog] = useState(null);
  const [notifErr, setNotifErr] = useState(null);
  const [secData, setSecData]   = useState(null);
  const [apiProbes, setApiProbes] = useState([]);
  const [probing, setProbing]   = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [notifHours, setNotifHours]   = useState(48);
  const [notifStatusF, setNotifStatusF] = useState('');
  const intervalRef = useRef(null);

  const fetchHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/system-health');
      const j = await r.json();
      if (j.ok) { setHealth(j); setHealthErr(null); }
      else setHealthErr(j.error || `HTTP ${r.status}`);
    } catch (e) { setHealthErr(e.message); }
  }, []);

  const fetchNotifLog = useCallback(async (hours, statusF) => {
    try {
      const params = new URLSearchParams({ hours: String(hours), limit: '150' });
      if (statusF) params.set('status', statusF);
      const r = await fetch(`/api/pickup/admin/notification-log?${params}`);
      const j = await r.json();
      if (j.ok) { setNotifLog(j); setNotifErr(null); }
      else setNotifErr(j.error || `HTTP ${r.status}`);
    } catch (e) { setNotifErr(e.message); }
  }, []);

  const fetchSecurity = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/security-heatmap?days=2');
      const j = await r.json();
      if (j.ok) setSecData(j);
    } catch { /* non-critical */ }
  }, []);

  const runProbes = useCallback(async () => {
    setProbing(true);
    setApiProbes(API_PROBES.map((p) => ({ ...p, status: 'checking' })));
    const results = await Promise.all(API_PROBES.map((p) => probeEndpoint(p.label, p.url)));
    setApiProbes(results);
    setProbing(false);
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    await Promise.all([fetchHealth(), fetchNotifLog(notifHours, notifStatusF), fetchSecurity()]);
    setLastRefresh(new Date());
    if (!silent) setRefreshing(false);
  }, [fetchHealth, fetchNotifLog, fetchSecurity, notifHours, notifStatusF]);

  // Initial load
  useEffect(() => {
    refresh();
    runProbes();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 30s
  useEffect(() => {
    intervalRef.current = setInterval(() => refresh(true), 30_000);
    return () => clearInterval(intervalRef.current);
  }, [refresh]);

  // Re-fetch notif log when filter changes
  useEffect(() => {
    fetchNotifLog(notifHours, notifStatusF);
  }, [notifHours, notifStatusF, fetchNotifLog]);

  const services = health?.services || {};
  const eq = health?.emailQueue || {};
  const pending24h = notifLog?.summary?.pending ?? 0;
  const failed24h  = notifLog?.summary?.failed  ?? 0;

  if (!canView) {
    return (
      <V2Layout>
        <Head><title>System Monitor · Access Denied</title></Head>
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 max-w-md text-center space-y-4">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-amber-100 border border-amber-300 flex items-center justify-center">
              <i className="ph ph-lock-key text-amber-600 text-3xl" />
            </div>
            <h2 className="text-lg font-semibold text-gray-900">Access restricted</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              System Monitor is an owner-only module. Ask an Owner to grant
              <span className="font-mono text-gray-800 mx-1">system_monitor.view</span>
              to your account.
            </p>
          </div>
        </div>
      </V2Layout>
    );
  }

  return (
    <>
      <Head><title>System Monitor · PickupGuard</title></Head>
      <V2Layout>
        {/* Force light mode on this page by overriding bg + text inside the layout */}
        <div className="min-h-screen bg-gray-50 text-gray-900" style={{ colorScheme: 'light' }}>
          <MonitorTopNav />
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 pb-6">

            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
              <div>
                <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                  <span className="inline-flex items-center justify-center h-9 w-9 rounded-xl bg-blue-600 shadow-sm">
                    <i className="ph ph-activity text-white text-lg"></i>
                  </span>
                  System Monitor
                </h1>
                <p className="text-sm text-gray-500 mt-1">
                  Real-time health, security, and notification telemetry for PickupGuard.
                  {lastRefresh && (
                    <span className="ml-2 text-gray-400">Last updated {fmtTime(lastRefresh.toISOString())}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={runProbes}
                  disabled={probing}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 shadow-sm"
                >
                  <i className="ph ph-pulse"></i> Probe APIs
                </button>
                <button
                  onClick={() => refresh()}
                  disabled={refreshing}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 shadow-sm"
                >
                  <i className={`ph ph-arrows-clockwise ${refreshing ? 'animate-spin' : ''}`}></i>
                  Refresh
                </button>
              </div>
            </div>

            {/* ── Row 1: Top stats ───────────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-5">
              <StatBox
                label="Email pending"
                value={eq.pending ?? '—'}
                variant={eq.pending > 0 ? 'amber' : 'default'}
              />
              <StatBox
                label="Email failed (24h)"
                value={eq.failed ?? '—'}
                variant={eq.failed > 0 ? 'red' : 'green'}
              />
              <StatBox
                label="Email sent (24h)"
                value={eq.sent ?? '—'}
                variant="green"
              />
              <StatBox
                label="Security (24h)"
                value={health?.security?.last24h ?? '—'}
                sub={health?.security?.last1h != null ? `${health.security.last1h} in last hour` : undefined}
                variant={health?.security?.last24h > 0 ? 'amber' : 'default'}
              />
              <StatBox
                label="Onboarding pending"
                value={health?.onboarding?.pending ?? '—'}
                variant={health?.onboarding?.pending > 0 ? 'blue' : 'default'}
              />
              <StatBox
                label="Delivery rate"
                value={notifLog?.summary?.deliveryRate != null ? `${notifLog.summary.deliveryRate}%` : '—'}
                sub="sent / (sent+failed)"
                variant={
                  notifLog?.summary?.deliveryRate == null ? 'default' :
                  notifLog.summary.deliveryRate >= 95 ? 'green' :
                  notifLog.summary.deliveryRate >= 80 ? 'amber' : 'red'
                }
              />
            </div>

            {/* ── Row 2: Service health + API probes ────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">

              {/* Service health */}
              <Card title="Service Health" icon="ph-heartbeat">
                {healthErr && <ErrBox message={healthErr} />}
                {!health && !healthErr && <Spinner />}
                {health && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <StatusPill
                      status={services.firestore?.status || 'checking'}
                      label="Firestore"
                      latencyMs={services.firestore?.latencyMs}
                      detail={services.firestore?.error}
                    />
                    <StatusPill
                      status={services.email?.status || 'checking'}
                      label="Resend / Email"
                      detail={
                        services.email?.key === 'missing'
                          ? 'RESEND_API_KEY not configured'
                          : services.email?.error || (services.email?.configured ? 'API key present' : 'Not configured')
                      }
                    />
                    <StatusPill
                      status={services.whatsapp?.status || 'checking'}
                      label="WhatsApp Broadcast"
                      detail={
                        services.whatsapp?.configured
                          ? services.whatsapp.url
                          : 'No webhook URL configured in Pickup Settings'
                      }
                    />
                    <StatusPill
                      status={services.functions?.status || 'checking'}
                      label="Cloud Functions"
                      detail={services.functions?.note}
                    />
                  </div>
                )}
                {health?.checkedAt && (
                  <p className="text-xs text-gray-400 mt-3">Probed {relTime(health.checkedAt)}</p>
                )}
              </Card>

              {/* API endpoint probes */}
              <Card
                title="API Endpoint Status"
                icon="ph-plugs-connected"
                action={
                  <button
                    onClick={runProbes}
                    disabled={probing}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50"
                  >
                    {probing ? 'Probing…' : 'Re-probe'}
                  </button>
                }
              >
                {apiProbes.length === 0 && <Spinner />}
                <div className="divide-y divide-gray-50">
                  {apiProbes.map((p) => {
                    const cfg = STATUS_CONFIG[p.status] || STATUS_CONFIG.checking;
                    return (
                      <div key={p.label} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full flex-shrink-0 ${cfg.dot} ${p.status === 'checking' ? 'animate-pulse' : ''}`}></span>
                          <span className="text-sm text-gray-700">{p.label}</span>
                          {p.note && <span className="text-xs text-gray-400">({p.note})</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          {p.latencyMs != null && p.status !== 'checking' && (
                            <span className="text-xs text-gray-400 tabular-nums">{p.latencyMs}ms</span>
                          )}
                          <span className={`text-xs font-semibold uppercase tracking-wide ${cfg.text}`}>{cfg.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>

            {/* ── Row 3: Notification log ────────────────────────────────── */}
            <Card
              title="Notification Log — Email Dispatch"
              icon="ph-envelope"
              className="mb-5"
              action={
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Status filter */}
                  <select
                    value={notifStatusF}
                    onChange={(e) => setNotifStatusF(e.target.value)}
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 bg-white"
                  >
                    <option value="">All statuses</option>
                    <option value="failed">Failed only</option>
                    <option value="pending">Pending only</option>
                    <option value="sent">Sent only</option>
                    <option value="retrying">Retrying only</option>
                  </select>
                  {/* Time window */}
                  {[24, 48, 168].map((h) => (
                    <button
                      key={h}
                      onClick={() => setNotifHours(h)}
                      className={`text-xs px-2 py-1.5 rounded-lg font-medium ${
                        notifHours === h
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {h === 168 ? '7d' : `${h}h`}
                    </button>
                  ))}
                </div>
              }
            >
              {notifErr && <ErrBox message={notifErr} />}
              {!notifLog && !notifErr && <Spinner />}
              {notifLog && (
                <>
                  {/* Summary row */}
                  <div className="flex flex-wrap gap-2 mb-4">
                    {[
                      { label: `${notifLog.summary.total} total`, variant: 'gray' },
                      { label: `${notifLog.summary.sent} sent`, variant: 'green' },
                      { label: `${notifLog.summary.failed} failed`, variant: notifLog.summary.failed > 0 ? 'red' : 'gray' },
                      { label: `${notifLog.summary.pending} pending`, variant: notifLog.summary.pending > 0 ? 'amber' : 'gray' },
                      notifLog.summary.retrying > 0 && { label: `${notifLog.summary.retrying} retrying`, variant: 'blue' },
                      notifLog.summary.deliveryRate != null && {
                        label: `${notifLog.summary.deliveryRate}% delivery`,
                        variant: notifLog.summary.deliveryRate >= 95 ? 'green' : notifLog.summary.deliveryRate >= 80 ? 'amber' : 'red',
                      },
                    ].filter(Boolean).map((b, i) => (
                      <Badge key={i} variant={b.variant}>{b.label}</Badge>
                    ))}
                  </div>

                  {/* Jobs table */}
                  {notifLog.jobs.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">No email jobs in this window.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-gray-100">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
                            <th className="px-3 py-2 text-left">Status</th>
                            <th className="px-3 py-2 text-left">To</th>
                            <th className="px-3 py-2 text-left">Template</th>
                            <th className="px-3 py-2 text-left">Campaign</th>
                            <th className="px-3 py-2 text-left">Error</th>
                            <th className="px-3 py-2 text-left">Retries</th>
                            <th className="px-3 py-2 text-left">Created</th>
                            <th className="px-3 py-2 text-left">Sent/Failed</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50 bg-white">
                          {notifLog.jobs.map((job) => (
                            <tr key={job.id} className="hover:bg-gray-50">
                              <td className="px-3 py-2">
                                <Badge variant={JOB_VARIANT[job.status] || 'gray'}>{job.status}</Badge>
                              </td>
                              <td className="px-3 py-2 text-gray-700 max-w-[180px] truncate font-mono text-xs">
                                {job.to || '—'}
                              </td>
                              <td className="px-3 py-2 text-gray-600 text-xs max-w-[140px] truncate">
                                {job.templateType || '—'}
                              </td>
                              <td className="px-3 py-2 text-gray-500 text-xs max-w-[120px] truncate">
                                {job.campaignName || '—'}
                              </td>
                              <td className="px-3 py-2 text-red-600 text-xs max-w-[180px] truncate">
                                {job.error || <span className="text-gray-300">—</span>}
                              </td>
                              <td className="px-3 py-2 text-center text-xs tabular-nums text-gray-500">
                                {job.retryCount}/{job.maxRetries}
                              </td>
                              <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">
                                {relTime(job.createdAt)}
                              </td>
                              <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">
                                {relTime(job.sentAt || job.failedAt)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </Card>

            {/* ── Row 4: Security events + Campaign history ──────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">

              {/* Security events */}
              <Card title="Security Events" icon="ph-shield-warning">
                {!secData && !health && <Spinner />}
                {health && (
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <StatBox
                      label="Incidents (24h)"
                      value={health.security?.last24h ?? '—'}
                      variant={health.security?.last24h > 0 ? 'amber' : 'default'}
                    />
                    <StatBox
                      label="Incidents (1h)"
                      value={health.security?.last1h ?? '—'}
                      variant={health.security?.last1h > 0 ? 'red' : 'default'}
                    />
                  </div>
                )}

                {/* Kind breakdown */}
                {secData?.byKind && Object.keys(secData.byKind).length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">By incident type (last 2 days)</p>
                    <div className="space-y-1.5">
                      {Object.entries(secData.byKind)
                        .sort((a, b) => b[1] - a[1])
                        .map(([kind, count]) => (
                          <div key={kind} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Badge variant={KIND_VARIANT[kind] || 'gray'}>
                                {KIND_LABEL[kind] || kind}
                              </Badge>
                            </div>
                            <span className="text-sm font-semibold tabular-nums text-gray-700">{count}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Recent incidents list */}
                {secData?.recent?.length > 0 && (
                  <>
                    <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">Recent incidents</p>
                    <div className="space-y-1">
                      {secData.recent.slice(0, 8).map((inc) => (
                        <div key={inc.id} className="flex items-start justify-between py-1.5 border-b border-gray-50 last:border-0">
                          <div className="flex items-start gap-2">
                            <Badge variant={KIND_VARIANT[inc.kind] || 'gray'}>{KIND_LABEL[inc.kind] || inc.kind}</Badge>
                            <span className="text-xs text-gray-600 mt-0.5">{inc.chaperoneName || inc.gate || '—'}</span>
                          </div>
                          <span className="text-xs text-gray-400 whitespace-nowrap ml-2">{relTime(inc.at)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {secData?.recent?.length === 0 && health && (
                  <p className="text-sm text-gray-400 text-center py-4">No incidents in the last 48 hours.</p>
                )}

                <div className="mt-3 pt-3 border-t border-gray-100">
                  <a href="/v2/security" className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1">
                    Open full Security Heatmap <i className="ph ph-arrow-right"></i>
                  </a>
                </div>
              </Card>

              {/* Campaign history */}
              <Card title="Email Campaign History" icon="ph-paper-plane-right">
                {!notifLog && <Spinner />}
                {notifLog?.campaigns?.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-6">No campaigns sent yet.</p>
                )}
                {notifLog?.campaigns?.length > 0 && (
                  <div className="space-y-3">
                    {notifLog.campaigns.map((c) => (
                      <div key={c.campaignId} className="p-3 bg-gray-50 rounded-xl border border-gray-100">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{c.campaignName || 'Untitled campaign'}</p>
                            {c.subject && (
                              <p className="text-xs text-gray-500 truncate mt-0.5">{c.subject}</p>
                            )}
                          </div>
                          <Badge variant="blue">{c.channel}</Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                          <span><span className="font-semibold text-emerald-600">{c.queued}</span> queued</span>
                          {c.skipped > 0 && <span><span className="font-semibold text-amber-600">{c.skipped}</span> skipped</span>}
                          <span>{c.recipientCount} recipients</span>
                          {c.group && <span className="truncate">Group: {c.group}</span>}
                        </div>
                        <div className="flex items-center justify-between mt-1.5">
                          <span className="text-xs text-gray-400">by {c.createdBy || 'admin'}</span>
                          <span className="text-xs text-gray-400">{relTime(c.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <a href="/v2/pickup-admin?view=settings" className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1">
                    Manage integrations &amp; contacts <i className="ph ph-arrow-right"></i>
                  </a>
                </div>
              </Card>
            </div>

            {/* ── Row 5: Onboarding flow snapshot ───────────────────────── */}
            <Card title="Onboarding &amp; Queue Health" icon="ph-funnel" className="mb-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatBox
                  label="Pending approvals"
                  value={health?.onboarding?.pending ?? '—'}
                  sub="forms awaiting review"
                  variant={health?.onboarding?.pending > 5 ? 'amber' : health?.onboarding?.pending > 0 ? 'blue' : 'default'}
                />
                <StatBox
                  label="Email queue pending"
                  value={eq.pending ?? '—'}
                  sub="jobs not yet dispatched"
                  variant={eq.pending > 0 ? 'amber' : 'default'}
                />
                <StatBox
                  label="Retrying"
                  value={eq.retrying ?? '—'}
                  sub="jobs in retry loop"
                  variant={eq.retrying > 0 ? 'blue' : 'default'}
                />
                <StatBox
                  label="Failed (unrecoverable)"
                  value={eq.failed ?? '—'}
                  sub="exceeded max retries"
                  variant={eq.failed > 0 ? 'red' : 'green'}
                />
              </div>

              {/* Failed email detail */}
              {eq.recentErrors?.length > 0 && (
                <div className="mt-5">
                  <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                    <i className="ph ph-x-circle"></i> Failed email jobs (last 24h)
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-red-100">
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr className="bg-red-50 text-gray-500 uppercase text-xs tracking-wide">
                          <th className="px-3 py-2 text-left">To</th>
                          <th className="px-3 py-2 text-left">Template</th>
                          <th className="px-3 py-2 text-left">Error</th>
                          <th className="px-3 py-2 text-left">Retries</th>
                          <th className="px-3 py-2 text-left">Failed at</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-50 bg-white">
                        {eq.recentErrors.map((e) => (
                          <tr key={e.id} className="hover:bg-red-50">
                            <td className="px-3 py-2 font-mono text-gray-700 max-w-[160px] truncate">{e.to || '—'}</td>
                            <td className="px-3 py-2 text-gray-600 max-w-[140px] truncate">{e.templateType || '—'}</td>
                            <td className="px-3 py-2 text-red-600 max-w-[200px] truncate">{e.error || '—'}</td>
                            <td className="px-3 py-2 text-center tabular-nums text-gray-500">{e.retryCount}</td>
                            <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{relTime(e.failedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="mt-4 pt-3 border-t border-gray-100 flex gap-4">
                <a href="/v2/pickup-admin" className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1">
                  Review onboarding queue <i className="ph ph-arrow-right"></i>
                </a>
                <a href="/v2/admin/system-audit" className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1">
                  Full audit log <i className="ph ph-arrow-right"></i>
                </a>
              </div>
            </Card>

            {/* ── Footer ─────────────────────────────────────────────────── */}
            <div className="flex items-center justify-between text-xs text-gray-400 pb-4">
              <span>Auto-refreshes every 30 seconds · All times in WIB (UTC+7)</span>
              <span>PickupGuard · BINUSFace</span>
            </div>

          </div>
        </div>
      </V2Layout>
    </>
  );
}
