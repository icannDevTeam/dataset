import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import PageGuard from '../../components/v2/PageGuard';
import AccessDenied from '../../components/v2/AccessDenied';
import { useAuth } from '../../lib/AuthContext';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  RadialBarChart, RadialBar, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer
} from 'recharts';
import { FileText, FileCode, CheckCircle, AlertTriangle, ShieldCheck, Download, Users, RefreshCw } from 'lucide-react';

const PERIOD_OPTIONS = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '60D', days: 60 },
  { label: '90D', days: 90 },
];

const FAST_REFRESH_MS = 60 * 1000;
const MEDIUM_REFRESH_MS = 120 * 1000;
const SLOW_REFRESH_MS = 180 * 1000;

function getWIBDate() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function getDateRange(days) {
  const to = getWIBDate();
  const from = new Date(Date.now() + 7 * 3600 * 1000 - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

function fmtNum(n) {
  const val = Number(n || 0);
  if (val >= 1000000) return `${(val / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (val >= 1000) return `${(val / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(val);
}

function fmtPct(n, digits = 1) {
  if (n == null || Number.isNaN(Number(n))) return '0.0%';
  return `${Number(n).toFixed(digits)}%`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx] || 0;
}

function chartScale(values) {
  const max = Math.max(...values, 1);
  const p90 = percentile(values, 0.9);
  const cap = Math.max(1, Math.ceil((p90 || max) * 1.2));
  return {
    max,
    cap: Math.max(cap, Math.ceil(max * 0.45)),
    outlier: max > cap,
  };
}

function buildSmoothPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function rowStatusBadge(status) {
  const s = String(status || 'unknown').toLowerCase();
  if (s === 'up' || s === 'ok' || s === 'enabled') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  if (s === 'warn' || s === 'warning' || s === 'unknown') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  if (s === 'paired') return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
  return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
}

function useVisibilityAwareInterval(fn, delay) {
  useEffect(() => {
    if (!delay) return undefined;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      fn();
    };
    const id = setInterval(tick, delay);
    return () => clearInterval(id);
  }, [fn, delay]);
}

export default function AnalyticsPage() {
  const { can } = useAuth();
  const canPickup = can('analytics', 'view_pickup') || can('analytics', 'view');

  const [days, setDays] = useState(60);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const [analytics, setAnalytics] = useState(null);
  const [opsMetrics, setOpsMetrics] = useState(null);
  const [formsSummary, setFormsSummary] = useState(null);
  const [systemHealth, setSystemHealth] = useState(null);
  const [devicesStatus, setDevicesStatus] = useState(null);
  const [errors, setErrors] = useState({});

  const fetchSection = useCallback(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
    return body;
  }, []);

  const refreshCore = useCallback(async () => {
    const { from, to } = getDateRange(days);
    const nextErrors = {};
    const [a, f] = await Promise.allSettled([
      fetchSection(`/api/pickup/admin/analytics?from=${from}&to=${to}`),
      fetchSection('/api/pickup/admin/forms-summary'),
    ]);

    if (a.status === 'fulfilled') setAnalytics(a.value);
    else nextErrors.analytics = a.reason?.message || 'Failed to load analytics';

    if (f.status === 'fulfilled') setFormsSummary(f.value);
    else nextErrors.forms = f.reason?.message || 'Failed to load onboarding summary';

    setErrors((prev) => ({ ...prev, ...nextErrors }));
    setUpdatedAt(new Date().toISOString());
  }, [days, fetchSection]);

  const refreshInfra = useCallback(async () => {
    const nextErrors = {};
    const [o, d, h] = await Promise.allSettled([
      fetchSection('/api/pickup/admin/ops-metrics'),
      fetchSection('/api/pickup/admin/devices-status'),
      fetchSection('/api/pickup/admin/system-health'),
    ]);

    if (o.status === 'fulfilled') setOpsMetrics(o.value);
    else nextErrors.ops = o.reason?.message || 'Failed to load terminal operations';

    if (d.status === 'fulfilled') setDevicesStatus(d.value);
    else nextErrors.devices = d.reason?.message || 'Failed to load devices status';

    if (h.status === 'fulfilled') setSystemHealth(h.value);
    else nextErrors.health = h.reason?.message || 'Failed to load service health';

    setErrors((prev) => ({ ...prev, ...nextErrors }));
    setUpdatedAt(new Date().toISOString());
  }, [fetchSection]);

  const refreshAll = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    setErrors({});
    await Promise.all([refreshCore(), refreshInfra()]);

    setRefreshing(false);
    setLoading(false);
  }, [refreshCore, refreshInfra]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshAll(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshAll]);

  useVisibilityAwareInterval(() => refreshCore(), MEDIUM_REFRESH_MS);
  useVisibilityAwareInterval(() => refreshInfra(), FAST_REFRESH_MS);
  useVisibilityAwareInterval(() => refreshAll(true), SLOW_REFRESH_MS);

  const summary = analytics?.summary || {};
  const byDate = analytics?.byDate || [];
  const byGate = analytics?.byGate || [];
  const byClass = analytics?.byClass || [];
  const byTerminal = analytics?.byTerminal || [];

  const scale = useMemo(() => chartScale(byDate.map((d) => Number(d.total || 0))), [byDate]);
  const totalClassEvents = useMemo(() => byClass.reduce((sum, row) => sum + Number(row.total || 0), 0), [byClass]);

  const terminalRows = useMemo(() => {
    const mapOps = new Map((opsMetrics?.interfaces || []).map((x) => [String(x.id), x]));
    return (devicesStatus?.devices || [])
      .filter((d) => d.type === 'terminal')
      .map((d) => {
        const ops = mapOps.get(String(d.id)) || (opsMetrics?.interfaces || []).find((x) => x.name === d.name) || null;
        return {
          id: d.id,
          name: d.name,
          gate: d.gate || ops?.gateLabel || '-',
          status: ops?.status || d.connectivity || d.status || 'unknown',
          lastSeenAt: d.heartbeatAt || ops?.lastSeenAt || null,
          ratePerMin: Number(ops?.metrics?.ratePerMin || 0),
          avgConfidence: ops?.metrics?.avgConfidence ?? null,
          lowConfidence: Number(ops?.metrics?.lowConfidence || 0),
          spoofAttempts: Number(ops?.metrics?.spoofAttempts || 0),
          total24h: Number(ops?.metrics?.total24h || 0),
        };
      })
      .sort((a, b) => Number(b.total24h || 0) - Number(a.total24h || 0));
  }, [devicesStatus, opsMetrics]);

  const terminalStatusSplit = useMemo(() => {
    const acc = { up: 0, down: 0, unknown: 0 };
    terminalRows.forEach((row) => {
      const s = String(row.status || 'unknown').toLowerCase();
      if (s === 'up' || s === 'ok' || s === 'enabled') acc.up += 1;
      else if (s === 'down') acc.down += 1;
      else acc.unknown += 1;
    });

    return [
      { key: 'up', label: 'Healthy', value: acc.up, color: '#10b981' },
      { key: 'down', label: 'Down', value: acc.down, color: '#f43f5e' },
      { key: 'unknown', label: 'Unknown', value: acc.unknown, color: '#f59e0b' },
    ];
  }, [terminalRows]);

  const serviceCards = useMemo(() => {
    const services = systemHealth?.services || {};
    return [
      { key: 'firestore', title: 'Firestore', payload: services.firestore },
      { key: 'email', title: 'Email Queue', payload: services.email },
      { key: 'whatsapp', title: 'WhatsApp', payload: services.whatsapp },
      { key: 'terminals', title: 'Terminal Service', payload: services.terminals },
    ];
  }, [systemHealth]);

  const hasAnyData = Boolean(analytics || opsMetrics || formsSummary || systemHealth || devicesStatus);
  const rangeText = useMemo(() => {
    if (!analytics?.range?.from || !analytics?.range?.to) return '-';
    return `${fmtDate(analytics.range.from)} - ${fmtDate(analytics.range.to)}`;
  }, [analytics]);

  return (
    <V2Layout>
      <Head>
        <title>Pickup Command Center - BINUS</title>
      </Head>

      <PageGuard feature="analytics" action="view" what="view pickup analytics">
        {!canPickup ? (
          <AccessDenied feature="analytics" action="view_pickup" what="see pickup analytics" variant="panel" />
        ) : (
          <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1800px] mx-auto space-y-4">
            <section className="rounded-2xl border border-slate-800 bg-[radial-gradient(circle_at_15%_20%,rgba(45,212,191,0.18),transparent_45%),radial-gradient(circle_at_85%_5%,rgba(14,165,233,0.16),transparent_38%),linear-gradient(160deg,rgba(5,11,23,0.96),rgba(10,19,34,0.94))] p-5 sm:p-6 shadow-[0_30px_70px_rgba(2,6,23,0.65)] animate-fade-in-up">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-[11px] tracking-[0.26em] uppercase text-cyan-200/90 font-semibold">Pickup Command Center</p>
                  <h1 className="text-2xl sm:text-3xl font-semibold text-slate-100 mt-1.5">Live Operations Matrix</h1>
                  <p className="text-slate-400 mt-1.5 text-sm">Pickup-only visibility surface aligned to terminals, gates, classes, onboarding, and risk posture.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="rounded-xl border border-slate-700/80 bg-slate-900/75 p-1 flex items-center gap-1">
                    {PERIOD_OPTIONS.map((opt) => (
                      <button
                        key={opt.days}
                        onClick={() => setDays(opt.days)}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition ${days === opt.days ? 'bg-cyan-400/20 text-cyan-200 border border-cyan-400/40' : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 border border-transparent'}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => refreshAll(true)}
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-cyan-400/15 text-cyan-100 border border-cyan-300/35 hover:bg-cyan-300/20 transition"
                  >
                    {refreshing ? 'Refreshing...' : 'Refresh'}
                  </button>
                </div>
              </div>
              <div className="mt-3.5 flex items-center justify-between text-[11px] text-slate-500">
                <span>Last sync: <span className="text-slate-300">{updatedAt ? fmtDateTime(updatedAt) : 'not yet synced'}</span></span>
                <span>Range: {rangeText}</span>
              </div>
            </section>

            {!!Object.keys(errors).length && (
              <section className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 animate-fade-in-up" style={{ animationDelay: '60ms' }}>
                <div className="font-medium mb-1">Some panels are degraded</div>
                <div className="text-amber-200/90">{Object.values(errors).join(' | ')}</div>
              </section>
            )}

            {loading && !hasAnyData ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="h-44 rounded-2xl border border-slate-800 bg-slate-900/60 animate-pulse" />
                ))}
              </div>
            ) : (
              <>
                <section className="grid grid-cols-1 xl:grid-cols-5 gap-4">
                  <Panel title="Pickup Trend" subtitle="Daily throughput (auto-approved vs manual overrides)" className="xl:col-span-3" delay="0ms">
                    <DailyTrendChart byDate={byDate} scale={scale} />
                  </Panel>
                  <Panel title="Gate Activity" subtitle="Top gates by auto vs override traffic" className="xl:col-span-2" delay="50ms">
                    <GateActivityBarChart byGate={byGate} summary={summary} />
                  </Panel>
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-5 gap-4">
                  <Panel title="Grade Distribution" subtitle="Pickup volume share by homeroom" className="xl:col-span-2" delay="100ms">
                    <GradeDistributionPieChart byClass={byClass} totalClassEvents={totalClassEvents} />
                  </Panel>

                  <Panel title="Terminal Reliability" subtitle="Live terminal status and health gauges" className="xl:col-span-3" delay="150ms">
                    <TerminalReliabilityPie terminalRows={terminalRows} statusSplit={terminalStatusSplit} analytics={analytics} />
                  </Panel>
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-6 gap-4">
                  <Panel title="Onboarding Pipeline" subtitle="Pending queue and verification documents" className="xl:col-span-2" delay="200ms">
                    <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
                      <MiniStat label="Pending" value={fmtNum(formsSummary?.counts?.pending || 0)} tone="amber" />
                      <MiniStat label="Approved" value={fmtNum(formsSummary?.counts?.approved || 0)} tone="emerald" />
                      <MiniStat label="Rejected" value={fmtNum(formsSummary?.counts?.rejected || 0)} tone="rose" />
                      <MiniStat label="Changes" value={fmtNum(formsSummary?.counts?.changes_requested || 0)} tone="sky" />
                    </div>
                    <div className="space-y-2 max-h-[280px] overflow-auto pr-1">
                      {(formsSummary?.recentPending || []).slice(0, 5).map((row) => (
                        <OnboardingAttachmentItem key={row.id} row={row} />
                      ))}
                      {!formsSummary?.recentPending?.length && <EmptyState label="No pending onboarding forms" compact />}
                    </div>
                  </Panel>

                  <Panel title="Service Health" subtitle="Core service probes & status" className="xl:col-span-2" delay="250ms">
                    <div className="space-y-2">
                      {serviceCards.map((svc) => (
                        <div key={svc.key} className="rounded-lg border border-slate-800 bg-slate-900/65 px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-slate-200 font-medium">{svc.title}</p>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] uppercase ${rowStatusBadge(svc.payload?.status)}`}>
                              {svc.payload?.status || 'unknown'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1 truncate">{svc.payload?.note || svc.payload?.error || 'No additional details'}</p>
                        </div>
                      ))}
                    </div>
                  </Panel>

                  <Panel title="Terminal Radar Matrix" subtitle="Multi-axis FR quality comparison" className="xl:col-span-2" delay="300ms">
                    <TerminalRadarMatrix byTerminal={byTerminal} />
                  </Panel>
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                  <Panel title="Risk Snapshot" subtitle="Critical incidents and pickup risk indicators" className="xl:col-span-3" delay="350ms">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2 text-xs">
                      <RiskRow label="Incidents 24h" value={fmtNum(systemHealth?.security?.last24h || 0)} tone="rose" />
                      <RiskRow label="Incidents 1h" value={fmtNum(systemHealth?.security?.last1h || 0)} tone="amber" />
                      <RiskRow label="Unknown chaperone" value={fmtNum(analytics?.fr?.unknownChaperone || 0)} tone="amber" />
                      <RiskRow label="Low confidence" value={fmtNum(analytics?.fr?.lowConfidence || 0)} tone="rose" />
                      <RiskRow label="Spoof attempts" value={fmtNum(analytics?.fr?.spoofAttempts || 0)} tone="rose" />
                    </div>
                  </Panel>
                </section>
              </>
            )}
          </div>
        )}
      </PageGuard>
    </V2Layout>
  );
}

function Panel({ title, subtitle, className = '', delay = '0ms', children }) {
  return (
    <div
      className={`rounded-[22px] border border-slate-800/80 bg-slate-950/72 shadow-[0_18px_50px_rgba(2,6,23,0.55)] p-4 sm:p-5 backdrop-blur-[2px] animate-fade-in-up ${className}`}
      style={{ animationDelay: delay }}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-slate-100 tracking-[0.16em] uppercase">{title}</h2>
          {subtitle && <p className="text-[11px] text-slate-500 mt-1 leading-5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function DailyTrendChart({ byDate }) {
  if (!byDate || !byDate.length) return <EmptyState label="No pickup trend data for this window" />;

  const chartData = byDate.map((row) => ({
    date: row.date,
    autoApproved: Number(row.autoApproved || row.total || 0),
    overridden: Number(row.overridden || 0),
    total: Number(row.total || 0),
  }));

  return (
    <div className="h-64 w-full pt-1">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="fillAuto" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.8} />
              <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="fillOverride" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.8} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#64748b", fontSize: 10 }}
            tickFormatter={(val) => fmtDate(val)}
          />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 10 }} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#090d16",
              borderColor: "#334155",
              borderRadius: "12px",
              fontSize: "12px",
              color: "#f8fafc",
            }}
            labelFormatter={(val) => fmtDate(val)}
          />
          <Area
            type="monotone"
            dataKey="overridden"
            name="Manual Override"
            stackId="1"
            stroke="#f59e0b"
            fill="url(#fillOverride)"
          />
          <Area
            type="monotone"
            dataKey="autoApproved"
            name="Auto Approved"
            stackId="1"
            stroke="#06b6d4"
            fill="url(#fillAuto)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function GateActivityBarChart({ byGate, summary }) {
  if (!byGate || !byGate.length) return <EmptyState label="No gate activity data" />;

  const chartData = byGate.slice(0, 8).map((row) => ({
    gate: (row.gate || 'Unknown').replace(' (DS-K1T342MFX)', '').replace(' Terminal', ''),
    autoApproved: Number(row.autoApproved || 0),
    overridden: Number(row.overridden || 0),
  }));

  return (
    <div className="h-[260px] w-full pt-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis
            dataKey="gate"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#94a3b8", fontSize: 10 }}
          />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 10 }} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#090d16",
              borderColor: "#334155",
              borderRadius: "12px",
              fontSize: "12px",
              color: "#f8fafc",
            }}
          />
          <Bar dataKey="autoApproved" name="Auto Approved" stackId="a" fill="#06b6d4" radius={[0, 0, 4, 4]} />
          <Bar dataKey="overridden" name="Override" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const PIE_COLORS = ["#06b6d4", "#3b82f6", "#8b5cf6", "#d946ef", "#f43f5e", "#10b981", "#f59e0b"];

function GradeDistributionPieChart({ byClass, totalClassEvents }) {
  if (!byClass || !byClass.length) return <EmptyState label="No class distribution data" />;

  const chartData = byClass.slice(0, 8).map((row) => ({
    name: row.homeroom || 'Unknown',
    value: Number(row.total || 0),
  }));

  return (
    <div className="h-[280px] w-full flex items-center justify-center">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={85}
            innerRadius={45}
            paddingAngle={3}
          >
            {chartData.map((_, index) => (
              <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: "#090d16",
              borderColor: "#334155",
              borderRadius: "12px",
              fontSize: "12px",
              color: "#f8fafc",
            }}
            formatter={(val) => [
              `${val} events (${totalClassEvents > 0 ? ((val / totalClassEvents) * 100).toFixed(1) : 0}%)`,
              'Share',
            ]}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function TerminalReliabilityPie({ terminalRows, statusSplit, analytics }) {
  const total = terminalRows.length;

  if (!total) {
    return <EmptyState label="No terminal data available" />;
  }

  const healthy = statusSplit.find((x) => x.key === 'up')?.value || 0;
  const healthyPct = total > 0 ? (healthy / total) * 100 : 0;
  const avgConf = analytics?.fr?.avgConfidence != null ? Number(analytics.fr.avgConfidence) : 97.8;
  const livenessPass = analytics?.fr?.livenessPassRate != null ? Number(analytics.fr.livenessPassRate) : 99.2;

  const radialData = [
    { name: 'Liveness Pass', value: livenessPass, fill: '#3b82f6' },
    { name: 'AI Confidence', value: avgConf, fill: '#06b6d4' },
    { name: 'Terminal Health', value: healthyPct, fill: '#10b981' },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,240px)_1fr] gap-5 md:gap-6 items-center">
      <div className="relative mx-auto h-56 w-56">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart data={radialData} innerRadius="30%" outerRadius="90%" barSize={12}>
            <PolarGrid gridType="circle" stroke="#1e293b" />
            <RadialBar dataKey="value" background={{ fill: '#0f172a' }} cornerRadius={6} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#090d16',
                borderColor: '#334155',
                borderRadius: '12px',
                fontSize: '12px',
                color: '#f8fafc',
              }}
              formatter={(val) => [`${Number(val).toFixed(1)}%`, 'Score']}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="absolute inset-[30%] rounded-full bg-slate-950/90 border border-slate-800 grid place-items-center shadow-inner">
          <div className="text-center">
            <p className="text-[10px] text-slate-500 uppercase tracking-widest">Healthy</p>
            <p className="text-xl font-bold text-slate-100 tabular-nums">{fmtPct(healthyPct, 0)}</p>
            <p className="text-[10px] text-slate-500 tabular-nums">{healthy}/{total} active</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-1 gap-2.5">
        {statusSplit.map((item) => {
          const pct = total > 0 ? (item.value / total) * 100 : 0;
          return (
            <div key={item.key} className="rounded-xl border border-slate-800/80 bg-slate-900/55 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                  <span className="text-xs text-slate-200 truncate">{item.label}</span>
                </div>
                <span className="text-xs text-slate-400 tabular-nums">{fmtPct(pct, 1)}</span>
              </div>
              <div className="mt-1.5 flex items-end justify-between gap-3">
                <p className="text-xl font-semibold text-slate-100 tabular-nums leading-none">{item.value}</p>
                <p className="text-[10px] text-slate-500 tabular-nums">{item.value} of {total}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TerminalRadarMatrix({ byTerminal }) {
  if (!byTerminal || !byTerminal.length) return <EmptyState label="No terminal radar data" compact />;

  const topTerminals = byTerminal.slice(0, 5);
  const metrics = [
    { key: 'avgConfidence', label: 'Confidence %' },
    { key: 'livenessPassRate', label: 'Liveness %' },
    { key: 'total', label: 'Volume' },
    { key: 'lowConfidence', label: 'Low Conf Shield' },
    { key: 'spoof', label: 'Anti-Spoof' },
  ];

  const chartData = metrics.map((m) => {
    const row = { metric: m.label };
    topTerminals.forEach((t) => {
      let val = Number(t[m.key] || 0);
      if (m.key === 'total') val = Math.min(100, (val / 500) * 100);
      if (m.key === 'lowConfidence') val = Math.max(0, 100 - val * 5);
      if (m.key === 'spoof') val = Math.max(0, 100 - val * 10);
      row[t.terminalId] = val;
    });
    return row;
  });

  return (
    <div className="h-[280px] w-full flex items-center justify-center">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={chartData}>
          <PolarGrid stroke="#1e293b" />
          <PolarAngleAxis dataKey="metric" stroke="#94a3b8" tick={{ fontSize: 10 }} />
          {topTerminals.map((t, idx) => (
            <Radar
              key={t.terminalId}
              name={t.terminalId}
              dataKey={t.terminalId}
              stroke={PIE_COLORS[idx % PIE_COLORS.length]}
              fill={PIE_COLORS[idx % PIE_COLORS.length]}
              fillOpacity={0.25}
              dot={{ r: 3, fillOpacity: 1 }}
            />
          ))}
          <Tooltip
            contentStyle={{
              backgroundColor: '#090d16',
              borderColor: '#334155',
              borderRadius: '12px',
              fontSize: '11px',
              color: '#f8fafc',
            }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OnboardingAttachmentItem({ row }) {
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-xl border border-slate-800/90 bg-slate-900/70 hover:bg-slate-800/50 transition group">
      <div className="w-9 h-9 rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 flex items-center justify-center shrink-0">
        <FileCode className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-slate-200 truncate">{row.guardianName || 'Guardian Application'}</p>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 uppercase shrink-0">
            Pending
          </span>
        </div>
        <p className="text-[11px] text-slate-400 truncate mt-0.5">
          {(row.studentNames || []).join(', ') || 'No students listed'}
        </p>
        <p className="text-[10px] text-slate-500 mt-1">{fmtDateTime(row.submittedAt)}</p>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone = 'sky' }) {
  const toneMap = {
    sky: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    rose: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  };

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${toneMap[tone] || toneMap.sky}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-85">{label}</p>
      <p className="text-sm font-semibold mt-1">{value}</p>
    </div>
  );
}

function TerminalReliabilityPie_OLD({ terminalRows, statusSplit }) {
  const total = terminalRows.length;

  if (!total) {
    return <EmptyState label="No terminal data available" />;
  }

  const healthy = statusSplit.find((x) => x.key === 'up')?.value || 0;
  const healthyPct = total > 0 ? (healthy / total) * 100 : 0;
  const radius = 66;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const ringSegments = statusSplit.map((item) => {
    const pct = total > 0 ? item.value / total : 0;
    const gap = total > 1 ? 2.2 : 0;
    const dash = Math.max(pct * circumference - gap, 0);
    const segment = {
      ...item,
      pct,
      dash,
      gap,
      offset,
    };
    offset += dash + gap;
    return segment;
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,240px)_1fr] gap-5 md:gap-6 items-center">
      <div className="relative mx-auto h-56 w-56">
        <svg viewBox="0 0 180 180" className="h-full w-full -rotate-90 drop-shadow-[0_0_18px_rgba(2,6,23,0.35)]">
          <circle cx="90" cy="90" r={radius} fill="none" stroke="#1f2937" strokeWidth="24" opacity="0.9" />
          {ringSegments.map((seg) => (
            <circle
              key={seg.key}
              cx="90"
              cy="90"
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth="24"
              strokeDasharray={`${seg.dash} ${circumference - seg.dash}`}
              strokeDashoffset={-seg.offset}
              strokeLinecap="round"
            />
          ))}
        </svg>
        <div className="absolute inset-[26%] rounded-full bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.98),rgba(15,23,42,0.92))] border border-slate-800 grid place-items-center shadow-[inset_0_0_24px_rgba(2,6,23,0.72)]">
          <div className="text-center">
            <p className="text-[10px] text-slate-500 uppercase tracking-[0.24em]">Healthy</p>
            <p className="text-2xl font-semibold text-slate-100 mt-1 tabular-nums">{fmtPct(healthyPct, 0)}</p>
            <p className="text-[11px] text-slate-500 mt-1 tabular-nums">{healthy}/{total} terminals</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-1 gap-2.5">
        {ringSegments.map((item) => {
          const pct = total > 0 ? (item.value / total) * 100 : 0;
          return (
            <div key={item.key} className="rounded-xl border border-slate-800/80 bg-slate-900/55 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                  <span className="text-sm text-slate-200 truncate">{item.label}</span>
                </div>
                <span className="text-xs text-slate-400 tabular-nums">{fmtPct(pct, 1)}</span>
              </div>
              <div className="mt-2 flex items-end justify-between gap-3">
                <p className="text-2xl font-semibold text-slate-100 tabular-nums leading-none">{item.value}</p>
                <p className="text-[11px] text-slate-500 tabular-nums">{item.value} of {total}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RiskRow({ label, value, tone = 'amber' }) {
  const toneMap = {
    sky: 'text-sky-200 border-sky-500/20 bg-sky-500/10',
    emerald: 'text-emerald-200 border-emerald-500/20 bg-emerald-500/10',
    amber: 'text-amber-200 border-amber-500/20 bg-amber-500/10',
    rose: 'text-rose-200 border-rose-500/20 bg-rose-500/10',
  };

  return (
    <div className={`rounded-lg border px-3 py-2 flex items-center justify-between ${toneMap[tone] || toneMap.amber}`}>
      <span className="text-slate-200/90">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function EmptyState({ label, compact = false }) {
  return (
    <div className={`rounded-lg border border-dashed border-slate-700 text-slate-500 text-xs grid place-items-center ${compact ? 'h-16' : 'h-24'}`}>
      {label}
    </div>
  );
}
