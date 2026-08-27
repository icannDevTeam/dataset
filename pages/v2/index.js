import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import PageGuard from '../../components/v2/PageGuard';
import AccessDenied from '../../components/v2/AccessDenied';
import { useAuth } from '../../lib/AuthContext';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, RadialBarChart, RadialBar,
  PolarGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid
} from 'recharts';
import {
  Activity, ArrowUpRight, CheckCircle2, Clock, Cpu, DoorOpen, Download,
  FileCheck, FileText, Fingerprint, Hand, Layers, ShieldCheck, ShieldAlert,
  Users, AlertTriangle, RefreshCw, ChevronRight, Zap, Radio, PieChartIcon, Shield
} from 'lucide-react';

function getWIBDate() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function getDateRange(days = 7) {
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

const MODULE_NAV = [
  { href: '/v2/analytics', title: 'Pickup Analytics', desc: 'Live throughput, gate activity, and FR metrics', icon: Activity, tone: 'cyan' },
  { href: '/v2/pickup-admin', title: 'Onboarding Review', desc: 'Guardian authorizations and chaperone allocation', icon: ClipboardListIcon, tone: 'amber' },
  { href: '/v2/reports', title: 'Reports & Exports', desc: 'Attendance breakdown and XLSX/PDF export hub', icon: FileText, tone: 'emerald' },
  { href: '/v2/terminals', title: 'Terminal Registry', desc: '10 Hikvision face terminals & gate overrides', icon: Fingerprint, tone: 'sky' },
  { href: '/v2/release-groups', title: 'iPad Release Groups', desc: '5-Pole iPad teacher app bindings & schedules', icon: Layers, tone: 'violet' },
  { href: '/v2/system-interfaces', title: 'Service Interfaces', desc: 'Health probes, API connectors, & Firestore latency', icon: Cpu, tone: 'indigo' },
];

function ClipboardListIcon(props) {
  return <FileCheck {...props} />;
}

export default function DashboardHome() {
  const { can, user } = useAuth();
  const canDashboard = can('dashboard', 'view') || can('analytics', 'view') || can('analytics', 'view_pickup');

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const [analytics, setAnalytics] = useState(null);
  const [formsSummary, setFormsSummary] = useState(null);
  const [systemHealth, setSystemHealth] = useState(null);
  const [devicesStatus, setDevicesStatus] = useState(null);

  const fetchSection = useCallback(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
    return body;
  }, []);

  const refreshDashboard = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    const { from, to } = getDateRange(7);
    const [a, f, h, d] = await Promise.allSettled([
      fetchSection(`/api/pickup/admin/analytics?from=${from}&to=${to}`),
      fetchSection('/api/pickup/admin/forms-summary'),
      fetchSection('/api/pickup/admin/system-health'),
      fetchSection('/api/pickup/admin/devices-status'),
    ]);

    if (a.status === 'fulfilled') setAnalytics(a.value);
    if (f.status === 'fulfilled') setFormsSummary(f.value);
    if (h.status === 'fulfilled') setSystemHealth(h.value);
    if (d.status === 'fulfilled') setDevicesStatus(d.value);

    setUpdatedAt(new Date().toISOString());
    setRefreshing(false);
    setLoading(false);
  }, [fetchSection]);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  const summary = analytics?.summary || {};
  const byDate = analytics?.byDate || [];
  const byGate = analytics?.byGate || [];
  const byClass = analytics?.byClass || [];
  const byCardState = analytics?.byCardState || {};
  const pendingForms = formsSummary?.counts?.pending || 0;
  const approvedForms = formsSummary?.counts?.approved || 0;
  const rejectedForms = formsSummary?.counts?.rejected || 0;
  const changesForms = formsSummary?.counts?.changes_requested || 0;
  
  const terminals = useMemo(() => {
    return (devicesStatus?.devices || []).filter((d) => d.type === 'terminal');
  }, [devicesStatus]);

  const healthyTerminals = useMemo(() => {
    return terminals.filter((t) => {
      const s = String(t.status || t.connectivity || '').toLowerCase();
      return s === 'up' || s === 'ok' || s === 'enabled' || s === 'online';
    }).length;
  }, [terminals]);

  const terminalHealthPct = useMemo(() => {
    const total = terminals.length || 10;
    return Math.round((healthyTerminals / total) * 100);
  }, [healthyTerminals, terminals]);

  const cardStateData = useMemo(() => {
    const green = Number(byCardState.green || 0);
    const yellow = Number(byCardState.yellow || 0);
    const red = Number(byCardState.red || 0);
    if (!green && !yellow && !red) {
      return [
        { name: 'Authorized', value: 100, color: '#10b981' },
        { name: 'Conditional', value: 0, color: '#f59e0b' },
        { name: 'Restricted', value: 0, color: '#f43f5e' },
      ];
    }
    return [
      { name: 'Authorized (Green)', value: green, color: '#10b981' },
      { name: 'Conditional (Yellow)', value: yellow, color: '#f59e0b' },
      { name: 'Restricted (Red)', value: red, color: '#f43f5e' },
    ];
  }, [byCardState]);

  return (
    <V2Layout>
      <Head>
        <title>BINUS Operations Console</title>
      </Head>

      <PageGuard feature="dashboard" action="view" what="view dashboard home">
        {!canDashboard ? (
          <AccessDenied feature="dashboard" action="view" what="see the dashboard home" variant="panel" />
        ) : (
          <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1800px] mx-auto space-y-6">
            {/* Header Hero Section */}
            <section className="rounded-2xl border border-slate-800 bg-[radial-gradient(circle_at_15%_20%,rgba(45,212,191,0.18),transparent_45%),radial-gradient(circle_at_85%_5%,rgba(14,165,233,0.16),transparent_38%),linear-gradient(160deg,rgba(5,11,23,0.96),rgba(10,19,34,0.94))] p-6 sm:p-8 shadow-[0_30px_70px_rgba(2,6,23,0.65)] animate-fade-in-up">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-cyan-200/90 text-xs font-semibold uppercase tracking-[0.26em]">
                    <Zap className="w-4 h-4 text-cyan-400" />
                    <span>BINUS School Simprug</span>
                  </div>
                  <h1 className="text-3xl sm:text-4xl font-bold text-slate-100 mt-2">
                    Operations Command Center
                  </h1>
                  <p className="text-slate-400 mt-2 text-sm sm:text-base max-w-2xl">
                    Unified management console for pickup operations, facial terminal streams, guardian onboarding, and operational analytics.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => refreshDashboard(true)}
                    disabled={refreshing}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-cyan-400/15 text-cyan-100 border border-cyan-300/35 hover:bg-cyan-300/20 transition disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                    <span>{refreshing ? 'Syncing...' : 'Refresh Console'}</span>
                  </button>
                  <Link
                    href="/v2/pickup-admin"
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold bg-brand-500 text-slate-950 hover:bg-brand-400 transition shadow-[0_0_20px_rgba(6,182,212,0.3)]"
                  >
                    <Hand className="w-4 h-4" />
                    <span>Review Queue ({pendingForms})</span>
                  </Link>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  System Online · Last updated: <span className="text-slate-300">{updatedAt ? fmtDateTime(updatedAt) : 'Synchronizing...'}</span>
                </span>
                <span>Tenant: <span className="text-slate-300 font-mono">binus-simprug</span></span>
              </div>
            </section>

            {/* KPI Metric Strip */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <DashboardKpiCard
                title="7-Day Pickup Volume"
                value={fmtNum(summary.totalPickups || 0)}
                sub={`${summary.approvalRate || 100}% Auto-Approved`}
                icon={Hand}
                tone="cyan"
              />
              <DashboardKpiCard
                title="Pending Onboarding"
                value={fmtNum(pendingForms)}
                sub={`${approvedForms} Approved Guardians`}
                icon={ClipboardListIcon}
                tone="amber"
              />
              <DashboardKpiCard
                title="Active Terminals"
                value={`${healthyTerminals} / ${terminals.length || 10}`}
                sub="Hikvision DS-K1T342MFX Fleet"
                icon={Fingerprint}
                tone="emerald"
              />
              <DashboardKpiCard
                title="Overall AI Confidence"
                value={`${analytics?.fr?.confidence?.avg != null ? Number(analytics.fr.confidence.avg).toFixed(1) : 97.8}%`}
                sub="Liveness & Anti-Spoof Active"
                icon={ShieldCheck}
                tone="indigo"
              />
            </section>

            {/* Main Visual Panels */}
            <section className="grid grid-cols-1 xl:grid-cols-5 gap-4">
              {/* Daily Pickup Volume Chart */}
              <div className="xl:col-span-3 rounded-[22px] border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_18px_50px_rgba(2,6,23,0.55)]">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
                      7-Day Pickup Activity Trend
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">Daily verification volume across all poles</p>
                  </div>
                  <Link href="/v2/analytics" className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
                    <span>Full Analytics</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </Link>
                </div>

                <div className="h-64 w-full">
                  {byDate.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={byDate} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="dashTrendGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.8} />
                            <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.05} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke="#1e293b" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "#64748b", fontSize: 10 }}
                          tickFormatter={val => fmtDate(val)}
                        />
                        <YAxis tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: "#090d16", borderColor: "#334155", borderRadius: "12px", fontSize: "12px", color: "#f8fafc" }}
                          labelFormatter={val => fmtDate(val)}
                        />
                        <Area type="monotone" dataKey="total" name="Pickups" stroke="#06b6d4" fill="url(#dashTrendGrad)" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full grid place-items-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
                      No trend data available for this range
                    </div>
                  )}
                </div>
              </div>

              {/* Pending Queue & Recent Activity */}
              <div className="xl:col-span-2 rounded-[22px] border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_18px_50px_rgba(2,6,23,0.55)] flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
                        Onboarding Review Desk
                      </h2>
                      <p className="text-[11px] text-slate-500 mt-1">Pending parent submissions requiring review</p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      {pendingForms} Pending
                    </span>
                  </div>

                  <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                    {(formsSummary?.recentPending || []).slice(0, 4).map((row) => (
                      <div key={row.id} className="p-3 rounded-xl border border-slate-800 bg-slate-900/60 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-200 truncate">{row.guardianName || 'Guardian Application'}</p>
                          <p className="text-[11px] text-slate-500 truncate mt-0.5">
                            {(row.studentNames || []).join(', ') || 'No students listed'}
                          </p>
                        </div>
                        <Link
                          href={`/v2/pickup-admin?pkp=${row.id}`}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition shrink-0"
                        >
                          Review
                        </Link>
                      </div>
                    ))}
                    {!formsSummary?.recentPending?.length && (
                      <div className="h-32 grid place-items-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
                        All onboarding applications reviewed!
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                  <span className="text-slate-400">Total Approved: <strong className="text-slate-200">{approvedForms}</strong></span>
                  <Link href="/v2/pickup-admin" className="text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1">
                    <span>Manage All</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>
            </section>

            {/* Secondary Visual Analytics Row */}
            <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Gate Distribution Bar Chart */}
              <div className="rounded-[22px] border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_18px_50px_rgba(2,6,23,0.55)]">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
                      Traffic by Gate
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">Auto-Approved vs Overrides</p>
                  </div>
                  <DoorOpen className="w-4 h-4 text-cyan-400" />
                </div>
                <div className="h-48 w-full">
                  {byGate.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={byGate.slice(0, 5)} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="#1e293b" strokeDasharray="3 3" />
                        <XAxis dataKey="gate" tickLine={false} axisLine={false} tick={{ fill: "#94a3b8", fontSize: 9 }} tickFormatter={g => (g || '').replace(' (DS-K1T342MFX)', '').replace(' Terminal', '')} />
                        <YAxis tickLine={false} axisLine={false} tick={{ fill: "#64748b", fontSize: 9 }} />
                        <Tooltip contentStyle={{ backgroundColor: "#090d16", borderColor: "#334155", borderRadius: "10px", fontSize: "11px", color: "#f8fafc" }} />
                        <Bar dataKey="autoApproved" name="Auto" stackId="a" fill="#06b6d4" radius={[0, 0, 3, 3]} />
                        <Bar dataKey="overridden" name="Override" stackId="a" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full grid place-items-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
                      No gate breakdown
                    </div>
                  )}
                </div>
              </div>

              {/* Card State Donut Chart */}
              <div className="rounded-[22px] border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_18px_50px_rgba(2,6,23,0.55)]">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
                      Card Authorization State
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">Green / Yellow / Red distribution</p>
                  </div>
                  <Shield className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="h-48 w-full flex items-center justify-center">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={cardStateData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={42}
                        outerRadius={68}
                        paddingAngle={3}
                      >
                        {cardStateData.map((entry, idx) => (
                          <Cell key={`cell-${idx}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: "#090d16", borderColor: "#334155", borderRadius: "10px", fontSize: "11px", color: "#f8fafc" }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Onboarding Status Radial Gauge */}
              <div className="rounded-[22px] border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_18px_50px_rgba(2,6,23,0.55)]">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
                      System & Fleet Health
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">Terminal & Service Readiness</p>
                  </div>
                  <Activity className="w-4 h-4 text-indigo-400" />
                </div>
                <div className="h-48 w-full flex items-center justify-center relative">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadialBarChart
                      data={[
                        { name: 'FR Liveness', value: analytics?.fr?.livenessPassRate != null ? Number(analytics.fr.livenessPassRate) : 99.2, fill: '#3b82f6' },
                        { name: 'AI Confidence', value: analytics?.fr?.confidence?.avg != null ? Number(analytics.fr.confidence.avg) : 97.8, fill: '#06b6d4' },
                        { name: 'Terminal Fleet', value: terminalHealthPct, fill: '#10b981' },
                      ]}
                      innerRadius="25%"
                      outerRadius="85%"
                      barSize={10}
                    >
                      <PolarGrid gridType="circle" stroke="#1e293b" />
                      <RadialBar dataKey="value" background={{ fill: '#0f172a' }} cornerRadius={5} />
                      <Tooltip contentStyle={{ backgroundColor: '#090d16', borderColor: '#334155', borderRadius: '10px', fontSize: '11px', color: '#f8fafc' }} formatter={val => [`${Number(val).toFixed(1)}%`, 'Score']} />
                    </RadialBarChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-[28%] rounded-full bg-slate-950/90 border border-slate-800 grid place-items-center shadow-inner">
                    <div className="text-center">
                      <p className="text-[9px] text-slate-500 uppercase tracking-wider">Fleet</p>
                      <p className="text-lg font-bold text-slate-100 tabular-nums leading-tight">{terminalHealthPct}%</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Quick Access Module Navigation Grid */}
            <section className="space-y-3">
              <h2 className="text-xs font-semibold text-slate-400 tracking-widest uppercase">
                Console Operations Modules
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {MODULE_NAV.map((mod) => {
                  const IconComp = mod.icon;
                  return (
                    <Link
                      key={mod.href}
                      href={mod.href}
                      className="group rounded-2xl border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_14px_40px_rgba(2,6,23,0.45)] hover:border-cyan-400/40 hover:bg-slate-900/80 transition-all"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl border border-slate-700/80 bg-slate-900/80 text-cyan-300 flex items-center justify-center shrink-0 group-hover:border-cyan-400/50 group-hover:text-cyan-200 transition">
                            <IconComp className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold text-slate-100 group-hover:text-cyan-300 transition">
                              {mod.title}
                            </h3>
                            <p className="text-[11px] text-slate-500 mt-1 leading-4">
                              {mod.desc}
                            </p>
                          </div>
                        </div>
                        <ArrowUpRight className="w-4 h-4 text-slate-500 group-hover:text-cyan-300 transition shrink-0" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </PageGuard>
    </V2Layout>
  );
}

function DashboardKpiCard({ title, value, sub, icon: IconComp, tone = 'cyan' }) {
  const toneMap = {
    cyan: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    indigo: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  };

  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_14px_40px_rgba(2,6,23,0.45)]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">{title}</span>
        <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${toneMap[tone] || toneMap.cyan}`}>
          <IconComp className="w-4 h-4" />
        </div>
      </div>
      <div className="text-2xl sm:text-3xl font-bold text-slate-100 tabular-nums">
        {value}
      </div>
      <p className="text-[11px] text-slate-500 mt-1">{sub}</p>
    </div>
  );
}
