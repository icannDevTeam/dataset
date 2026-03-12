import Head from 'next/head';
import { useState, useEffect, useCallback, useMemo } from 'react';
import V2Layout from '../../components/v2/V2Layout';

function getWIBDate() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

const PERIOD_OPTIONS = [
  { label: 'Last 7 Days', days: 7 },
  { label: 'Last 14 Days', days: 14 },
  { label: 'Last 30 Days', days: 30 },
  { label: 'Last 60 Days', days: 60 },
];

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/attendance/analytics?days=${days}&to=${getWIBDate()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  // Derived computations
  const trendDaysWithData = useMemo(() => {
    if (!data) return [];
    return data.dailyTrends.filter((d) => d.total > 0);
  }, [data]);

  const onTimeRate = useMemo(() => {
    if (!data || data.summary.totalScans === 0) return 0;
    return ((data.summary.totalPresent / data.summary.totalScans) * 100).toFixed(1);
  }, [data]);

  const lateRate = useMemo(() => {
    if (!data || data.summary.totalScans === 0) return 0;
    return ((data.summary.totalLate / data.summary.totalScans) * 100).toFixed(1);
  }, [data]);

  // For the SVG chart
  const chartPoints = useMemo(() => {
    if (!data || !data.dailyTrends.length) return { attendance: '', attendanceArea: '', yMax: 0 };
    const trends = data.dailyTrends;
    const maxTotal = Math.max(...trends.map((d) => d.total), 1);
    const yMax = Math.ceil(maxTotal / 10) * 10 || 10;
    const n = trends.length;

    const toX = (i) => (i / Math.max(n - 1, 1)) * 100;
    const toY = (val) => 100 - (val / yMax) * 100;

    const attendancePts = trends.map((d, i) => `${toX(i)},${toY(d.total)}`);
    const latePts = trends.map((d, i) => `${toX(i)},${toY(d.late)}`);

    return {
      attendance: attendancePts.join(' L'),
      attendanceArea: attendancePts.join(' L') + ` L100,100 L0,100 Z`,
      late: latePts.join(' L'),
      lateArea: latePts.join(' L') + ` L100,100 L0,100 Z`,
      yMax,
      labels: trends.filter((_, i) => i % Math.max(1, Math.floor(n / 6)) === 0 || i === n - 1),
      labelIndices: trends.reduce((acc, d, i) => {
        if (i % Math.max(1, Math.floor(n / 6)) === 0 || i === n - 1) acc.push(i);
        return acc;
      }, []),
    };
  }, [data]);

  // Hourly chart
  const hourlyMax = useMemo(() => {
    if (!data) return 1;
    return Math.max(...data.hourlyDistribution.map((h) => h.count), 1);
  }, [data]);

  // Peak hour
  const peakHour = useMemo(() => {
    if (!data) return null;
    return data.hourlyDistribution.reduce((max, h) => (h.count > max.count ? h : max), { hour: 0, count: 0 });
  }, [data]);

  // Top classes (max 6)
  const topClasses = useMemo(() => {
    if (!data) return [];
    return data.classRates.filter((c) => c.homeroom !== 'Unknown').slice(0, 6);
  }, [data]);

  // Late pattern analysis (classes with highest late %)
  const latePatterns = useMemo(() => {
    if (!data) return [];
    return data.classRates
      .filter((c) => c.homeroom !== 'Unknown' && c.total >= 3)
      .map((c) => ({ ...c, lateRate: parseFloat(((c.late / Math.max(c.total, 1)) * 100).toFixed(1)) }))
      .sort((a, b) => b.lateRate - a.lateRate)
      .slice(0, 5);
  }, [data]);

  // Active day streak
  const streak = useMemo(() => {
    if (!trendDaysWithData.length) return 0;
    let count = 0;
    for (let i = trendDaysWithData.length - 1; i >= 0; i--) {
      if (trendDaysWithData[i].total > 0) count++;
      else break;
    }
    return count;
  }, [trendDaysWithData]);

  const classColors = ['brand', 'indigo', 'emerald', 'amber', 'violet', 'slate'];

  // Accuracy / confidence
  const avgAccuracy = useMemo(() => {
    if (!data || !data.accuracy || data.accuracy.avg === null) return null;
    return data.accuracy.avg;
  }, [data]);

  const lowFlags = useMemo(() => {
    if (!data) return [];
    return data.lowAccuracyFlags || [];
  }, [data]);

  const confidenceDist = useMemo(() => {
    if (!data || !data.accuracy) return null;
    return data.accuracy.distribution;
  }, [data]);

  const confidenceDistMax = useMemo(() => {
    if (!confidenceDist) return 1;
    return Math.max(confidenceDist.below50, confidenceDist['50to80'], confidenceDist['80to95'], confidenceDist.above95, 1);
  }, [confidenceDist]);

  const exportCSV = useCallback(() => {
    if (!data) return;
    const rows = [['Date', 'Total', 'On-Time', 'Late']];
    data.dailyTrends.forEach((d) => rows.push([d.date, d.total, d.present, d.late]));
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-analytics-${data.range.from}-to-${data.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  return (
    <V2Layout>
      <Head><title>Analytics — BINUSFace v2</title></Head>

      <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6 max-w-[1600px] mx-auto">

        {/* Hero Section & Filters */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <i className="ph ph-chart-line-up text-brand-500"></i>
              <span className="text-sm font-medium text-brand-500 tracking-wide uppercase">Historical Data &amp; Insights</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">Attendance Analytics</h1>
            <p className="text-slate-400 mt-2 max-w-2xl">
              {data ? (
                <>Analyzing <span className="text-white font-medium">{data.summary.daysWithData}</span> days of data from <span className="text-white font-medium">{fmtDate(data.range.from)}</span> to <span className="text-white font-medium">{fmtDate(data.range.to)}</span></>
              ) : 'Loading attendance data...'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Period selector */}
            <div className="flex items-center p-1 rounded-lg bg-slate-900/80 border border-slate-800 backdrop-blur-md">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  onClick={() => setDays(opt.days)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    days === opt.days
                      ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              onClick={exportCSV}
              disabled={!data}
              className="flex items-center gap-2 px-4 py-2.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] hover:shadow-[0_0_25px_rgba(6,182,212,0.5)] active:scale-95 group disabled:opacity-50"
            >
              <i className="ph ph-download-simple text-lg group-hover:-translate-y-0.5 transition-transform"></i>
              Export Report
              <span className="border-l border-slate-950/20 pl-2 ml-1 text-xs opacity-80 font-normal">CSV</span>
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
            <i className="ph ph-warning-circle text-red-400 text-xl"></i>
            <p className="text-sm text-red-300">Failed to load analytics: {error}</p>
            <button onClick={fetchAnalytics} className="ml-auto text-sm text-red-400 hover:text-white underline">Retry</button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="glass-panel rounded-2xl p-5 animate-pulse">
                <div className="h-4 bg-slate-800 rounded w-2/3 mb-4"></div>
                <div className="h-8 bg-slate-800 rounded w-1/2 mb-2"></div>
                <div className="h-3 bg-slate-800 rounded w-1/3"></div>
              </div>
            ))}
          </div>
        )}

        {/* Key Metrics Grid */}
        {data && (
          <div className={`grid grid-cols-1 sm:grid-cols-2 ${avgAccuracy !== null ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} gap-4 mt-8`}>
            {/* Avg Attendance Rate */}
            <div className="glass-panel rounded-2xl p-5 border-l-2 border-l-brand-500 animate-fade-in-up">
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-400">Avg. Attendance Rate</p>
                <div className="w-8 h-8 rounded-full bg-brand-500/10 flex items-center justify-center">
                  <i className="ph ph-users text-brand-400 text-lg"></i>
                </div>
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-white">{data.summary.avgAttendanceRate}%</h3>
              </div>
              <p className="text-xs text-slate-500 mt-2">across {data.summary.daysWithData} active days</p>
            </div>

            {/* Total Scans */}
            <div className="glass-panel rounded-2xl p-5 border-l-2 border-l-indigo-500 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-400">Total Scans</p>
                <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center">
                  <i className="ph ph-scan text-indigo-400 text-lg"></i>
                </div>
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-white">{fmtNum(data.summary.totalScans)}</h3>
              </div>
              <p className="text-xs text-slate-500 mt-2">~{data.summary.avgDaily} per day avg</p>
            </div>

            {/* On-Time Rate */}
            <div className="glass-panel rounded-2xl p-5 border-l-2 border-l-emerald-500 animate-fade-in-up" style={{ animationDelay: '200ms' }}>
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-400">On-Time Rate</p>
                <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <i className="ph ph-check-circle text-emerald-400 text-lg"></i>
                </div>
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-white">{onTimeRate}%</h3>
                <span className="text-xs text-slate-400">{data.summary.totalPresent} students</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">arrived before 07:30 WIB</p>
            </div>

            {/* Late Rate */}
            <div className="glass-panel rounded-2xl p-5 border-l-2 border-l-amber-500 animate-fade-in-up" style={{ animationDelay: '300ms' }}>
              <div className="flex justify-between items-start mb-2">
                <p className="text-sm font-medium text-slate-400">Late Rate</p>
                <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center">
                  <i className="ph ph-clock-countdown text-amber-400 text-lg"></i>
                </div>
              </div>
              <div className="flex items-baseline gap-2">
                <h3 className="text-3xl font-bold text-white">{lateRate}%</h3>
                <span className="text-xs text-slate-400">{data.summary.totalLate} students</span>
              </div>
              <p className="text-xs text-slate-500 mt-2">arrived after 07:30 WIB</p>
            </div>

            {/* Avg Accuracy */}
            {avgAccuracy !== null && (
              <div className={`glass-panel rounded-2xl p-5 border-l-2 animate-fade-in-up ${
                avgAccuracy < 50 ? 'border-l-red-500' : avgAccuracy < 80 ? 'border-l-amber-500' : 'border-l-violet-500'
              }`} style={{ animationDelay: '400ms' }}>
                <div className="flex justify-between items-start mb-2">
                  <p className="text-sm font-medium text-slate-400">Avg. Accuracy</p>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    avgAccuracy < 50 ? 'bg-red-500/10' : avgAccuracy < 80 ? 'bg-amber-500/10' : 'bg-violet-500/10'
                  }`}>
                    <i className={`ph ph-crosshair text-lg ${
                      avgAccuracy < 50 ? 'text-red-400' : avgAccuracy < 80 ? 'text-amber-400' : 'text-violet-400'
                    }`}></i>
                  </div>
                </div>
                <div className="flex items-baseline gap-2">
                  <h3 className={`text-3xl font-bold ${avgAccuracy < 50 ? 'text-red-400' : 'text-white'}`}>{avgAccuracy}%</h3>
                  {lowFlags.length > 0 && (
                    <span className="flex items-center text-xs font-medium text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                      <i className="ph ph-warning mr-1"></i> {lowFlags.length} flagged
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-2">{data.accuracy.scansWithConfidence} scans with confidence data</p>
              </div>
            )}
          </div>
        )}

        {/* Main Chart: Attendance Trends */}
        {data && (
          <div className="glass-panel rounded-2xl border border-slate-800 p-6">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center mb-8 gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Attendance Trends</h2>
                <p className="text-sm text-slate-400">Daily total scans vs. late arrivals over the selected period.</p>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-brand-500 shadow-[0_0_8px_rgba(6,182,212,0.8)]"></div>
                  <span className="text-slate-300">Total Present</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                  <span className="text-slate-400">Late Arrivals</span>
                </div>
              </div>
            </div>

            <div className="w-full h-[300px] relative">
              {/* Y-Axis Labels */}
              <div className="absolute left-0 top-0 bottom-8 w-10 flex flex-col justify-between text-xs text-slate-500 z-10">
                <span>{chartPoints.yMax}</span>
                <span>{Math.round(chartPoints.yMax * 0.75)}</span>
                <span>{Math.round(chartPoints.yMax * 0.5)}</span>
                <span>{Math.round(chartPoints.yMax * 0.25)}</span>
                <span>0</span>
              </div>
              {/* Grid lines */}
              <div className="absolute left-10 right-0 top-0 bottom-8 flex flex-col justify-between z-0">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className={`w-full h-px ${i === 4 ? 'bg-slate-800' : 'bg-slate-800/50'}`}></div>
                ))}
              </div>

              {/* SVG Chart */}
              <div className="absolute left-10 right-0 top-2 bottom-8 z-10">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full overflow-visible">
                  <defs>
                    <linearGradient id="brandGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="amberGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.2" />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
                    </linearGradient>
                  </defs>

                  {chartPoints.attendance && (
                    <>
                      {/* Late area + line */}
                      <path d={`M${chartPoints.lateArea}`} fill="url(#amberGradient)" />
                      <path d={`M${chartPoints.late}`} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="3,3" />

                      {/* Attendance area + line */}
                      <path d={`M${chartPoints.attendanceArea}`} fill="url(#brandGradient)" />
                      <path d={`M${chartPoints.attendance}`} fill="none" stroke="#06b6d4" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 4px rgba(6,182,212,0.5))' }} />
                    </>
                  )}
                </svg>
              </div>

              {/* X-Axis Labels */}
              <div className="absolute left-10 right-0 bottom-0 h-8 flex justify-between items-end text-xs text-slate-500 z-10">
                {chartPoints.labels && chartPoints.labels.map((d, i) => (
                  <span key={i}>{fmtDate(d.date)}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Secondary Charts Grid */}
        {data && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Hourly Distribution */}
            <div className="glass-panel rounded-2xl border border-slate-800 p-6 flex flex-col">
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-white">Hourly Arrival Distribution</h2>
                <p className="text-sm text-slate-400">
                  When students scan in across all {data.summary.daysWithData} days.
                  {peakHour && peakHour.count > 0 && (
                    <> Peak hour: <span className="text-brand-400 font-medium">{String(peakHour.hour).padStart(2, '0')}:00</span></>
                  )}
                </p>
              </div>

              <div className="flex-1 flex items-end gap-1 mt-4 pb-6 border-b border-slate-800 relative h-64">
                {/* Y-Axis */}
                <div className="absolute left-0 top-0 bottom-6 w-8 flex flex-col justify-between text-[10px] text-slate-500">
                  <span>{fmtNum(hourlyMax)}</span>
                  <span>{fmtNum(Math.round(hourlyMax / 2))}</span>
                  <span>0</span>
                </div>
                {/* Bars */}
                <div className="flex-1 flex items-end justify-between ml-10 h-full w-full gap-[2px]">
                  {data.hourlyDistribution
                    .filter((h) => h.hour >= 5 && h.hour <= 18)
                    .map((h) => (
                      <div key={h.hour} className="flex flex-col items-center group relative h-full justify-end flex-1">
                        <div
                          className={`w-full max-w-[32px] rounded-t-sm transition-colors ${
                            h.hour < 7 || h.hour > 8
                              ? 'bg-slate-800 group-hover:bg-slate-700'
                              : h.count === peakHour?.count
                                ? 'bg-brand-400 shadow-[0_0_15px_rgba(34,211,238,0.3)]'
                                : 'bg-brand-500/60 group-hover:bg-brand-500/80'
                          }`}
                          style={{ height: `${(h.count / hourlyMax) * 100}%`, minHeight: h.count > 0 ? '2px' : '0' }}
                        ></div>
                        {/* Tooltip */}
                        <div className="absolute -top-8 bg-slate-800 text-white text-xs px-2 py-1 rounded border border-slate-700 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                          {h.count} scans
                        </div>
                        <span className={`absolute -bottom-6 text-[10px] font-mono ${h.hour === 7 ? 'text-brand-400 font-medium' : 'text-slate-400'}`}>
                          {String(h.hour).padStart(2, '0')}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>

            {/* Top Classes by Rate */}
            <div className="glass-panel rounded-2xl border border-slate-800 p-6 flex flex-col">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-white">Top Classes by On-Time Rate</h2>
                  <p className="text-sm text-slate-400">Highest punctuality across the period.</p>
                </div>
                <span className="text-xs text-slate-500">{data.classRates.length} classes tracked</span>
              </div>

              <div className="flex-1 space-y-5 flex flex-col justify-center">
                {topClasses.length === 0 && (
                  <p className="text-sm text-slate-500 text-center py-8">No class data available for this period.</p>
                )}
                {topClasses.map((cls, i) => {
                  const colorBase = classColors[i] || 'slate';
                  return (
                    <div key={cls.homeroom}>
                      <div className="flex justify-between items-center mb-1.5">
                        <span className={`text-sm font-medium ${i === 0 ? 'text-white' : i < 3 ? 'text-slate-200' : 'text-slate-400'} flex items-center gap-2`}>
                          <span className={`w-2 h-2 rounded-full bg-${colorBase}-500`}></span>
                          Class {cls.homeroom}
                        </span>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-slate-500">{cls.total} scans</span>
                          <span className={`text-sm font-mono ${i === 0 ? 'text-brand-400' : 'text-slate-300'}`}>{cls.rate}%</span>
                        </div>
                      </div>
                      <div className="w-full bg-slate-800/80 rounded-full h-2 overflow-hidden border border-slate-800">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ${
                            i === 0
                              ? 'bg-gradient-to-r from-brand-600 to-brand-400'
                              : i === 1
                                ? 'bg-indigo-500'
                                : i === 2
                                  ? 'bg-emerald-500'
                                  : i === 3
                                    ? 'bg-amber-500 opacity-80'
                                    : 'bg-slate-600'
                          }`}
                          style={{ width: `${cls.rate}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Low Accuracy Flags */}
        {data && lowFlags.length > 0 && (
          <div className="glass-panel rounded-2xl border border-red-500/30 overflow-hidden shadow-lg shadow-red-500/5 mt-6">
            <div className="px-6 py-5 border-b border-red-500/20 bg-red-500/5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-white">Low Accuracy Flags</h2>
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                </div>
                <p className="text-sm text-slate-400 mt-1">Scans with confidence below 50% — may indicate spoofing, poor lighting, or misidentification.</p>
              </div>
              <span className="text-sm font-medium text-red-400 bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20">
                {lowFlags.length} flagged scan{lowFlags.length !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Student</th>
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Class</th>
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Date</th>
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Time</th>
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Confidence</th>
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {lowFlags.map((flag, i) => {
                    const pct = (flag.confidence * 100).toFixed(1);
                    const isCritical = flag.confidence < 0.25;
                    return (
                      <tr key={`${flag.employeeNo}-${flag.date}-${i}`} className={`border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors ${isCritical ? 'bg-red-500/5' : ''}`}>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${isCritical ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                              {flag.name?.charAt(0) || '?'}
                            </div>
                            <div>
                              <p className="font-medium text-white">{flag.name}</p>
                              {flag.employeeNo && <p className="text-xs text-slate-500">{flag.employeeNo}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-slate-300">{flag.homeroom || '—'}</td>
                        <td className="px-6 py-4 text-slate-400">{flag.date}</td>
                        <td className="px-6 py-4 text-slate-400">{flag.timestamp.split(' ')[1] || flag.timestamp}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <div className="w-16 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                              <div className={`h-full rounded-full ${isCritical ? 'bg-red-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }}></div>
                            </div>
                            <span className={`font-mono text-sm ${isCritical ? 'text-red-400' : 'text-amber-400'}`}>{pct}%</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded text-xs font-medium border ${
                            isCritical
                              ? 'bg-red-500/20 text-red-400 border-red-500/30'
                              : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                          }`}>
                            {isCritical ? 'Critical' : 'Warning'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Confidence Distribution */}
        {data && confidenceDist && data.accuracy.scansWithConfidence > 0 && (
          <div className="glass-panel rounded-2xl border border-slate-800 p-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">Confidence Score Distribution</h2>
              <p className="text-sm text-slate-400">Breakdown of AI recognition certainty across {data.accuracy.scansWithConfidence} scans with confidence data. Range: {data.accuracy.min}% — {data.accuracy.max}%</p>
            </div>
            <div className="flex items-end gap-4 h-48">
              {[
                { label: '< 50%', count: confidenceDist.below50, color: 'bg-red-500', hoverColor: 'group-hover:bg-red-400', flagged: true },
                { label: '50–80%', count: confidenceDist['50to80'], color: 'bg-amber-500/60', hoverColor: 'group-hover:bg-amber-500/80' },
                { label: '80–95%', count: confidenceDist['80to95'], color: 'bg-brand-500/60', hoverColor: 'group-hover:bg-brand-500/80' },
                { label: '> 95%', count: confidenceDist.above95, color: 'bg-emerald-400/80', hoverColor: 'group-hover:bg-emerald-400' },
              ].map((bucket) => (
                <div key={bucket.label} className="flex-1 flex flex-col items-center group relative h-full justify-end">
                  <div className="absolute -top-8 bg-slate-800 text-white text-xs px-2 py-1 rounded border border-slate-700 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                    {bucket.count} scan{bucket.count !== 1 ? 's' : ''}
                  </div>
                  <div
                    className={`w-full max-w-[80px] rounded-t-md transition-colors ${bucket.color} ${bucket.hoverColor} ${bucket.flagged && bucket.count > 0 ? 'ring-2 ring-red-500/40' : ''}`}
                    style={{ height: `${(bucket.count / confidenceDistMax) * 100}%`, minHeight: bucket.count > 0 ? '4px' : '0' }}
                  ></div>
                  <div className="mt-3 text-center">
                    <p className={`text-xs font-mono ${bucket.flagged && bucket.count > 0 ? 'text-red-400 font-medium' : 'text-slate-400'}`}>{bucket.label}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{bucket.count}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Late Pattern Analysis */}
        {data && latePatterns.length > 0 && (
          <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden shadow-lg shadow-black/20 mt-6">
            <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-white">Late Arrival Patterns</h2>
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                  </span>
                </div>
                <p className="text-sm text-slate-400 mt-1">Classes with the highest late arrival percentage — may need attention.</p>
              </div>
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <i className="ph ph-info text-slate-500"></i>
                Based on {data.summary.daysWithData} days of data
              </div>
            </div>

            <div className="p-0">
              {latePatterns.map((cls, i) => (
                <div
                  key={cls.homeroom}
                  className={`p-5 ${i < latePatterns.length - 1 ? 'border-b border-slate-800/50' : ''} hover:bg-slate-800/20 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4`}
                >
                  <div className="flex items-start gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 mt-1 sm:mt-0 ${
                      cls.lateRate > 50
                        ? 'bg-red-500/10 border border-red-500/20'
                        : cls.lateRate > 30
                          ? 'bg-amber-500/10 border border-amber-500/20'
                          : 'bg-slate-800 border border-slate-700'
                    }`}>
                      <i className={`ph ph-clock-countdown text-xl ${
                        cls.lateRate > 50 ? 'text-red-400' : cls.lateRate > 30 ? 'text-amber-400' : 'text-slate-400'
                      }`}></i>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-white">Class {cls.homeroom}</h4>
                      <p className="text-xs text-slate-400 mt-1">
                        {cls.late} late out of {cls.total} total scans ({cls.lateRate}% late rate)
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-[10px]">
                        <span className={`px-2 py-0.5 rounded border ${
                          cls.lateRate > 50
                            ? 'bg-red-500/20 text-red-400 border-red-500/30'
                            : cls.lateRate > 30
                              ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                              : 'bg-slate-800 text-slate-300 border-slate-700'
                        }`}>
                          {cls.lateRate > 50 ? 'High Priority' : cls.lateRate > 30 ? 'Moderate' : 'Low'}
                        </span>
                        <span className="text-slate-500">{cls.present} on-time</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 self-start sm:self-center">
                    {/* Mini bar showing late proportion */}
                    <div className="w-24 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${cls.lateRate > 50 ? 'bg-red-500' : cls.lateRate > 30 ? 'bg-amber-500' : 'bg-slate-600'}`}
                        style={{ width: `${cls.lateRate}%` }}
                      ></div>
                    </div>
                    <span className="text-sm font-mono text-slate-300 w-14 text-right">{cls.lateRate}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Summary Strip */}
        {data && (
          <div className="glass-panel rounded-2xl border border-slate-800 p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <div className="flex items-center gap-2 text-slate-400">
                <i className="ph ph-calendar-check text-brand-500"></i>
                <span><span className="text-white font-medium">{data.summary.daysWithData}</span> days with data</span>
              </div>
              <div className="flex items-center gap-2 text-slate-400">
                <i className="ph ph-student text-indigo-400"></i>
                <span><span className="text-white font-medium">{data.summary.enrolledStudents}</span> enrolled students</span>
              </div>
              <div className="flex items-center gap-2 text-slate-400">
                <i className="ph ph-fire text-amber-400"></i>
                <span><span className="text-white font-medium">{streak}</span> day active streak</span>
              </div>
            </div>
            <button
              onClick={fetchAnalytics}
              disabled={loading}
              className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            >
              <i className={`ph ph-arrows-clockwise ${loading ? 'animate-spin' : ''}`}></i>
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t border-slate-800/50 bg-slate-950/80 backdrop-blur-sm mt-8 py-6">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <i className="ph ph-shield-check text-brand-500 text-lg"></i>
            <span>BINUSFace Attendance System v2</span>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <span className="text-slate-600">BINUS School Serpong</span>
          </div>
        </div>
      </footer>
    </V2Layout>
  );
}
