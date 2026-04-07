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
  ];

  return (
    <V2Layout>
      <Head><title>Reports — BINUSFace v2</title></Head>

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
                    <h2 className="text-lg font-semibold text-white mb-4">Terminal Breakdown</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {data.sourceSummary.map((src) => (
                        <div key={src.source} className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <i className="ph ph-fingerprint text-brand-400"></i>
                              <span className="text-sm font-medium text-white">{src.source}</span>
                            </div>
                          </div>
                          <div className="flex items-baseline gap-4">
                            <div>
                              <span className="text-2xl font-bold text-white">{src.totalScans}</span>
                              <span className="text-xs text-slate-400 ml-1">scans</span>
                            </div>
                            <div>
                              <span className="text-lg font-semibold text-slate-300">{src.uniqueStudents}</span>
                              <span className="text-xs text-slate-400 ml-1">students</span>
                            </div>
                          </div>
                        </div>
                      ))}
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
    </V2Layout>
  );
}
