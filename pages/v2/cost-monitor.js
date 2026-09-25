import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import MonitorTopNav from '../../components/v2/MonitorTopNav';
import PageGuard from '../../components/v2/PageGuard';
import AccessDenied from '../../components/v2/AccessDenied';
import { useAuth } from '../../lib/AuthContext';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  DollarSign, Zap, Mail, GitBranch, Globe,
  RefreshCw, TrendingUp, TrendingDown, Minus,
  CheckCircle, AlertTriangle, Clock, Server,
  ExternalLink, Bot, Layers, X, ChevronRight,
  Activity, CreditCard, Key,
} from 'lucide-react';

const COST_MONITOR_EMAIL = (process.env.NEXT_PUBLIC_COST_MONITOR_EMAIL || 'icanntechindo@gmail.com').toLowerCase();

// ── Colors ───────────────────────────────────────────────────────────
const SERVICE_COLORS = {
  cloudFunctions: '#8b5cf6',  // violet
  resend:         '#06b6d4',  // cyan
  anthropic:      '#f59e0b',  // amber
  vercel:         '#3b82f6',  // blue
  github:         '#10b981',  // emerald
  domains:        '#f43f5e',  // rose
};

const PIE_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#3b82f6', '#10b981', '#f43f5e'];

// ── Month utilities ───────────────────────────────────────────────────

function currentMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthOptions() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    opts.push({ value, label });
  }
  return opts;
}

