import Head from 'next/head';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import V2Layout from '../../components/v2/V2Layout';

function getWIBDate(offset = 0) {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  if (offset) now.setUTCDate(now.getUTCDate() + offset);
  return now.toISOString().slice(0, 10);
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtShortDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const QUICK_RANGES = [
  { label: 'Today', get: () => ({ from: getWIBDate(), to: getWIBDate() }) },
  { label: 'This Week', get: () => {
    const now = new Date(Date.now() + 7 * 3600 * 1000);
    const day = now.getUTCDay();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - (day === 0 ? 6 : day - 1));
    return { from: monday.toISOString().slice(0, 10), to: getWIBDate() };
  }},
  { label: 'Last 7 Days', get: () => ({ from: getWIBDate(-6), to: getWIBDate() }) },
  { label: 'Last 14 Days', get: () => ({ from: getWIBDate(-13), to: getWIBDate() }) },
  { label: 'Last 30 Days', get: () => ({ from: getWIBDate(-29), to: getWIBDate() }) },
];

export default function ReportsPage() {
  const [fromDate, setFromDate] = useState(getWIBDate(-6));
  const [toDate, setToDate] = useState(getWIBDate());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [filterSource, setFilterSource] = useState('');

  // View mode
  const [activeTab, setActiveTab] = useState('overview');
  const [sortField, setSortField] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [expandedClass, setExpandedClass] = useState(null);
  const [selectedTerminal, setSelectedTerminal] = useState(null);

  // Parse model code from terminal name like "Basement 1 Terminal (DS-K1T341AMF)"
  const parseModel = (name) => {
    if (!name) return '';
    const m = name.match(/\(([^)]+)\)/);
    return m ? m[1] : '';
  };
  const stripModel = (name) => (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const fmtTs = (ts) => {
    if (!ts) return '—';
    return ts.includes(' ') ? ts.split(' ')[1].slice(0, 5) : ts.slice(0, 16).replace('T', ' ');
  };
  const fmtFullTs = (ts) => {
    if (!ts) return '—';
    return ts.replace('T', ' ').slice(0, 19);
  };
  const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const printRef = useRef(null);

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (filterClass) params.set('class', filterClass);
      if (filterGrade) params.set('grade', filterGrade);
      if (filterSource) params.set('source', filterSource);
      const res = await fetch(`/api/attendance/report?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, filterClass, filterGrade, filterSource]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  // Sorted student records
  const sortedStudents = useMemo(() => {
    if (!data) return [];
    const list = [...data.studentRecords];
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'homeroom': cmp = a.homeroom.localeCompare(b.homeroom) || a.name.localeCompare(b.name); break;
        case 'attendance': cmp = a.attendanceRate - b.attendanceRate; break;
        case 'ontime': cmp = a.onTimeRate - b.onTimeRate; break;
        case 'present': cmp = a.daysPresent - b.daysPresent; break;
        case 'late': cmp = a.daysLate - b.daysLate; break;
        case 'absent': cmp = a.daysAbsent - b.daysAbsent; break;
        default: cmp = a.name.localeCompare(b.name);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [data, sortField, sortDir]);

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <i className="ph ph-caret-up-down text-slate-600 ml-1"></i>;
    return <i className={`ph ${sortDir === 'asc' ? 'ph-caret-up' : 'ph-caret-down'} text-brand-400 ml-1`}></i>;
  };

  // CSV export
  const exportCSV = useCallback(() => {
    if (!data) return;
    const rows = [['Name', 'Student ID', 'Class', 'Grade', 'Days Present', 'Days Late', 'Days Absent', 'Attendance Rate', 'On-Time Rate']];
    data.studentRecords.forEach((s) =>
      rows.push([s.name, s.employeeNo, s.homeroom, s.grade, s.daysPresent, s.daysLate, s.daysAbsent, s.attendanceRate + '%', s.onTimeRate + '%'])
    );
    rows.push([]);
    rows.push(['--- Class Summary ---']);
    rows.push(['Class', 'Grade', 'Enrolled', 'Students Tracked', 'Total Scans', 'Present', 'Late', 'Attendance Rate', 'On-Time Rate']);
    data.classSummary.forEach((c) =>
      rows.push([c.homeroom, c.grade, c.enrolled, c.studentsTracked, c.totalScans, c.totalPresent, c.totalLate, c.attendanceRate + '%', c.onTimeRate + '%'])
    );
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-report-${fromDate}-to-${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, fromDate, toDate]);

  const handlePrint = () => window.print();

  const rateColor = (rate) => {
    if (rate >= 90) return 'text-emerald-400';
    if (rate >= 75) return 'text-brand-400';
    if (rate >= 50) return 'text-amber-400';
    return 'text-red-400';
  };

  const rateBg = (rate) => {
    if (rate >= 90) return 'bg-emerald-500';
    if (rate >= 75) return 'bg-brand-500';
    if (rate >= 50) return 'bg-amber-500';
    return 'bg-red-500';
  };

  const tabs = [
    { id: 'overview', label: 'Overview', icon: 'ph-squares-four' },
    { id: 'class', label: 'By Class', icon: 'ph-chalkboard-teacher' },
    { id: 'students', label: 'Students', icon: 'ph-users' },
    { id: 'daily', label: 'Daily', icon: 'ph-calendar-dots' },
    { id: 'terminals', label: 'Terminals', icon: 'ph-fingerprint' },
  ];

  return (
    <V2Layout>
      <Head><title>Reports — BINUS Attendance</title></Head>

      <div ref={printRef} className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6 max-w-[1600px] mx-auto">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <i className="ph ph-file-text text-brand-500"></i>
              <span className="text-sm font-medium text-brand-500 tracking-wide uppercase">Attendance Reports</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white print-title">Attendance Report</h1>
            <p className="text-slate-400 mt-2 max-w-2xl">
              {data ? (
                <>Generate detailed reports from <span className="text-white font-medium">{fmtDate(data.range.from)}</span> to <span className="text-white font-medium">{fmtDate(data.range.to)}</span> — <span className="text-white font-medium">{data.range.daysWithData}</span> days of data</>
              ) : 'Configure date range and filters below.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 no-print">
            <button
              onClick={exportCSV}
              disabled={!data}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-all border border-slate-700 disabled:opacity-50"
            >
              <i className="ph ph-file-csv text-lg"></i>
              Export CSV
            </button>
            <button
              onClick={handlePrint}
              disabled={!data}
              className="flex items-center gap-2 px-4 py-2.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] hover:shadow-[0_0_25px_rgba(6,182,212,0.5)] active:scale-95 disabled:opacity-50"
            >
              <i className="ph ph-printer text-lg"></i>
              Print Report
            </button>
          </div>
        </div>

        {/* Date Range & Filters */}
        <div className="glass-panel rounded-2xl border border-slate-800 p-5 no-print">
          <div className="flex flex-col lg:flex-row gap-4">
            {/* Date range */}
            <div className="flex-1">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">Date Range</label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="bg-slate-900/80 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                />
                <span className="text-slate-500">→</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="bg-slate-900/80 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                />
              </div>
              {/* Quick ranges */}
              <div className="flex flex-wrap gap-2 mt-3">
                {QUICK_RANGES.map((qr) => (
                  <button
                    key={qr.label}
                    onClick={() => { const r = qr.get(); setFromDate(r.from); setToDate(r.to); }}
                    className="px-3 py-1 text-xs font-medium rounded-md bg-slate-800/80 text-slate-400 hover:text-white hover:bg-slate-700 border border-slate-700/50 transition-colors"
                  >
                    {qr.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-3">
              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">Class</label>
                <select
                  value={filterClass}
                  onChange={(e) => setFilterClass(e.target.value)}
                  className="bg-slate-900/80 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:border-brand-500 outline-none min-w-[120px]"
                >
                  <option value="">All Classes</option>
                  {data?.filters?.classes?.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">Grade</label>
                <select
                  value={filterGrade}
                  onChange={(e) => setFilterGrade(e.target.value)}
                  className="bg-slate-900/80 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:border-brand-500 outline-none min-w-[120px]"
                >
                  <option value="">All Grades</option>
                  {data?.filters?.grades?.map((g) => <option key={g} value={g}>Grade {g}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">Terminal</label>
                <select
                  value={filterSource}
                  onChange={(e) => setFilterSource(e.target.value)}
                  className="bg-slate-900/80 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:border-brand-500 outline-none min-w-[120px]"
                >
                  <option value="">All Terminals</option>
                  {data?.filters?.sources?.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
            <i className="ph ph-warning-circle text-red-400 text-xl"></i>
            <p className="text-sm text-red-300">Failed to load report: {error}</p>
            <button onClick={fetchReport} className="ml-auto text-sm text-red-400 hover:text-white underline">Retry</button>
          </div>
        )}

        {/* Loading */}
        {loading && !data && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="glass-panel rounded-2xl p-5 animate-pulse">
                <div className="h-4 bg-slate-800 rounded w-2/3 mb-4"></div>
                <div className="h-8 bg-slate-800 rounded w-1/2 mb-2"></div>
                <div className="h-3 bg-slate-800 rounded w-1/3"></div>
              </div>
            ))}
          </div>
        )}

        {/* Summary Cards */}
        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 print-summary">
              <div className="glass-panel rounded-2xl p-4 border-l-2 border-l-brand-500 animate-fade-in-up">
                <p className="text-xs font-medium text-slate-400 mb-1">School Days</p>
                <h3 className="text-2xl font-bold text-white">{data.range.daysWithData}</h3>
                <p className="text-[10px] text-slate-500 mt-1">of {data.range.schoolDays} weekdays</p>
              </div>
              <div className="glass-panel rounded-2xl p-4 border-l-2 border-l-indigo-500 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                <p className="text-xs font-medium text-slate-400 mb-1">Students</p>
                <h3 className="text-2xl font-bold text-white">{data.summary.totalStudents}</h3>
                <p className="text-[10px] text-slate-500 mt-1">of {data.summary.enrolledStudents} enrolled</p>
              </div>
              <div className="glass-panel rounded-2xl p-4 border-l-2 border-l-violet-500 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                <p className="text-xs font-medium text-slate-400 mb-1">Total Scans</p>
                <h3 className="text-2xl font-bold text-white">{data.summary.totalScans}</h3>
                <p className="text-[10px] text-slate-500 mt-1">~{data.summary.avgDailyAttendance}/day</p>
              </div>
              <div className="glass-panel rounded-2xl p-4 border-l-2 border-l-emerald-500 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
                <p className="text-xs font-medium text-slate-400 mb-1">On-Time</p>
                <h3 className="text-2xl font-bold text-emerald-400">{data.summary.presentRate}%</h3>
                <p className="text-[10px] text-slate-500 mt-1">{data.summary.totalPresent} scans</p>
              </div>
              <div className="glass-panel rounded-2xl p-4 border-l-2 border-l-amber-500 animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                <p className="text-xs font-medium text-slate-400 mb-1">Late</p>
                <h3 className="text-2xl font-bold text-amber-400">{data.summary.lateRate}%</h3>
                <p className="text-[10px] text-slate-500 mt-1">{data.summary.totalLate} scans</p>
              </div>
              <div className="glass-panel rounded-2xl p-4 border-l-2 border-l-slate-500 animate-fade-in-up" style={{ animationDelay: '250ms' }}>
                <p className="text-xs font-medium text-slate-400 mb-1">Classes</p>
                <h3 className="text-2xl font-bold text-white">{data.classSummary.length}</h3>
                <p className="text-[10px] text-slate-500 mt-1">tracked</p>
              </div>
            </div>

            {/* Tab Navigation */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900/80 border border-slate-800 backdrop-blur-md w-fit no-print">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                  }`}
                >
                  <i className={`ph ${tab.icon}`}></i>
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ═══ OVERVIEW TAB ═══ */}
            {activeTab === 'overview' && (
              <div className="space-y-6">
                {/* Terminal/Source breakdown */}
                {data.sourceSummary.length > 0 && (
                  <div className="glass-panel rounded-2xl border border-slate-800 p-6">
                    <div className="flex items-center justify-between mb-5">
                      <div>
                        <h2 className="text-lg font-semibold text-white">Terminal Breakdown</h2>
                        <p className="text-xs text-slate-400 mt-0.5">Scan activity per terminal for the selected period</p>
                      </div>
                      <span className="text-xs text-slate-500">{data.sourceSummary.length} terminal{data.sourceSummary.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {data.sourceSummary.map((src) => {
                        const isMobile = src.source.toLowerCase().includes('mobile');
                        const icon = isMobile ? 'ph-device-mobile' : 'ph-fingerprint';
                        const accentColor = isMobile ? 'text-violet-400' : 'text-brand-400';
                        const borderColor = isMobile ? 'border-violet-500/30' : 'border-brand-500/30';
                        const bgColor = isMobile ? 'bg-violet-500/10' : 'bg-brand-500/10';
                        return (
                          <div key={src.source} className={`rounded-xl p-4 border ${borderColor} ${bgColor}`}>
                            {/* Header */}
                            <div className="flex items-center gap-2 mb-3">
                              <div className={`w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0`}>
                                <i className={`ph ${icon} ${accentColor} text-base`}></i>
                              </div>
                              <span className="text-sm font-semibold text-white leading-tight">{src.source}</span>
                            </div>

                            {/* Big scan count */}
                            <div className="mb-3">
                              <span className="text-3xl font-bold text-white">{src.totalScans}</span>
                              <span className="text-xs text-slate-400 ml-1.5">total scans</span>
                            </div>

                            {/* Present / Late pills */}
                            <div className="flex items-center gap-2 mb-3">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium">
                                <i className="ph-fill ph-check-circle text-xs"></i>
                                {src.present ?? 0} on-time
                              </span>
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-medium">
                                <i className="ph-fill ph-clock text-xs"></i>
                                {src.late ?? 0} late
                              </span>
                            </div>

                            {/* Progress bar: on-time vs late */}
                            {src.totalScans > 0 && (
                              <div className="h-1.5 bg-slate-700/60 rounded-full overflow-hidden mb-3">
                                <div
                                  className="h-full bg-emerald-500 rounded-full"
                                  style={{ width: `${src.presentRate}%` }}
                                ></div>
                              </div>
                            )}

                            {/* Footer stats */}
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <span><span className="text-white font-medium">{src.uniqueStudents}</span> unique students</span>
                              <span className="text-emerald-400 font-medium">{src.presentRate ?? 0}% on-time</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Quick class comparison */}
                <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                  <div className="px-6 py-5 border-b border-slate-800">
                    <h2 className="text-lg font-semibold text-white">Class Comparison</h2>
                    <p className="text-sm text-slate-400 mt-1">Attendance rate across all classes in the selected period.</p>
                  </div>
                  <div className="p-6">
                    {data.classSummary.length === 0 ? (
                      <p className="text-sm text-slate-500 text-center py-8">No class data available.</p>
                    ) : (
                      <div className="space-y-4">
                        {data.classSummary.map((cls) => (
                          <div key={cls.homeroom} className="flex items-center gap-4">
                            <span className="text-sm font-medium text-white w-16 flex-shrink-0">{cls.homeroom}</span>
                            <div className="flex-1 h-6 bg-slate-800/80 rounded-full overflow-hidden relative">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${rateBg(cls.attendanceRate)} opacity-80`}
                                style={{ width: `${Math.min(cls.attendanceRate, 100)}%` }}
                              ></div>
                              {/* On-time portion overlay */}
                              <div
                                className="absolute top-0 left-0 h-full rounded-full bg-emerald-500 opacity-60"
                                style={{ width: `${Math.min(cls.onTimeRate * cls.attendanceRate / 100, 100)}%` }}
                              ></div>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              <span className={`text-sm font-mono font-medium ${rateColor(cls.attendanceRate)} w-14 text-right`}>
                                {cls.attendanceRate}%
                              </span>
                              <span className="text-xs text-slate-500 w-16 text-right">{cls.totalScans} scans</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-6 mt-6 pt-4 border-t border-slate-800 text-xs text-slate-500">
                      <div className="flex items-center gap-2"><div className="w-3 h-2 rounded bg-emerald-500 opacity-60"></div> On-Time</div>
                      <div className="flex items-center gap-2"><div className="w-3 h-2 rounded bg-amber-500 opacity-80"></div> Late</div>
                    </div>
                  </div>
                </div>

                {/* Daily mini trend */}
                <div className="glass-panel rounded-2xl border border-slate-800 p-6">
                  <h2 className="text-lg font-semibold text-white mb-4">Daily Attendance</h2>
                  <div className="overflow-x-auto">
                    <div className="flex items-end gap-1 h-32 min-w-[400px]">
                      {data.dailyBreakdown.map((day) => {
                        const max = Math.max(...data.dailyBreakdown.map((d) => d.total), 1);
                        const height = (day.total / max) * 100;
                        const lateHeight = day.total > 0 ? (day.late / day.total) * height : 0;
                        const presentHeight = height - lateHeight;
                        return (
                          <div key={day.date} className="flex-1 flex flex-col items-center group relative justify-end h-full" title={`${day.date}: ${day.present} on-time, ${day.late} late`}>
                            <div className="absolute -top-8 bg-slate-800 text-white text-[10px] px-2 py-1 rounded border border-slate-700 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                              {fmtShortDate(day.date)}: {day.total} ({day.late} late)
                            </div>
                            <div className="w-full max-w-[24px] flex flex-col">
                              {presentHeight > 0 && (
                                <div className="bg-brand-500/70 rounded-t-sm" style={{ height: `${presentHeight}%`, minHeight: '1px' }}></div>
                              )}
                              {lateHeight > 0 && (
                                <div className="bg-amber-500/70" style={{ height: `${lateHeight}%`, minHeight: '1px' }}></div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ═══ CLASS TAB ═══ */}
            {activeTab === 'class' && (
              <div className="space-y-4 print-section">
                {data.classSummary.map((cls) => {
                  const isExpanded = expandedClass === cls.homeroom;
                  const classStudents = sortedStudents.filter((s) => s.homeroom === cls.homeroom);
                  return (
                    <div key={cls.homeroom} className="glass-panel rounded-2xl border border-slate-800 overflow-hidden print-break-inside-avoid">
                      <button
                        onClick={() => setExpandedClass(isExpanded ? null : cls.homeroom)}
                        className="w-full px-6 py-5 flex items-center justify-between hover:bg-slate-800/20 transition-colors"
                      >
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${rateBg(cls.attendanceRate)} bg-opacity-20`}>
                            <span className="text-lg font-bold text-white">{cls.homeroom}</span>
                          </div>
                          <div className="text-left">
                            <h3 className="text-base font-semibold text-white">Class {cls.homeroom}</h3>
                            <p className="text-xs text-slate-400">
                              {cls.studentsTracked} students · {cls.totalScans} total scans · {cls.totalPresent} on-time · {cls.totalLate} late
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="text-right hidden sm:block">
                            <span className={`text-xl font-bold ${rateColor(cls.attendanceRate)}`}>{cls.attendanceRate}%</span>
                            <p className="text-[10px] text-slate-500">attendance</p>
                          </div>
                          <div className="text-right hidden sm:block">
                            <span className={`text-xl font-bold ${rateColor(cls.onTimeRate)}`}>{cls.onTimeRate}%</span>
                            <p className="text-[10px] text-slate-500">on-time</p>
                          </div>
                          <i className={`ph ${isExpanded ? 'ph-caret-up' : 'ph-caret-down'} text-slate-400 text-xl no-print`}></i>
                        </div>
                      </button>

                      {(isExpanded || false) && (
                        <div className="border-t border-slate-800">
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-slate-800">
                                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Student</th>
                                  <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Present</th>
                                  <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Late</th>
                                  <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Absent</th>
                                  <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Attendance</th>
                                  <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">On-Time</th>
                                </tr>
                              </thead>
                              <tbody>
                                {classStudents.map((s) => (
                                  <tr key={s.employeeNo} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                                    <td className="px-6 py-3">
                                      <div className="flex items-center gap-3">
                                        <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300">
                                          {s.name?.charAt(0) || '?'}
                                        </div>
                                        <div>
                                          <p className="font-medium text-white text-sm">{s.name}</p>
                                          <p className="text-[10px] text-slate-500">{s.employeeNo}</p>
                                        </div>
                                      </div>
                                    </td>
                                    <td className="text-center px-4 py-3 text-emerald-400 font-medium">{s.daysPresent}</td>
                                    <td className="text-center px-4 py-3 text-amber-400 font-medium">{s.daysLate}</td>
                                    <td className="text-center px-4 py-3 text-red-400 font-medium">{s.daysAbsent}</td>
                                    <td className="text-center px-4 py-3">
                                      <span className={`font-mono font-medium ${rateColor(s.attendanceRate)}`}>{s.attendanceRate}%</span>
                                    </td>
                                    <td className="text-center px-4 py-3">
                                      <span className={`font-mono font-medium ${rateColor(s.onTimeRate)}`}>{s.onTimeRate}%</span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ═══ STUDENTS TAB ═══ */}
            {activeTab === 'students' && (
              <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden print-section">
                <div className="px-6 py-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-white">All Students</h2>
                    <p className="text-sm text-slate-400">{sortedStudents.length} students · {data.range.from} to {data.range.to}</p>
                  </div>
                  <span className="text-xs text-slate-500 no-print">Click column headers to sort</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th onClick={() => toggleSort('name')} className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-300 select-none">
                          Student <SortIcon field="name" />
                        </th>
                        <th onClick={() => toggleSort('homeroom')} className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-300 select-none">
                          Class <SortIcon field="homeroom" />
                        </th>
                        <th onClick={() => toggleSort('present')} className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-300 select-none">
                          Present <SortIcon field="present" />
                        </th>
                        <th onClick={() => toggleSort('late')} className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-300 select-none">
                          Late <SortIcon field="late" />
                        </th>
                        <th onClick={() => toggleSort('absent')} className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-300 select-none">
                          Absent <SortIcon field="absent" />
                        </th>
                        <th onClick={() => toggleSort('attendance')} className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-300 select-none">
                          Attendance <SortIcon field="attendance" />
                        </th>
                        <th onClick={() => toggleSort('ontime')} className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider cursor-pointer hover:text-slate-300 select-none">
                          On-Time <SortIcon field="ontime" />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedStudents.map((s, i) => (
                        <tr key={s.employeeNo || i} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                s.attendanceRate >= 90 ? 'bg-emerald-500/20 text-emerald-400' :
                                s.attendanceRate >= 75 ? 'bg-brand-500/20 text-brand-400' :
                                s.attendanceRate >= 50 ? 'bg-amber-500/20 text-amber-400' :
                                'bg-red-500/20 text-red-400'
                              }`}>
                                {s.name?.charAt(0) || '?'}
                              </div>
                              <div>
                                <p className="font-medium text-white">{s.name}</p>
                                <p className="text-[10px] text-slate-500">{s.employeeNo}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-300">{s.homeroom}</td>
                          <td className="text-center px-4 py-3 text-emerald-400 font-medium">{s.daysPresent}</td>
                          <td className="text-center px-4 py-3 text-amber-400 font-medium">{s.daysLate}</td>
                          <td className="text-center px-4 py-3 text-red-400 font-medium">{s.daysAbsent}</td>
                          <td className="text-center px-4 py-3">
                            <div className="flex items-center justify-center gap-2">
                              <div className="w-12 bg-slate-800 rounded-full h-1.5 overflow-hidden hidden sm:block">
                                <div className={`h-full rounded-full ${rateBg(s.attendanceRate)}`} style={{ width: `${s.attendanceRate}%` }}></div>
                              </div>
                              <span className={`font-mono font-medium ${rateColor(s.attendanceRate)}`}>{s.attendanceRate}%</span>
                            </div>
                          </td>
                          <td className="text-center px-4 py-3">
                            <span className={`font-mono font-medium ${rateColor(s.onTimeRate)}`}>{s.onTimeRate}%</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ═══ DAILY TAB ═══ */}
            {activeTab === 'daily' && (
              <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden print-section">
                <div className="px-6 py-5 border-b border-slate-800">
                  <h2 className="text-lg font-semibold text-white">Day-by-Day Breakdown</h2>
                  <p className="text-sm text-slate-400">Attendance summary for each day in the selected range.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Date</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Total</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">On-Time</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Late</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">On-Time %</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider w-48">Distribution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.dailyBreakdown.filter((d) => d.total > 0).map((day) => {
                        const onTimePct = day.total > 0 ? parseFloat(((day.present / day.total) * 100).toFixed(1)) : 0;
                        return (
                          <tr key={day.date} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                            <td className="px-6 py-3">
                              <span className="font-medium text-white">{fmtDate(day.date)}</span>
                            </td>
                            <td className="text-center px-4 py-3 text-white font-medium">{day.total}</td>
                            <td className="text-center px-4 py-3 text-emerald-400">{day.present}</td>
                            <td className="text-center px-4 py-3 text-amber-400">{day.late}</td>
                            <td className="text-center px-4 py-3">
                              <span className={`font-mono font-medium ${rateColor(onTimePct)}`}>{onTimePct}%</span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                <div className="flex-1 h-4 bg-slate-800 rounded-full overflow-hidden flex">
                                  <div className="bg-emerald-500/70 h-full" style={{ width: `${day.total > 0 ? (day.present / day.total) * 100 : 0}%` }}></div>
                                  <div className="bg-amber-500/70 h-full" style={{ width: `${day.total > 0 ? (day.late / day.total) * 100 : 0}%` }}></div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {data.dailyBreakdown.filter((d) => d.total > 0).length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-6 py-8 text-center text-slate-500">No attendance data in this date range.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ═══ TERMINALS TAB ═══ */}
            {activeTab === 'terminals' && (
              <div className="space-y-6">
                {data.sourceSummary.length === 0 ? (
                  <div className="glass-panel rounded-2xl border border-slate-800 p-12 text-center">
                    <i className="ph ph-fingerprint text-slate-600 text-4xl mb-3 block"></i>
                    <p className="text-slate-500">No terminal data available for this date range.</p>
                  </div>
                ) : (
                  <>
                    {/* Cards row */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {data.sourceSummary.map((src) => {
                        const isMobile = src.source.toLowerCase().includes('mobile');
                        const icon = isMobile ? 'ph-device-mobile' : 'ph-fingerprint';
                        const accentColor = isMobile ? 'text-violet-400' : 'text-brand-400';
                        const borderColor = isMobile ? 'border-violet-500/30' : 'border-brand-500/30';
                        const bgColor = isMobile ? 'bg-violet-500/10' : 'bg-brand-500/10';
                        return (
                          <div
                            key={src.source}
                            onClick={() => setSelectedTerminal(src)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTerminal(src); } }}
                            className={`rounded-xl p-5 border ${borderColor} ${bgColor} cursor-pointer transition-all hover:scale-[1.01] hover:border-opacity-80 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-500/40`}
                          >
                            <div className="flex items-center justify-between gap-2 mb-4">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
                                  <i className={`ph ${icon} ${accentColor} text-lg`}></i>
                                </div>
                                <span className="text-sm font-semibold text-white leading-tight">{src.source}</span>
                              </div>
                              <i className="ph ph-arrow-square-out text-slate-500 text-base"></i>
                            </div>
                            <div className="grid grid-cols-2 gap-3 mb-4">
                              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                                <div className="text-2xl font-bold text-white">{src.totalScans}</div>
                                <div className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-wide">Total Scans</div>
                              </div>
                              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                                <div className="text-2xl font-bold text-slate-300">{src.uniqueStudents}</div>
                                <div className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-wide">Students</div>
                              </div>
                              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                                <div className="text-2xl font-bold text-emerald-400">{src.present ?? 0}</div>
                                <div className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-wide">On-Time</div>
                              </div>
                              <div className="bg-slate-900/60 rounded-lg p-3 text-center">
                                <div className="text-2xl font-bold text-amber-400">{src.late ?? 0}</div>
                                <div className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-wide">Late</div>
                              </div>
                            </div>
                            {src.totalScans > 0 && (
                              <>
                                <div className="flex items-center justify-between text-xs mb-1">
                                  <span className="text-slate-400">On-Time Rate</span>
                                  <span className="text-emerald-400 font-semibold">{src.presentRate}%</span>
                                </div>
                                <div className="h-2 bg-slate-700/60 rounded-full overflow-hidden">
                                  <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${src.presentRate}%` }}></div>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Comparison table */}
                    <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                      <div className="px-6 py-5 border-b border-slate-800">
                        <h2 className="text-base font-semibold text-white">Terminal Comparison</h2>
                        <p className="text-xs text-slate-400 mt-0.5">Side-by-side breakdown across all terminals</p>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-800">
                              <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Terminal</th>
                              <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Total Scans</th>
                              <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Students</th>
                              <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">On-Time</th>
                              <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">Late</th>
                              <th className="text-center px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">On-Time Rate</th>
                              <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider w-40">Distribution</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.sourceSummary.map((src, i) => {
                              const isMobile = src.source.toLowerCase().includes('mobile');
                              return (
                                <tr
                                  key={src.source}
                                  onClick={() => setSelectedTerminal(src)}
                                  className={`border-b border-slate-800/50 hover:bg-slate-800/40 transition-colors cursor-pointer ${i % 2 === 0 ? '' : 'bg-slate-900/20'}`}
                                >
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-2">
                                      <i className={`ph ${isMobile ? 'ph-device-mobile text-violet-400' : 'ph-fingerprint text-brand-400'} text-base`}></i>
                                      <span className="font-medium text-white">{src.source}</span>
                                      <i className="ph ph-caret-right text-slate-500 text-xs ml-1"></i>
                                    </div>
                                  </td>
                                  <td className="text-center px-4 py-4 text-white font-semibold">{src.totalScans}</td>
                                  <td className="text-center px-4 py-4 text-slate-300">{src.uniqueStudents}</td>
                                  <td className="text-center px-4 py-4 text-emerald-400">{src.present ?? 0}</td>
                                  <td className="text-center px-4 py-4 text-amber-400">{src.late ?? 0}</td>
                                  <td className="text-center px-4 py-4">
                                    <span className={`font-mono font-medium ${rateColor(src.presentRate ?? 0)}`}>{src.presentRate ?? 0}%</span>
                                  </td>
                                  <td className="px-4 py-4">
                                    {src.totalScans > 0 && (
                                      <div className="h-4 bg-slate-800 rounded-full overflow-hidden flex">
                                        <div className="bg-emerald-500/70 h-full" style={{ width: `${src.presentRate}%` }}></div>
                                        <div className="bg-amber-500/70 h-full" style={{ width: `${src.lateRate}%` }}></div>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Print-only: full class reports */}
            <div className="hidden print-show print-section">
              <h2 className="text-xl font-bold mb-4" style={{ pageBreakBefore: 'always' }}>Detailed Class Reports</h2>
              {data.classSummary.map((cls) => {
                const classStudents = data.studentRecords.filter((s) => s.homeroom === cls.homeroom);
                return (
                  <div key={cls.homeroom} className="mb-8 print-break-inside-avoid">
                    <h3 className="text-lg font-semibold mb-2">Class {cls.homeroom} — {cls.studentsTracked} students — Attendance: {cls.attendanceRate}% — On-Time: {cls.onTimeRate}%</h3>
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr>
                          <th className="text-left py-2 px-3 border-b-2 border-gray-300">Student</th>
                          <th className="text-left py-2 px-3 border-b-2 border-gray-300">ID</th>
                          <th className="text-center py-2 px-3 border-b-2 border-gray-300">Present</th>
                          <th className="text-center py-2 px-3 border-b-2 border-gray-300">Late</th>
                          <th className="text-center py-2 px-3 border-b-2 border-gray-300">Absent</th>
                          <th className="text-center py-2 px-3 border-b-2 border-gray-300">Attendance</th>
                          <th className="text-center py-2 px-3 border-b-2 border-gray-300">On-Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {classStudents.map((s) => (
                          <tr key={s.employeeNo}>
                            <td className="py-1.5 px-3 border-b border-gray-200">{s.name}</td>
                            <td className="py-1.5 px-3 border-b border-gray-200 text-gray-500">{s.employeeNo}</td>
                            <td className="text-center py-1.5 px-3 border-b border-gray-200">{s.daysPresent}</td>
                            <td className="text-center py-1.5 px-3 border-b border-gray-200">{s.daysLate}</td>
                            <td className="text-center py-1.5 px-3 border-b border-gray-200">{s.daysAbsent}</td>
                            <td className="text-center py-1.5 px-3 border-b border-gray-200">{s.attendanceRate}%</td>
                            <td className="text-center py-1.5 px-3 border-b border-gray-200">{s.onTimeRate}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ═══ TERMINAL DETAIL MODAL ═══ */}
      {selectedTerminal && (() => {
        const t = selectedTerminal;
        const isMobile = t.source.toLowerCase().includes('mobile');
        const accent = isMobile ? 'violet' : 'brand';
        const accentText = isMobile ? 'text-violet-400' : 'text-brand-400';
        const accentBg = isMobile ? 'bg-violet-500/10' : 'bg-brand-500/10';
        const accentBorder = isMobile ? 'border-violet-500/30' : 'border-brand-500/30';
        const model = parseModel(t.source);
        const cleanName = stripModel(t.source);
        const maxHourly = Math.max(...Object.values(t.hourly || {}), 1);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto"
            onClick={() => setSelectedTerminal(null)}
          >
            <div
              className="relative w-full max-w-5xl my-8 glass-panel rounded-2xl border border-slate-700 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className={`px-6 py-5 border-b border-slate-800 ${accentBg} rounded-t-2xl`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center border ${accentBorder}`}>
                      <i className={`ph ${isMobile ? 'ph-device-mobile' : 'ph-fingerprint'} ${accentText} text-2xl`}></i>
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white">{cleanName || t.source}</h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {isMobile ? 'Mobile Attendance' : 'Hikvision Terminal'}
                        {model && <span className="ml-2 px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">{model}</span>}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedTerminal(null)}
                    className="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-400 hover:text-white"
                    aria-label="Close"
                  >
                    <i className="ph ph-x text-lg"></i>
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
                {/* Specs */}
                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                    <i className="ph ph-cpu mr-1.5"></i>Machine Specs
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">Type</div>
                      <div className="text-sm font-medium text-white mt-1">{isMobile ? 'Mobile (PWA)' : 'Hikvision'}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">Model</div>
                      <div className="text-sm font-mono text-white mt-1">{model || '—'}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">IP Address</div>
                      <div className="text-sm font-mono text-white mt-1">{t.deviceIp || '—'}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">Peak Hour</div>
                      <div className="text-sm font-medium text-white mt-1">{t.peakHour != null ? `${String(t.peakHour).padStart(2, '0')}:00` : '—'}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">First Scan</div>
                      <div className="text-sm font-medium text-white mt-1">{fmtFullTs(t.firstScan)}</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">Last Scan</div>
                      <div className="text-sm font-medium text-white mt-1">{fmtFullTs(t.lastScan)}</div>
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                    <i className="ph ph-chart-bar mr-1.5"></i>Activity Summary
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-white">{t.totalScans}</div>
                      <div className="text-[10px] text-slate-400 mt-1 uppercase tracking-wide">Total Scans</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-slate-200">{t.uniqueStudents}</div>
                      <div className="text-[10px] text-slate-400 mt-1 uppercase tracking-wide">Students</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-emerald-400">{t.present ?? 0}</div>
                      <div className="text-[10px] text-slate-400 mt-1 uppercase tracking-wide">On-Time ({t.presentRate}%)</div>
                    </div>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 text-center">
                      <div className="text-2xl font-bold text-amber-400">{t.late ?? 0}</div>
                      <div className="text-[10px] text-slate-400 mt-1 uppercase tracking-wide">Late ({t.lateRate}%)</div>
                    </div>
                  </div>
                </div>

                {/* Hourly distribution */}
                {Object.keys(t.hourly || {}).length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                      <i className="ph ph-clock mr-1.5"></i>Hourly Distribution
                    </h3>
                    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4">
                      <div className="flex items-end gap-1 h-24">
                        {Array.from({ length: 24 }).map((_, h) => {
                          const c = t.hourly?.[h] || 0;
                          const heightPct = (c / maxHourly) * 100;
                          return (
                            <div key={h} className="flex-1 flex flex-col items-center justify-end h-full group relative" title={`${String(h).padStart(2, '0')}:00 — ${c} scans`}>
                              {c > 0 && (
                                <div
                                  className={`w-full rounded-t-sm ${isMobile ? 'bg-violet-500/70' : 'bg-brand-500/70'} hover:opacity-100`}
                                  style={{ height: `${heightPct}%`, minHeight: '2px' }}
                                ></div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex justify-between mt-2 text-[10px] text-slate-500 font-mono">
                        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Two-column: class breakdown + day of week */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {t.classBreakdown && t.classBreakdown.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                        <i className="ph ph-graduation-cap mr-1.5"></i>Class Breakdown
                      </h3>
                      <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 space-y-2 max-h-48 overflow-y-auto">
                        {t.classBreakdown.map((cb) => {
                          const pct = t.totalScans > 0 ? (cb.count / t.totalScans) * 100 : 0;
                          return (
                            <div key={cb.homeroom} className="flex items-center gap-3">
                              <span className="text-xs font-medium text-slate-300 w-12 flex-shrink-0">{cb.homeroom}</span>
                              <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div className={`h-full ${isMobile ? 'bg-violet-500' : 'bg-brand-500'} rounded-full`} style={{ width: `${pct}%` }}></div>
                              </div>
                              <span className="text-xs font-mono text-white w-10 text-right">{cb.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {t.dayOfWeek && Object.keys(t.dayOfWeek).length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                        <i className="ph ph-calendar mr-1.5"></i>Day of Week
                      </h3>
                      <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4">
                        <div className="flex items-end gap-2 h-24">
                          {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                            const c = t.dayOfWeek?.[d] || 0;
                            const max = Math.max(...Object.values(t.dayOfWeek || {}), 1);
                            const h = (c / max) * 100;
                            return (
                              <div key={d} className="flex-1 flex flex-col items-center gap-1 h-full justify-end" title={`${dowLabels[d]}: ${c}`}>
                                {c > 0 && (
                                  <div className={`w-full rounded-t ${isMobile ? 'bg-violet-500/70' : 'bg-brand-500/70'}`} style={{ height: `${h}%`, minHeight: '4px' }}></div>
                                )}
                                <span className="text-[10px] text-slate-500">{dowLabels[d]}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Scan details table */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                      <i className="ph ph-list-checks mr-1.5"></i>Scan Details
                    </h3>
                    <span className="text-[10px] text-slate-500">
                      Showing {t.records?.length || 0} of {t.recordsTotal || 0} (most recent)
                    </span>
                  </div>
                  <div className="bg-slate-900/60 border border-slate-800 rounded-lg overflow-hidden">
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-slate-900 z-10">
                          <tr className="border-b border-slate-800">
                            <th className="text-left px-4 py-2 text-[10px] font-medium text-slate-500 uppercase tracking-wider">Student</th>
                            <th className="text-left px-3 py-2 text-[10px] font-medium text-slate-500 uppercase tracking-wider">Class</th>
                            <th className="text-left px-3 py-2 text-[10px] font-medium text-slate-500 uppercase tracking-wider">Date</th>
                            <th className="text-left px-3 py-2 text-[10px] font-medium text-slate-500 uppercase tracking-wider">Time</th>
                            <th className="text-center px-3 py-2 text-[10px] font-medium text-slate-500 uppercase tracking-wider">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(t.records || []).map((r, i) => (
                            <tr key={`${r.employeeNo}-${r.timestamp}-${i}`} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                              <td className="px-4 py-2">
                                <div className="font-medium text-white text-xs">{r.name}</div>
                                <div className="text-[10px] text-slate-500 font-mono">{r.employeeNo}</div>
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-300">{r.homeroom || '—'}</td>
                              <td className="px-3 py-2 text-xs text-slate-400 font-mono">{r.date}</td>
                              <td className="px-3 py-2 text-xs text-slate-200 font-mono">{fmtTs(r.timestamp)}</td>
                              <td className="text-center px-3 py-2">
                                <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                  r.status === 'Present'
                                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                                    : r.status === 'Late'
                                      ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                                      : 'bg-slate-700/30 text-slate-400 border border-slate-600/30'
                                }`}>
                                  {r.status || '—'}
                                </span>
                              </td>
                            </tr>
                          ))}
                          {(!t.records || t.records.length === 0) && (
                            <tr>
                              <td colSpan={5} className="px-4 py-8 text-center text-slate-500 text-xs">No scans recorded for this terminal in the selected range.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between rounded-b-2xl">
                <span className="text-[11px] text-slate-500">Date range: {data?.range?.from} → {data?.range?.to}</span>
                <button
                  onClick={() => setSelectedTerminal(null)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-white transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </V2Layout>
  );
}