function fmtMonthLabel(monthStr) {
  if (!monthStr) return '';
  const [year, month] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// ── Formatters ────────────────────────────────────────────────────────

function fmtNum(n) {
  const val = Number(n || 0);
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(val);
}

function fmtCost(val) {
  const n = parseFloat(val || 0);
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtRelative(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function domainTone(days) {
  if (days == null) return 'rose';
  if (days > 90) return 'emerald';
  if (days > 30) return 'amber';
  return 'rose';
}

function pctTone(pct) {
  if (pct > 80) return 'rose';
  if (pct > 50) return 'amber';
  return 'emerald';
}

const TONE_CLASSES = {
  emerald: { badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', bar: '#10b981', dot: 'bg-emerald-400' },
  amber:   { badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',       bar: '#f59e0b', dot: 'bg-amber-400' },
  rose:    { badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',          bar: '#f43f5e', dot: 'bg-rose-400' },
  sky:     { badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30',            bar: '#0ea5e9', dot: 'bg-sky-400' },
};

// ── Base components ───────────────────────────────────────────────────

function Panel({ title, subtitle, className = '', delay = '0ms', action, children }) {
  return (
    <div
      className={`rounded-[22px] border border-slate-800/80 bg-slate-950/72 shadow-[0_18px_50px_rgba(2,6,23,0.55)] p-4 sm:p-5 backdrop-blur-[2px] animate-fade-in-up ${className}`}
      style={{ animationDelay: delay }}
    >
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[13px] font-semibold text-slate-100 tracking-[0.16em] uppercase">{title}</h2>}
            {subtitle && <p className="text-[11px] text-slate-500 mt-1 leading-5">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

function StatusDot({ tone = 'emerald' }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${TONE_CLASSES[tone]?.dot || 'bg-slate-500'}`} />;
}

function Badge({ children, tone = 'sky' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TONE_CLASSES[tone]?.badge || ''}`}>
      {children}
    </span>
  );
}

function ProgressBar({ pct, tone = 'emerald', height = 'h-1.5' }) {
  const color = TONE_CLASSES[tone]?.bar || '#10b981';
  return (
    <div className={`w-full ${height} rounded-full bg-slate-800 overflow-hidden`}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(pct || 0, 100)}%`, backgroundColor: color }}
      />
    </div>
  );
}

// ── Hero metric card ──────────────────────────────────────────────────

function HeroCard({ icon: Icon, label, value, sub, tone = 'sky', sparkData, sparkKey, color, delay }) {
  return (
    <div
      className="rounded-[22px] border border-slate-800/80 bg-slate-950/72 p-4 sm:p-5 backdrop-blur-[2px] animate-fade-in-up flex flex-col gap-1"
      style={{ animationDelay: delay }}
    >
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider ${TONE_CLASSES[tone]?.badge?.split(' ')[1] || 'text-sky-300'}`}>
          <Icon size={13} />
          <span>{label}</span>
        </div>
        {sub && (
          <span className="text-[11px] text-slate-500">{sub}</span>
        )}
      </div>
      <p className="text-2xl sm:text-3xl font-bold text-slate-100 mt-1">{value}</p>
      {sparkData && sparkData.length > 1 && (
        <div className="h-10 w-full mt-1 -mx-1">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData} margin={{ top: 2, right: 4, left: 4, bottom: 2 }}>
              <defs>
                <linearGradient id={`spark-${sparkKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color || '#06b6d4'} stopOpacity={0.5} />
                  <stop offset="95%" stopColor={color || '#06b6d4'} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={color || '#06b6d4'}
                strokeWidth={1.5}
                fill={`url(#spark-${sparkKey})`}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────
const CHART_TOOLTIP = {
  contentStyle: {
    backgroundColor: '#090d16',
    borderColor: '#334155',
    borderRadius: '12px',
    fontSize: '12px',
    color: '#f8fafc',
  },
};

// ── Page ──────────────────────────────────────────────────────────────

export default function CostMonitorPage() {
  const { user, can } = useAuth();
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [summary, setSummary] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [detailService, setDetailService] = useState(null); // 'cloudFunctions'|'resend'|'anthropic'|'vercel'|'github'|'domains'

  const months = useMemo(() => monthOptions(), []);

  const isAllowed = can('cost_monitor', 'view') && user?.email?.toLowerCase() === COST_MONITOR_EMAIL;

  const fetchData = useCallback(async (month) => {
    setLoading(true);
    setError(null);
    try {
      const [sumRes, tlRes] = await Promise.all([
        fetch(`/api/cost/summary?month=${month}`, { credentials: 'include' }),
        fetch(`/api/cost/timeline?month=${month}`, { credentials: 'include' }),
      ]);
      if (sumRes.status === 403) throw new Error('Access denied');
      if (!sumRes.ok) throw new Error(`Summary API error ${sumRes.status}`);
      const [sumJson, tlJson] = await Promise.all([sumRes.json(), tlRes.ok ? tlRes.json() : Promise.resolve(null)]);
      setSummary(sumJson);
      setTimeline(tlJson);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAllowed) fetchData(selectedMonth);
  }, [isAllowed, selectedMonth, fetchData]);

  if (!can('cost_monitor', 'view') || user?.email?.toLowerCase() !== COST_MONITOR_EMAIL) {
    return (
      <V2Layout>
        <Head><title>Cost Monitor</title></Head>
        <AccessDenied feature="cost_monitor" action="view" />
      </V2Layout>
    );
  }

  const svc = summary?.services || {};
  const totals = summary?.totals || {};

  // Build sparkline data from timeline series
  const sparkEmails = (timeline?.series || []).map((d) => ({ v: d.emails }));
  const sparkCF = (timeline?.series || []).map((d) => ({ v: d.cfCalls }));
  const sparkTokens = [];

  // Donut data
  const donutData = [
    { name: 'Cloud Functions', value: parseFloat(svc.cloudFunctions?.estimatedCost || 0) || 0.001, color: SERVICE_COLORS.cloudFunctions },
    { name: 'Resend', value: parseFloat(svc.resend?.estimatedCost || 0) || 0.001, color: SERVICE_COLORS.resend },
    { name: 'Claude API', value: parseFloat(svc.anthropic?.estimatedCost || 0) || 0.001, color: SERVICE_COLORS.anthropic },
    { name: 'Vercel', value: parseFloat(svc.vercel?.estimatedCost || 0) || 0.001, color: SERVICE_COLORS.vercel },
    { name: 'GitHub', value: parseFloat(svc.github?.estimatedCost || 0) || 0.001, color: SERVICE_COLORS.github },
  ];
  const totalDonut = donutData.reduce((s, d) => s + d.value, 0);
  const allFree = parseFloat(totals.estimatedCost || 0) === 0;

  // Chart data for trend
  const trendData = (timeline?.series || []).map((d) => ({
    date: d.date.slice(5),           // "MM-DD"
    emails: d.emails,
    cfCalls: d.cfCalls,
  }));

  // Domain health
  const domainList = svc.domains?.domains || [];

  return (
    <V2Layout>
      <Head><title>Operations Monitor — BINUS</title></Head>
      <PageGuard feature="cost_monitor" action="view" what="view cost monitor">
        <MonitorTopNav />
        <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1800px] mx-auto space-y-4">

          {/* ── Header ─────────────────────────────────────────────── */}
          <section
            className="rounded-2xl border border-slate-800 bg-[radial-gradient(circle_at_15%_20%,rgba(45,212,191,0.14),transparent_45%),radial-gradient(circle_at_85%_5%,rgba(139,92,246,0.12),transparent_38%),linear-gradient(160deg,rgba(5,11,23,0.97),rgba(10,19,34,0.95))] p-5 sm:p-6 shadow-[0_30px_70px_rgba(2,6,23,0.65)] animate-fade-in-up"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="text-[11px] tracking-[0.26em] uppercase text-violet-300/90 font-semibold flex items-center gap-2">
                  <DollarSign size={11} /> OPERATIONS MONITOR
                </p>
                <h1 className="text-2xl sm:text-3xl font-semibold text-slate-100 mt-1.5">
                  Financial Overview
                </h1>
                <p className="text-slate-400 mt-1 text-sm">
                  Cost, utilization & system health across all projects
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                {/* Month picker */}
                <select
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                  className="bg-slate-900 border border-slate-700 text-slate-200 rounded-lg text-sm px-3 py-1.5 focus:outline-none focus:border-violet-500 cursor-pointer"
                >
                  {months.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                {/* Refresh */}
                <button
                  onClick={() => fetchData(selectedMonth)}
                  disabled={loading}
                  className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-sm px-3 py-1.5 transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                  Refresh
                </button>
                {lastUpdated && (
                  <span className="text-[11px] text-slate-500">Updated {fmtRelative(lastUpdated)}</span>
                )}
              </div>
            </div>
          </section>

          {/* ── Error ──────────────────────────────────────────────── */}
          {error && (
            <section className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-3 text-sm text-rose-100 animate-fade-in-up flex items-center gap-2">
              <AlertTriangle size={14} />
              {error}
            </section>
          )}

          {/* ── Insight strip ──────────────────────────────────────── */}
          {summary?.insight && !error && (
            <section className="rounded-xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 flex items-center gap-3 text-sm text-violet-100 animate-fade-in-up">
              <Bot size={15} className="shrink-0 text-violet-400" />
              <span><span className="font-semibold text-violet-300">Insight</span> — {summary.insight}</span>
            </section>
          )}

          {/* ── Hero KPI cards ─────────────────────────────────────── */}
          <section className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <HeroCard
              icon={DollarSign}
              label="MTD Cost Est."
              value={loading ? '—' : fmtCost(totals.estimatedCost)}
              sub={fmtMonthLabel(selectedMonth)}
              tone="emerald"
              sparkData={trendData.map((d) => ({ v: d.emails + d.cfCalls }))}
              sparkKey="total"
              color="#10b981"
              delay="0ms"
            />
            <HeroCard
              icon={Mail}
              label="Emails Sent"
              value={loading ? '—' : fmtNum(svc.resend?.total ?? svc.emailQueue?.total ?? 0)}
              sub={svc.resend?.ok ? `${svc.resend?.usagePct || 0}% of free tier` : 'via queue'}
              tone="sky"
              sparkData={sparkEmails}
              sparkKey="emails"
              color={SERVICE_COLORS.resend}
              delay="50ms"
            />
            <HeroCard
              icon={Zap}
              label="CF Invocations"
              value={loading ? '—' : fmtNum(svc.cloudFunctions?.invocations ?? 0)}
              sub={`${svc.cloudFunctions?.invPct ?? 0}% of 2M free`}
              tone="sky"
              sparkData={sparkCF}
              sparkKey="cf"
              color={SERVICE_COLORS.cloudFunctions}
              delay="100ms"
            />
            <HeroCard
              icon={Layers}
              label="Free Services"
              value={loading ? '—' : `${totals.freeServices ?? 0} / ${totals.totalServices ?? 5}`}
              sub={allFree ? '✓ All on free tier' : 'paid services active'}
              tone={allFree ? 'emerald' : 'amber'}
              sparkData={[]}
              sparkKey="free"
              color="#10b981"
              delay="150ms"
            />
          </section>

          {/* ── Trend chart ────────────────────────────────────────── */}
          <Panel
            title="Daily Activity Trend"
            subtitle={`${fmtMonthLabel(selectedMonth)} — emails sent vs Cloud Function calls`}
            delay="100ms"
          >
            {trendData.length > 0 ? (
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="grad-emails" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SERVICE_COLORS.resend} stopOpacity={0.6} />
                        <stop offset="95%" stopColor={SERVICE_COLORS.resend} stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="grad-cf" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SERVICE_COLORS.cloudFunctions} stopOpacity={0.5} />
                        <stop offset="95%" stopColor={SERVICE_COLORS.cloudFunctions} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: '#64748b', fontSize: 10 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
                    <Tooltip {...CHART_TOOLTIP} />
                    <Area
                      type="monotone"
                      dataKey="emails"
                      name="Emails"
                      stroke={SERVICE_COLORS.resend}
                      fill="url(#grad-emails)"
                      strokeWidth={1.5}
                      dot={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="cfCalls"
                      name="CF Calls"
                      stroke={SERVICE_COLORS.cloudFunctions}
                      fill="url(#grad-cf)"
                      strokeWidth={1.5}
                      dot={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-56 flex items-center justify-center text-slate-600 text-sm">
                {loading ? 'Loading trend data…' : 'No timeline data available'}
              </div>
            )}
            <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full bg-cyan-400 inline-block" /> Emails</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full bg-violet-400 inline-block" /> CF Calls</span>
            </div>
          </Panel>

          {/* ── Email analytics ────────────────────────────────────── */}
          {(svc.resend?.ok || svc.emailQueue?.total > 0) && (() => {
            const byTemplate = svc.resend?.byTemplate || {};
            const templateData = Object.entries(byTemplate)
              .map(([k, v]) => ({ name: k.replace(/_/g, ' '), count: v }))
              .sort((a, b) => b.count - a.count);
            const deliveryRate = svc.resend?.deliveryRate ?? 100;
            const delivered = svc.resend?.delivered ?? svc.emailQueue?.sent ?? 0;
            const bounced = svc.resend?.bounced ?? 0;
            const failed = svc.emailQueue?.failed ?? 0;
            const totalSent = svc.resend?.total ?? svc.emailQueue?.total ?? 0;
            const drTone = deliveryRate >= 95 ? 'emerald' : deliveryRate >= 80 ? 'amber' : 'rose';
            return (
              <section className="grid grid-cols-1 xl:grid-cols-5 gap-4">
                <Panel title="Email by Template" subtitle="Send volume by notification type" className="xl:col-span-3" delay="120ms">
                  {templateData.length > 0 ? (
                    <div className="h-[180px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={templateData} layout="vertical" margin={{ top: 2, right: 20, left: 10, bottom: 2 }}>
                          <XAxis type="number" tickLine={false} axisLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
                          <YAxis
                            dataKey="name"
                            type="category"
                            width={140}
                            tickLine={false}
                            axisLine={false}
                            tick={{ fill: '#94a3b8', fontSize: 11 }}
                          />
                          <Tooltip {...CHART_TOOLTIP} />
                          <Bar dataKey="count" fill={SERVICE_COLORS.resend} radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-[180px] flex items-center justify-center text-slate-600 text-sm">No template data yet</div>
                  )}
                </Panel>
                <Panel title="Delivery Quality" subtitle="Resend delivery metrics" className="xl:col-span-2" delay="160ms">
                  <div className="flex flex-col gap-4">
                    <div className="text-center py-2">
                      <p className={`text-4xl font-bold ${TONE_CLASSES[drTone]?.badge?.split(' ')[1] || 'text-emerald-300'}`}>
                        {deliveryRate}%
                      </p>
                      <p className="text-[11px] text-slate-500 mt-1">delivery rate</p>
                    </div>
                    <div className="space-y-2 text-[12px]">
                      <div className="flex items-center justify-between py-1.5 border-b border-slate-800/60">
                        <span className="flex items-center gap-2 text-slate-400"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Delivered</span>
                        <span className="text-slate-200 font-mono">{fmtNum(delivered)}</span>
                      </div>
                      {bounced > 0 && (
                        <div className="flex items-center justify-between py-1.5 border-b border-slate-800/60">
                          <span className="flex items-center gap-2 text-slate-400"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Bounced</span>
                          <span className="text-amber-300 font-mono">{fmtNum(bounced)}</span>
                        </div>
                      )}
                      {failed > 0 && (
                        <div className="flex items-center justify-between py-1.5 border-b border-slate-800/60">
                          <span className="flex items-center gap-2 text-slate-400"><span className="w-2 h-2 rounded-full bg-rose-400 inline-block" /> Failed</span>
                          <span className="text-rose-300 font-mono">{fmtNum(failed)}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between py-1.5">
                        <span className="text-slate-500">Total sent</span>
                        <span className="text-slate-300 font-mono">{fmtNum(totalSent)}</span>
                      </div>
                    </div>
                  </div>
                </Panel>
              </section>
            );
          })()}

          {/* ── Cost breakdown + Service table ─────────────────────── */}
          <section className="grid grid-cols-1 xl:grid-cols-5 gap-4">

            {/* Donut */}
            <Panel title="Cost Breakdown" subtitle="By service, MTD" className="xl:col-span-2" delay="150ms">
              <div className="h-[200px] flex items-center">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={donutData}
                      dataKey="value"
                      cx="45%"
                      cy="50%"
                      outerRadius={80}
                      innerRadius={48}
                      paddingAngle={3}
                      stroke="none"
                    >
                      {donutData.map((entry, index) => (
                        <Cell key={entry.name} fill={entry.color} opacity={0.9} />
                      ))}
                    </Pie>
                    <Tooltip
                      {...CHART_TOOLTIP}
                      formatter={(v, name) => [allFree ? '$0.00' : fmtCost(v), name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-col gap-1.5 pr-2 min-w-[130px]">
                  {donutData.map((d) => (
                    <div key={d.name} className="flex items-center gap-2 text-[11px]">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                      <span className="text-slate-400 truncate">{d.name}</span>
                      <span className="text-slate-300 font-mono ml-auto shrink-0">
                        {allFree ? '$0' : fmtCost(d.value)}
                      </span>
                    </div>
                  ))}
                  <div className="mt-2 pt-2 border-t border-slate-800 flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">Total</span>
                    <span className="text-slate-200 font-semibold">{fmtCost(totals.estimatedCost)}</span>
                  </div>
                </div>
              </div>
            </Panel>

            {/* Service table */}
            <Panel title="Service Health" subtitle="Volume, cost & free tier utilization" className="xl:col-span-3" delay="200ms">
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800">
                      <th className="text-left text-slate-500 font-medium py-2 pr-3 whitespace-nowrap">Service</th>
                      <th className="text-right text-slate-500 font-medium py-2 px-2 whitespace-nowrap">Volume</th>
                      <th className="text-right text-slate-500 font-medium py-2 px-2 whitespace-nowrap">MTD Cost</th>
                      <th className="text-left text-slate-500 font-medium py-2 pl-3 whitespace-nowrap">Free Tier</th>
                      <th className="text-right text-slate-500 font-medium py-2 pl-2 whitespace-nowrap">Trend</th>
                      <th className="w-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <ServiceRow
                      icon={<Zap size={12} />}
                      name="Cloud Functions"
                      ok={svc.cloudFunctions?.ok}
                      volume={`${fmtNum(svc.cloudFunctions?.invocations || 0)} calls`}
                      cost="$0.00"
                      pct={svc.cloudFunctions?.invPct || 0}
                      sparkData={sparkCF}
                      color={SERVICE_COLORS.cloudFunctions}
                      onClick={() => setDetailService('cloudFunctions')}
                    />
                    <ServiceRow
                      icon={<Mail size={12} />}
                      name="Resend Email"
                      ok={svc.resend?.ok}
                      volume={`${fmtNum(svc.resend?.total || svc.emailQueue?.total || 0)} emails`}
                      cost={fmtCost(svc.resend?.estimatedCost)}
                      pct={svc.resend?.usagePct || 0}
                      sparkData={sparkEmails}
                      color={SERVICE_COLORS.resend}
                      onClick={() => setDetailService('resend')}
                    />
                    <ServiceRow
                      icon={<Bot size={12} />}
                      name="Claude / Anthropic"
                      ok={svc.anthropic?.ok}
                      notAvailable={svc.anthropic?.reason === 'api_not_available' || svc.anthropic?.reason === 'admin_key_required'}
                      volume={`${fmtNum(svc.anthropic?.totalTokens || 0)} tokens`}
                      cost={fmtCost(svc.anthropic?.estimatedCost)}
                      pct={null}
                      sparkData={[]}
                      color={SERVICE_COLORS.anthropic}
                      link={svc.anthropic?.data?.consoleUrl || svc.anthropic?.consoleUrl}
                      onClick={() => setDetailService('anthropic')}
                    />
                    <ServiceRow
                      icon={<Server size={12} />}
                      name="Vercel"
                      ok={svc.vercel?.ok}
                      volume={`${svc.vercel?.totalDeployments || 0} deploys`}
                      cost="$0.00"
                      pct={null}
                      sparkData={[]}
                      color={SERVICE_COLORS.vercel}
                      onClick={() => setDetailService('vercel')}
                    />
                    <ServiceRow
                      icon={<GitBranch size={12} />}
                      name="GitHub Copilot"
                      ok={svc.github?.ok}
                      volume={`${svc.github?.activeSeats || 0} seat${svc.github?.activeSeats !== 1 ? 's' : ''}`}
                      cost={fmtCost(svc.github?.estimatedCost)}
                      pct={null}
                      paid={parseFloat(svc.github?.estimatedCost || 0) > 0}
                      sparkData={[]}
                      color={SERVICE_COLORS.github}
                      onClick={() => setDetailService('github')}
                    />
                    <ServiceRow
                      icon={<Globe size={12} />}
                      name="Domains"
                      ok={svc.domains?.ok}
                      volume={`${domainList.length} cert${domainList.length !== 1 ? 's' : ''}`}
                      cost="$0.00"
                      pct={null}
                      sparkData={[]}
                      color={SERVICE_COLORS.domains}
                      onClick={() => setDetailService('domains')}
                    />
                  </tbody>
                </table>
              </div>
            </Panel>
          </section>

          {/* ── Free tier runway + Domain health ───────────────────── */}
          <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">

            {/* Free tier runway */}
            <Panel title="Free Tier Runway" subtitle="Estimated days until limit at current pace" delay="250ms">
              <div className="space-y-3">
                <RunwayRow
                  label="Resend emails"
                  used={svc.resend?.total || svc.emailQueue?.total || 0}
                  limit={svc.resend?.freeLimit || 3000}
                  unit="emails"
                />
                <RunwayRow
                  label="CF Invocations"
                  used={svc.cloudFunctions?.invocations || 0}
                  limit={2_000_000}
                  unit="calls"
                />
                <RunwayRow
                  label="CF GB-seconds"
                  used={Math.round((svc.cloudFunctions?.gbSeconds || 0) * 100) / 100}
                  limit={400_000}
                  unit="GB-s"
                />
              </div>

              {/* Paid services section */}
              {(svc.github?.ok && parseFloat(svc.github?.estimatedCost || 0) > 0) && (
                <div className="mt-4 pt-4 border-t border-slate-800">
                  <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-2">Paid Services</p>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="flex items-center gap-2 text-slate-300">
                      <GitBranch size={11} className="text-emerald-400" />
                      GitHub Copilot — {svc.github?.activeSeats || 0} seat{svc.github?.activeSeats !== 1 ? 's' : ''}
                    </span>
                    <Badge tone="amber">{fmtCost(svc.github?.estimatedCost)}/mo</Badge>
                  </div>
                </div>
              )}
            </Panel>

            {/* Domain / cert health */}
            <Panel title="Domain & Certificate Health" subtitle="SSL cert expiry monitoring" delay="300ms">
              {domainList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
                  <Globe size={24} className="text-slate-700" />
                  <p className="text-sm text-slate-600">No domains configured</p>
                  <p className="text-[11px] text-slate-700">Set <code className="text-slate-500">MONITOR_DOMAINS</code> env var</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {domainList.map((d) => {
                    const tone = domainTone(d.daysRemaining);
                    return (
                      <div key={d.domain} className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <StatusDot tone={tone} />
                          <span className="text-[12px] text-slate-300 truncate font-mono">{d.domain}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {d.ok ? (
                            <>
                              <span className="text-[11px] text-slate-500">{d.daysRemaining}d remaining</span>
                              <Badge tone={tone}>
                                {tone === 'emerald' ? 'Healthy' : tone === 'amber' ? 'Expiring soon' : 'Critical'}
                              </Badge>
                            </>
                          ) : (
                            <Badge tone="rose">{d.reason || 'Error'}</Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Quick links */}
              <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap gap-2">
                <a
                  href="https://console.anthropic.com/settings/usage"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-amber-300 transition-colors"
                >
                  <ExternalLink size={10} /> Anthropic Console
                </a>
                <a
                  href="https://vercel.com/dashboard"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-blue-300 transition-colors"
                >
                  <ExternalLink size={10} /> Vercel Dashboard
                </a>
                <a
                  href="https://github.com/icannDevTeam"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-emerald-300 transition-colors"
                >
                  <ExternalLink size={10} /> GitHub Org
                </a>
              </div>
            </Panel>
          </section>

          {/* ── GitHub Copilot + CF Functions ─────────────────────── */}
          <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">

            {/* GitHub Copilot detail */}
            <Panel title="GitHub Copilot" subtitle="License usage & billing" delay="280ms">
              {!svc.github?.ok ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
                  <GitBranch size={24} className="text-slate-700" />
                  <p className="text-sm text-slate-400">
                    {svc.github?.data?.setupNote || svc.github?.reason || 'GITHUB_TOKEN not configured'}
                  </p>
                  <a
                    href={svc.github?.data?.setupUrl || 'https://github.com/settings/tokens/new'}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:text-emerald-200 rounded-lg px-3 py-1.5 text-[12px] transition-colors"
                  >
                    <ExternalLink size={11} /> {svc.github?.reason === 'fine_grained_pat' ? 'Create classic PAT instead' : 'GitHub Copilot Settings'}
                  </a>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3 text-center">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Active Seats</p>
                      <p className="text-2xl font-bold text-slate-100 mt-1">{svc.github.activeSeats ?? 0}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">of {svc.github.totalSeats ?? 0} total</p>
                    </div>
                    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3 text-center">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Monthly</p>
                      <p className="text-2xl font-bold text-amber-300 mt-1">{fmtCost(svc.github.estimatedCost)}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">${svc.github.perSeatPrice ?? 19}/seat</p>
                    </div>
                    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3 text-center">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Annual Est.</p>
                      <p className="text-2xl font-bold text-slate-100 mt-1">{fmtCost(parseFloat(svc.github.estimatedCost || 0) * 12)}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">projected</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[12px] pt-2 border-t border-slate-800">
                    <span className="text-slate-500">Plan</span>
                    <Badge tone="amber">{svc.github.planType || 'Business'}</Badge>
                  </div>
                  {svc.github.org && (
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="text-slate-500">Organization</span>
                      <a href={`https://github.com/${svc.github.org}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-slate-300 hover:text-emerald-300">
                        {svc.github.org} <ExternalLink size={10} />
                      </a>
                    </div>
                  )}
                </div>
              )}
            </Panel>

            {/* Cloud Functions per-function breakdown */}
            <Panel title="Cloud Functions Breakdown" subtitle="Invocations per function" delay="320ms">
              {!svc.cloudFunctions?.ok ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
                  <Zap size={24} className="text-slate-700" />
                  <p className="text-sm text-slate-600">{svc.cloudFunctions?.reason || 'Add roles/monitoring.viewer to service account'}</p>
                  <a href="https://console.cloud.google.com/iam-admin/iam" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[12px] text-violet-400 hover:text-violet-300 mt-1">
                    <ExternalLink size={11} /> GCP IAM Console
                  </a>
                </div>
              ) : Object.keys(svc.cloudFunctions?.byFunction || {}).length === 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-[12px] py-2 border-b border-slate-800">
                    <span className="text-slate-400">Total invocations</span>
                    <span className="text-slate-200 font-mono font-semibold">{fmtNum(svc.cloudFunctions?.invocations || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] py-2 border-b border-slate-800">
                    <span className="text-slate-400">GB-seconds consumed</span>
                    <span className="text-slate-200 font-mono">{(svc.cloudFunctions?.gbSeconds || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[12px] py-2">
                    <span className="text-slate-500 italic">Per-function data unavailable</span>
                    <span className="text-slate-600 text-[11px]">requires monitoring.viewer</span>
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th className="text-left text-slate-500 font-medium py-2 pr-3">Function</th>
                        <th className="text-right text-slate-500 font-medium py-2 px-2">Calls</th>
                        <th className="text-left text-slate-500 font-medium py-2 pl-3">Usage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(svc.cloudFunctions.byFunction)
                        .sort(([, a], [, b]) => (b.count || b) - (a.count || a))
                        .slice(0, 6)
                        .map(([fn, data]) => {
                          const count = typeof data === 'object' ? data.count : data;
                          const total = svc.cloudFunctions.invocations || 1;
                          const pct = Math.round((count / total) * 100);
                          return (
                            <tr key={fn} className="border-b border-slate-800/40 hover:bg-slate-900/30 transition-colors">
                              <td className="py-2.5 pr-3 text-slate-300 font-mono text-[11px] max-w-[180px] truncate">{fn}</td>
                              <td className="py-2.5 px-2 text-right text-slate-400 font-mono">{fmtNum(count)}</td>
                              <td className="py-2.5 pl-3 w-[100px]">
                                <div className="flex items-center gap-2">
                                  <ProgressBar pct={pct} tone="sky" />
                                  <span className="text-[10px] text-slate-500 shrink-0">{pct}%</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </section>

          {/* ── Claude API detail + Activity feed ──────────────────── */}
          <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">

            {/* Claude / Anthropic detail */}
            <Panel title="Claude API Usage" subtitle="Token consumption by model" delay="350ms">
              {!svc.anthropic?.ok ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
                  <Bot size={24} className="text-slate-700" />
                  <p className="text-sm text-slate-600">
                    {svc.anthropic?.reason === 'api_not_available'
                      ? 'Usage API not available via API key'
                      : (svc.anthropic?.reason || 'ANTHROPIC_API_KEY not configured')}
                  </p>
                  <a
                    href="https://console.anthropic.com/settings/usage"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[12px] text-amber-400 hover:text-amber-300 mt-1"
                  >
                    <ExternalLink size={11} /> View in Anthropic Console
                  </a>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Total Tokens</p>
                      <p className="text-xl font-bold text-slate-100 mt-1">{fmtNum(svc.anthropic?.totalTokens)}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">input + output</p>
                    </div>
                    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider">Est. Cost</p>
                      <p className="text-xl font-bold text-amber-300 mt-1">{fmtCost(svc.anthropic?.estimatedCost)}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">based on Sonnet pricing</p>
                    </div>
                  </div>
                  {Object.keys(svc.anthropic?.byModel || {}).length > 0 && (
                    <div className="space-y-2 mt-2">
                      <p className="text-[11px] text-slate-500 uppercase tracking-wider">By Model</p>
                      {Object.entries(svc.anthropic.byModel).map(([model, data]) => (
                        <div key={model} className="flex items-center justify-between text-[12px]">
                          <span className="text-slate-400 truncate font-mono text-[11px]">{model}</span>
                          <span className="text-slate-300 shrink-0 ml-2">
                            {fmtNum(data.inputTokens + data.outputTokens)} tokens
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Panel>

            {/* Vercel deployments */}
            <Panel title="Vercel Deployments" subtitle="Recent deploys across all projects" delay="400ms">
              {!svc.vercel?.ok ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
                  <Server size={24} className="text-slate-700" />
                  <p className="text-sm text-slate-400">
                    {svc.vercel?.data?.setupNote || svc.vercel?.reason || 'VERCEL_TOKEN not configured'}
                  </p>
                  <a
                    href={svc.vercel?.data?.setupUrl || 'https://vercel.com/account/tokens'}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/30 text-blue-300 hover:text-blue-200 rounded-lg px-3 py-1.5 text-[12px] transition-colors"
                  >
                    <ExternalLink size={11} /> Create token from correct Vercel account
                  </a>
                </div>
              ) : (
                <div className="space-y-0">
                  {/* Project chips */}
                  {svc.vercel.projects && svc.vercel.projects.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3 pb-3 border-b border-slate-800">
                      {svc.vercel.projects.map((p) => (
                        <Badge key={p.id} tone="sky">{p.name}{p.framework ? ` · ${p.framework}` : ''}</Badge>
                      ))}
                    </div>
                  )}
                  {/* Deploy table */}
                  {(svc.vercel.recentDeploys || []).length === 0 ? (
                    <div className="py-6 text-center text-slate-600 text-sm">No recent deployments</div>
                  ) : (
                    <div className="divide-y divide-slate-800/60">
                      {(svc.vercel.recentDeploys || []).slice(0, 6).map((dep) => (
                        <div key={dep.id} className="flex items-center gap-3 py-2.5">
                          <StatusDot tone={dep.state === 'READY' ? 'emerald' : dep.state === 'ERROR' ? 'rose' : 'amber'} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] text-slate-300 truncate font-medium">{dep.name}</p>
                            {dep.source && <p className="text-[10px] text-slate-600 truncate font-mono">{dep.source}</p>}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge tone={dep.state === 'READY' ? 'emerald' : dep.state === 'ERROR' ? 'rose' : 'amber'}>
                              {dep.state || 'unknown'}
                            </Badge>
                            <span className="text-[11px] text-slate-600">{dep.createdAt ? fmtRelative(dep.createdAt) : '—'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Email queue summary */}
                  {svc.emailQueue?.total > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between text-[12px]">
                      <span className="flex items-center gap-2 text-slate-400">
                        <Mail size={11} className="text-cyan-400" />
                        Email queue ({fmtMonthLabel(selectedMonth)})
                      </span>
                      <span className="text-slate-300">
                        <span className="text-emerald-400">{svc.emailQueue.sent}</span> sent · <span className="text-rose-400">{svc.emailQueue.failed}</span> failed
                      </span>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          </section>

        </div>

        {/* ── Service Detail Drawer ───────────────────────────── */}
        {detailService && (
          <ServiceDetailDrawer
            serviceKey={detailService}
            svc={svc}
            timeline={timeline}
            onClose={() => setDetailService(null)}
            fmtNum={fmtNum}
            fmtCost={fmtCost}
            fmtRelative={fmtRelative}
            SERVICE_COLORS={SERVICE_COLORS}
            TONE_CLASSES={TONE_CLASSES}
          />
        )}
      </PageGuard>
    </V2Layout>
  );
}

// ── Service table row ─────────────────────────────────────────────────

function ServiceRow({ icon, name, ok, notAvailable, volume, cost, pct, sparkData, color, paid, link, onClick }) {
  const tone = paid ? 'amber' : pct != null ? pctTone(pct) : 'sky';
  return (
    <tr
      className={`border-b border-slate-800/40 transition-colors ${onClick ? 'cursor-pointer hover:bg-slate-800/50' : 'hover:bg-slate-900/30'}`}
      onClick={onClick}
    >
      <td className="py-2.5 pr-3">
        <span className="flex items-center gap-2 text-slate-300">
          <span style={{ color }}>{icon}</span>
          {name}
          {!ok && !notAvailable && (
            name === 'GitHub Copilot'
              ? <span className="text-[10px] text-slate-500">(no subscription)</span>
              : <span className="text-[10px] text-rose-400">(error)</span>
          )}
          {notAvailable && (
            link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="text-[10px] text-amber-400 hover:underline flex items-center gap-0.5">
                console <ExternalLink size={9} />
              </a>
            ) : (
              <span className="text-[10px] text-amber-400">see console</span>
            )
          )}
        </span>
      </td>
      <td className="py-2.5 px-2 text-right text-slate-400 font-mono text-[11px] whitespace-nowrap">
        {volume}
      </td>
      <td className="py-2.5 px-2 text-right font-mono whitespace-nowrap">
        <span className={paid ? 'text-amber-300' : 'text-emerald-400'}>{cost}</span>
      </td>
      <td className="py-2.5 pl-3 w-[100px]">
        {pct != null ? (
          <div className="flex items-center gap-2">
            <ProgressBar pct={pct} tone={pctTone(pct)} />
            <span className="text-[10px] text-slate-500 shrink-0">{pct}%</span>
          </div>
        ) : paid ? (
          <Badge tone="amber">paid</Badge>
        ) : (
          <Badge tone="emerald">free</Badge>
        )}
      </td>
      <td className="py-2.5 pl-2 w-[60px]">
        {sparkData && sparkData.length > 1 ? (
          <div className="h-7 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkData}>
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke={color}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <span className="text-slate-700 text-[11px]">—</span>
        )}
      </td>
      {onClick && (
        <td className="py-2.5 pl-1 w-4">
          <ChevronRight size={12} className="text-slate-600 group-hover:text-slate-400" />
        </td>
      )}
    </tr>
  );
}

// ── Runway row ────────────────────────────────────────────────────────

function RunwayRow({ label, used, limit, unit }) {
  const pct = Math.min(Math.round((used / limit) * 100), 100);
  const tone = pctTone(pct);
  const daysRemaining = used > 0
    ? Math.round((limit - used) / (used / 30))
    : Infinity;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-slate-400">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-slate-500 font-mono text-[11px]">
            {fmtNum(used)} / {fmtNum(limit)} {unit}
          </span>
          <Badge tone={tone}>
            {pct < 1 ? '<1%' : `${pct}%`}
          </Badge>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <ProgressBar pct={pct} tone={tone} />
        </div>
        <span className="text-[10px] text-slate-600 shrink-0 w-12 text-right">
          {daysRemaining === Infinity || daysRemaining > 9999 ? '∞' : `${daysRemaining}d`}
        </span>
      </div>
    </div>
  );
}

// ── Service Detail Drawer ─────────────────────────────────────────────

const DRAWER_META = {
  cloudFunctions: { label: 'Cloud Functions',  icon: Zap,       color: '#8b5cf6' },
  resend:         { label: 'Resend Email',      icon: Mail,      color: '#06b6d4' },
  anthropic:      { label: 'Claude / Anthropic',icon: Bot,       color: '#f59e0b' },
  vercel:         { label: 'Vercel',            icon: Server,    color: '#3b82f6' },
  github:         { label: 'GitHub Copilot',    icon: GitBranch, color: '#10b981' },
  domains:        { label: 'Domains & SSL',     icon: Globe,     color: '#f43f5e' },
};

function ServiceDetailDrawer({ serviceKey, svc, timeline, onClose, fmtNum, fmtCost, fmtRelative, SERVICE_COLORS, TONE_CLASSES }) {
  const meta = DRAWER_META[serviceKey] || {};
  const Icon = meta.icon || Activity;
  const data = svc[serviceKey] || {};

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  function Stat({ label, value, sub, accent }) {
    return (
      <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</p>
        <p className={`text-xl font-bold mt-1 ${accent || 'text-slate-100'}`}>{value}</p>
        {sub && <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p>}
      </div>
    );
  }

  function Section({ title, children }) {
    return (
      <div>
        <p className="text-[11px] text-slate-500 uppercase tracking-wider mb-2">{title}</p>
        {children}
      </div>
    );
  }

  function renderContent() {
    // ── Cloud Functions ──
    if (serviceKey === 'cloudFunctions') {
      const byFn = data.byFunction || {};
      const hasFns = Object.keys(byFn).length > 0;
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Invocations MTD" value={fmtNum(data.invocations || 0)} sub={`${data.invPct || 0}% of 2M free`} />
            <Stat label="GB-seconds" value={(data.gbSeconds || 0).toFixed(2)} sub={`${data.gbsPct || 0}% of 400K free`} />
          </div>
          <Section title="Per-function breakdown">
            {!hasFns ? (
              <div className="rounded-xl border border-slate-800 p-4 text-center">
                <p className="text-slate-500 text-sm">Per-function data needs <code className="text-violet-300">roles/monitoring.viewer</code></p>
                <a href="https://console.cloud.google.com/iam-admin/iam" target="_blank" rel="noopener noreferrer"
                   className="flex items-center justify-center gap-1 text-[12px] text-violet-400 hover:text-violet-300 mt-2">
                  <ExternalLink size={11} /> Open GCP IAM Console
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(byFn).sort(([,a],[,b]) => (b.count||b)-(a.count||a)).map(([fn, d]) => {
                  const count = typeof d === 'object' ? d.count : d;
                  const pct = Math.round((count / (data.invocations || 1)) * 100);
                  return (
                    <div key={fn} className="flex items-center gap-3">
                      <span className="text-[11px] text-slate-300 font-mono truncate flex-1">{fn}</span>
                      <span className="text-[11px] text-slate-400 shrink-0">{fmtNum(count)}</span>
                      <div className="w-20 h-1.5 rounded-full bg-slate-800 overflow-hidden shrink-0">
                        <div className="h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] text-slate-600 w-6 text-right shrink-0">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
          <Section title="Free tier status">
            <div className="space-y-2 text-[12px]">
              {[
                { label: 'Invocations', used: data.invocations || 0, limit: 2_000_000, unit: 'calls' },
                { label: 'GB-seconds', used: data.gbSeconds || 0, limit: 400_000, unit: 'GB-s' },
              ].map(({ label, used, limit, unit }) => {
                const pct = Math.min(Math.round((used / limit) * 100), 100);
                const tone = pct > 80 ? 'rose' : pct > 50 ? 'amber' : 'emerald';
                const color = TONE_CLASSES[tone]?.bar;
                return (
                  <div key={label} className="space-y-1">
                    <div className="flex justify-between text-slate-400">
                      <span>{label}</span>
                      <span className="font-mono text-slate-300">{fmtNum(used)} / {fmtNum(limit)} {unit}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        </>
      );
    }

    // ── Resend Email ──
    if (serviceKey === 'resend') {
      const byTemplate = data.byTemplate || {};
      const byStatus = data.byStatus || {};
      const templateData = Object.entries(byTemplate).sort(([,a],[,b]) => b-a);
      return (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Total Sent" value={fmtNum(data.total || 0)} />
            <Stat label="Delivered" value={fmtNum(data.delivered || 0)} accent="text-emerald-300" />
            <Stat label="Delivery Rate" value={`${data.deliveryRate ?? 100}%`} accent={data.deliveryRate >= 95 ? 'text-emerald-300' : 'text-amber-300'} />
          </div>
          {data.bounced > 0 && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-[12px] text-amber-200">
              ⚠ {data.bounced} bounce{data.bounced !== 1 ? 's' : ''} — consider cleaning your list
            </div>
          )}
          <Section title="By template">
            {templateData.length === 0 ? <p className="text-slate-600 text-sm">No template data</p> : (
              <div className="space-y-2">
                {templateData.map(([tpl, count]) => {
                  const pct = Math.round((count / (data.total || 1)) * 100);
                  return (
                    <div key={tpl} className="flex items-center gap-3">
                      <span className="text-[11px] text-slate-300 truncate flex-1">{tpl.replace(/_/g, ' ')}</span>
                      <span className="text-[11px] text-slate-400 shrink-0 font-mono">{count}</span>
                      <div className="w-20 h-1.5 rounded-full bg-slate-800 overflow-hidden shrink-0">
                        <div className="h-full rounded-full bg-cyan-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
          <Section title="Delivery status">
            <div className="space-y-1.5 text-[12px]">
              {Object.entries(byStatus).map(([status, count]) => (
                <div key={status} className="flex justify-between py-1 border-b border-slate-800/50">
                  <span className="text-slate-400 capitalize">{status.replace(/_/g, ' ')}</span>
                  <span className="text-slate-200 font-mono">{count}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Free tier">
            <div className="space-y-1">
              <div className="flex justify-between text-[12px] text-slate-400">
                <span>Monthly sends</span>
                <span className="font-mono">{fmtNum(data.total || 0)} / {fmtNum(data.freeLimit || 3000)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full rounded-full bg-cyan-500" style={{ width: `${data.usagePct || 0}%` }} />
              </div>
              <p className="text-[10px] text-slate-600">{data.usagePct || 0}% used · {3000 - (data.total || 0)} sends remaining</p>
            </div>
          </Section>
        </>
      );
    }

    // ── Claude / Anthropic ──
    if (serviceKey === 'anthropic') {
      if (!data.ok && data.reason === 'usage_api_unavailable') {
        return (
          <>
            <div className={`rounded-xl border p-4 space-y-2 ${data.keyValid ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${data.keyValid ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <p className="text-slate-300 text-sm font-medium">
                  {data.keyValid ? 'API Key Valid — Usage API Requires Enterprise' : 'API Key Invalid'}
                </p>
              </div>
              <p className="text-slate-500 text-[12px] leading-5">{data.setupNote}</p>
            </div>
            {data.keyValid && (
              <Section title="View usage manually">
                <p className="text-[12px] text-slate-500 mb-2">
                  Your key works for Claude API inference. Usage reporting (token counts, cost by model) is only available via Enterprise Admin keys.
                </p>
                <a href="https://console.anthropic.com/settings/usage" target="_blank" rel="noopener noreferrer"
                   className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/25 text-amber-300 hover:text-amber-200 rounded-lg px-3 py-2 text-[12px] w-fit transition-colors">
                  <ExternalLink size={11} /> Open Usage Dashboard
                </a>
              </Section>
            )}
          </>
        );
      }
      if (!data.ok && data.reason === 'workspace_id_required') {
        return (
          <>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
              <p className="text-slate-300 text-sm font-medium">One more step — Workspace ID needed</p>
              <p className="text-slate-500 text-[12px] leading-5">
                Your key is an organization-level key. It works, but needs your Workspace ID to scope requests.
              </p>
            </div>
            <Section title="Get your Workspace ID">
              <ol className="space-y-2 text-[12px] text-slate-400 list-none">
                {(data.steps || [
                  'Go to console.anthropic.com',
                  'Click your workspace name in the top-left dropdown',
                  'Copy the workspace ID from the URL — looks like wrkspc_...',
                  'Add to .env: ANTHROPIC_WORKSPACE_ID=wrkspc_...',
                  'Restart the dev server',
                ]).map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-amber-400 font-mono shrink-0">{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1.5 mt-3 bg-amber-500/10 border border-amber-500/25 text-amber-300 hover:text-amber-200 rounded-lg px-3 py-2 text-[12px] w-fit transition-colors">
                <ExternalLink size={11} /> Open Anthropic Console
              </a>
            </Section>
          </>
        );
      }
      if (!data.ok && data.reason === 'admin_key_required') {
        return (
          <>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-center space-y-3">
              <Key size={28} className="text-amber-400 mx-auto" />
              <p className="text-slate-300 text-sm font-medium">Admin API Key Required</p>
              <p className="text-slate-500 text-[12px] leading-5">
                Regular inference keys cannot read usage data. Create a key via a Service Account with Admin role in the Anthropic Console.
              </p>
            </div>
            <Section title="How to get usage data">
              <ol className="space-y-2 text-[12px] text-slate-400 list-none">
                {[
                  'Go to console.anthropic.com/settings/keys',
                  'Create a Service Account with Admin role',
                  'Create an API key under that service account',
                  'Add to .env as ANTHROPIC_ADMIN_KEY=sk-ant-...',
                  'Also add ANTHROPIC_WORKSPACE_ID=wrkspc_... from the console URL',
                ].map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-amber-400 font-mono shrink-0">{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1.5 mt-3 bg-amber-500/10 border border-amber-500/25 text-amber-300 hover:text-amber-200 rounded-lg px-3 py-2 text-[12px] w-fit transition-colors">
                <ExternalLink size={11} /> Open Anthropic Console
              </a>
            </Section>
          </>
        );
      }
      // Has admin key — show real data
      const byModel = data.byModel || {};
      const dailyData = (data.daily || []).slice(-14).map(d => ({ date: d.date?.slice(5), v: d.input + d.output }));
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Input Tokens" value={fmtNum(data.inputTokens || 0)} sub="MTD" />
            <Stat label="Output Tokens" value={fmtNum(data.outputTokens || 0)} sub="MTD" />
            <Stat label="Total Tokens" value={fmtNum(data.totalTokens || 0)} />
            <Stat label="Est. Cost" value={fmtCost(data.estimatedCost)} accent="text-amber-300" />
          </div>
          {data.cacheReadTokens > 0 && (
            <Section title="Cache usage">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Cache Reads" value={fmtNum(data.cacheReadTokens)} sub="cheap at $0.30/MTok" />
                <Stat label="Cache Writes" value={fmtNum(data.cacheWriteTokens)} sub="$3.75/MTok" />
              </div>
            </Section>
          )}
          {dailyData.length > 1 && (
            <Section title="Daily token usage (last 14 days)">
              <div className="h-24">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dailyData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="grad-claude" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 9 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#090d16', borderColor: '#334155', fontSize: '11px', borderRadius: '8px' }} />
                    <Area type="monotone" dataKey="v" name="Tokens" stroke="#f59e0b" fill="url(#grad-claude)" strokeWidth={1.5} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Section>
          )}
          <Section title="By model">
            <div className="space-y-2">
              {Object.entries(byModel).sort(([,a],[,b]) => (b.inputTokens+b.outputTokens)-(a.inputTokens+a.outputTokens)).map(([model, d]) => (
                <div key={model} className="rounded-xl border border-slate-800 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-slate-300 font-mono">{model}</span>
                    <span className="text-[11px] text-amber-300 font-mono">{fmtCost(d.estimatedCost)}</span>
                  </div>
                  <div className="flex gap-4 text-[10px] text-slate-500">
                    <span>In: {fmtNum(d.inputTokens)}</span>
                    <span>Out: {fmtNum(d.outputTokens)}</span>
                    <span>Req: {fmtNum(d.requests)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </>
      );
    }

    // ── Vercel ──
    if (serviceKey === 'vercel') {
      const deploys = data.recentDeploys || [];
      const projects = data.projects || [];
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Projects" value={projects.length} />
            <Stat label="Recent Deploys" value={deploys.length} />
          </div>
          <Section title="Projects">
            {projects.length === 0 ? <p className="text-slate-600 text-sm">No projects found</p> : (
              <div className="space-y-2">
                {projects.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 border-b border-slate-800/50">
                    <span className="text-[12px] text-slate-300">{p.name}</span>
                    {p.framework && <span className="text-[10px] text-slate-600 bg-slate-800 px-2 py-0.5 rounded">{p.framework}</span>}
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section title="Recent deployments">
            <div className="space-y-0 divide-y divide-slate-800/50">
              {deploys.slice(0, 8).map(dep => (
                <div key={dep.id} className="flex items-center gap-3 py-2.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dep.state === 'READY' ? 'bg-emerald-400' : dep.state === 'ERROR' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] text-slate-300 font-medium truncate">{dep.name}</p>
                    {dep.source && <p className="text-[10px] text-slate-600 font-mono truncate">{dep.source}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] text-slate-500">{dep.createdAt ? fmtRelative(dep.createdAt) : '—'}</p>
                    <p className={`text-[10px] font-medium ${dep.state === 'READY' ? 'text-emerald-400' : 'text-amber-400'}`}>{dep.state}</p>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </>
      );
    }

    // ── GitHub Copilot ──
    if (serviceKey === 'github') {
      if (!data.ok) {
        return (
          <>
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
              <p className="text-slate-300 text-sm font-medium">{data.setupNote || 'Copilot subscription not found on icannDevTeam'}</p>
              <p className="text-slate-500 text-[12px] leading-5">
                Your Copilot subscription ($100+/mo) is likely on your personal GitHub account. Create a new token from that account:
              </p>
            </div>
            <Section title="Fix: create token from personal account">
              <ol className="space-y-2 text-[12px] text-slate-400">
                {[
                  'Go to github.com → sign in as your personal account',
                  'Settings → Developer settings → Personal access tokens → Tokens (classic)',
                  'Generate new token (classic)',
                  'Scopes: manage_billing:copilot + read:org',
                  'Add to .env as GITHUB_COPILOT_TOKEN=ghp_...',
                ].map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-emerald-400 font-mono shrink-0">{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1.5 mt-3 bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 hover:text-emerald-200 rounded-lg px-3 py-2 text-[12px] w-fit transition-colors">
                <ExternalLink size={11} /> Create Classic PAT on Personal Account
              </a>
            </Section>
          </>
        );
      }
      const monthly = parseFloat(data.estimatedCost || 0);
      return (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Active Seats" value={data.activeSeats ?? 0} sub={`of ${data.totalSeats ?? 0} total`} />
            <Stat label="Monthly Cost" value={fmtCost(monthly)} accent="text-amber-300" sub={`$${data.perSeatPrice ?? 19}/seat`} />
            <Stat label="Annual Est." value={fmtCost(monthly * 12)} sub="projected" />
          </div>
          <Section title="Plan details">
            <div className="space-y-2 text-[12px]">
              {[
                ['Plan type', data.planType || 'Business'],
                ['Organization', data.org || data.source || '—'],
                ['Per seat price', `$${data.perSeatPrice ?? 19}/month`],
                ['Annual projection', fmtCost(monthly * 12)],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between py-1.5 border-b border-slate-800/50">
                  <span className="text-slate-500">{label}</span>
                  <span className="text-slate-200">{value}</span>
                </div>
              ))}
            </div>
          </Section>
        </>
      );
    }

    // ── Domains ──
    if (serviceKey === 'domains') {
      const domains = data.domains || [];
      return (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Monitored" value={domains.length} sub="SSL certificates" />
            <Stat label="Healthy" value={domains.filter(d => d.ok && d.daysRemaining > 30).length} accent="text-emerald-300" />
          </div>
          <Section title="Certificate details">
            {domains.length === 0 ? (
              <div className="text-slate-600 text-sm text-center py-4">
                Set <code className="text-slate-400">MONITOR_DOMAINS=domain1.com,domain2.com</code>
              </div>
            ) : (
              <div className="space-y-3">
                {domains.map(d => {
                  const tone = d.daysRemaining > 90 ? 'emerald' : d.daysRemaining > 30 ? 'amber' : 'rose';
                  return (
                    <div key={d.domain} className={`rounded-xl border p-4 ${TONE_CLASSES[tone]?.badge?.replace('text-', 'border-').split(' ')[0]} bg-slate-900/50`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[13px] text-slate-200 font-mono font-medium">{d.domain}</span>
                        <span className={`text-[11px] font-semibold ${TONE_CLASSES[tone]?.badge?.split(' ')[1]}`}>
                          {d.ok ? `${d.daysRemaining}d remaining` : 'Error'}
                        </span>
                      </div>
                      {d.validTo && (
                        <p className="text-[10px] text-slate-500">
                          Expires: {new Date(d.validTo).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                        </p>
                      )}
                      {!d.ok && <p className="text-[11px] text-rose-400 mt-1">{d.reason}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
          <Section title="Renewal reminders">
            <div className="text-[12px] text-slate-500 space-y-1">
              <p>🟢 &gt;90 days — No action needed</p>
              <p>🟡 30–90 days — Schedule renewal</p>
              <p>🔴 &lt;30 days — Renew immediately</p>
            </div>
          </Section>
        </>
      );
    }

    return <p className="text-slate-600 text-sm">No detail available</p>;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-40"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md z-50 flex flex-col bg-slate-950 border-l border-slate-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0"
             style={{ borderLeftColor: meta.color, borderLeftWidth: '3px' }}>
          <div className="flex items-center gap-3">
            <Icon size={18} style={{ color: meta.color }} />
            <div>
              <h2 className="text-[14px] font-semibold text-slate-100">{meta.label}</h2>
              <p className="text-[11px] text-slate-500">Detailed breakdown</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-slate-800">
            <X size={16} />
          </button>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {renderContent()}
        </div>
        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 shrink-0 flex justify-between items-center">
          <span className="text-[10px] text-slate-600">Press Esc to close</span>
          <button onClick={onClose} className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors">
            Close ×
          </button>
        </div>
      </div>
    </>
  );
}
