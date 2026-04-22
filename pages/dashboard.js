/**
 * /dashboard — Real-time Attendance Dashboard (AuraSense Design)
 *
 * Displays today's attendance records from Firestore (populated by
 * the Python attendance_listener.py running on the Jetson).
 *
 * Features:
 *   - Auto-refresh every 10 seconds
 *   - Today's summary stats (present, late, absent)
 *   - Student attendance list with class, grade, timestamps
 *   - Filter by class, grade, status
 *   - Sortable columns (name, class, grade, time, status)
 *   - Date picker for historical view
 *   - Device connection status
 *   - Arrival distribution bar chart
 *   - Absent students sidebar
 */

import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

function getWIBDate() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function getWIBTime() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(11, 19);
}

export default function Dashboard() {
  const [date, setDate] = useState(getWIBDate());
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState({ total: 0, present: 0, late: 0, lastUpdated: null });
  const [enrolled, setEnrolled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [clock, setClock] = useState(getWIBTime());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);
  const [deviceConnected, setDeviceConnected] = useState(null);
  const [credentials, setCredentials] = useState({ ip: '', username: '', password: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const prevRecordCount = useRef(0);

  // Filter & sort state
  const [availableClasses, setAvailableClasses] = useState([]);
  const [availableGrades, setAvailableGrades] = useState([]);
  const [filterClass, setFilterClass] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState('time');   // name | class | grade | time | status | source
  const [sortDir, setSortDir] = useState('asc');         // asc | desc

  // Clock ticker
  useEffect(() => {
    const timer = setInterval(() => setClock(getWIBTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Load saved credentials
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hik_creds') || '{}');
      if (saved.ip) setCredentials(saved);
    } catch {}
  }, []);

  // Fetch attendance records
  const fetchAttendance = useCallback(async () => {
    try {
      const res = await fetch(`/api/attendance/today?date=${date}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Check for new records
      if (data.records.length > prevRecordCount.current && prevRecordCount.current > 0) {
        // New attendance detected
      }
      prevRecordCount.current = data.records.length;

      setRecords(data.records);
      setSummary(data.summary);
      setAvailableClasses(data.availableClasses || []);
      setAvailableGrades(data.availableGrades || []);
      setLastFetch(getWIBTime());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  // Fetch enrolled students (for absent list)
  const fetchEnrolled = useCallback(async () => {
    if (!credentials.ip) return;
    try {
      const params = new URLSearchParams({
        ip: credentials.ip,
        username: credentials.username,
        password: credentials.password,
      });
      const res = await fetch(`/api/attendance/enrolled?${params}`);
      if (!res.ok) throw new Error(`Device HTTP ${res.status}`);
      const data = await res.json();
      setEnrolled(data.users || []);
      setDeviceConnected(true);
    } catch {
      setDeviceConnected(false);
    }
  }, [credentials]);

  // Initial fetch + auto-refresh
  useEffect(() => {
    fetchAttendance();
    if (autoRefresh) {
      const timer = setInterval(fetchAttendance, 10000);
      return () => clearInterval(timer);
    }
  }, [fetchAttendance, autoRefresh]);

  // Fetch enrolled on credentials change
  useEffect(() => {
    if (credentials.ip) fetchEnrolled();
  }, [credentials, fetchEnrolled]);

  // Compute absent students
  const presentIds = new Set(records.map((r) => r.employeeNo));
  const absentStudents = enrolled.filter((u) => !presentIds.has(u.employeeNo));

  const saveCredentials = () => {
    localStorage.setItem('hik_creds', JSON.stringify(credentials));
    setShowSettings(false);
    fetchEnrolled();
  };

  const isToday = date === getWIBDate();

  // ─── Filtering ───
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (filterClass && r.homeroom !== filterClass) return false;
      if (filterGrade && r.grade !== filterGrade) return false;
      if (filterStatus === 'present' && r.late) return false;
      if (filterStatus === 'late' && !r.late) return false;
      if (filterSource && (r.source || '') !== filterSource) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const name = (r.name || '').toLowerCase();
        const id = (r.employeeNo || '').toLowerCase();
        if (!name.includes(q) && !id.includes(q)) return false;
      }
      return true;
    });
  }, [records, filterClass, filterGrade, filterStatus, filterSource, searchQuery]);

  // ─── Sorting ───
  const sortedRecords = useMemo(() => {
    const sorted = [...filteredRecords];
    sorted.sort((a, b) => {
      let va, vb;
      switch (sortField) {
        case 'name':
          va = (a.name || '').toLowerCase();
          vb = (b.name || '').toLowerCase();
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'class':
          va = a.homeroom || '';
          vb = b.homeroom || '';
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'grade':
          va = parseInt(a.grade) || 99;
          vb = parseInt(b.grade) || 99;
          return sortDir === 'asc' ? va - vb : vb - va;
        case 'status':
          va = a.late ? 1 : 0;
          vb = b.late ? 1 : 0;
          return sortDir === 'asc' ? va - vb : vb - va;
        case 'source':
          va = (a.source || '').toLowerCase();
          vb = (b.source || '').toLowerCase();
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'time':
        default:
          va = a.timestamp || '';
          vb = b.timestamp || '';
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
    });
    return sorted;
  }, [filteredRecords, sortField, sortDir]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortIcon = (field) => {
    if (sortField !== field) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  const hasActiveFilters = filterClass || filterGrade || filterStatus || filterSource || searchQuery;

  const clearFilters = () => {
    setFilterClass('');
    setFilterGrade('');
    setFilterStatus('');
    setFilterSource('');
    setSearchQuery('');
  };

  // ─── Arrival distribution (hourly buckets) ───
  const hourlyBuckets = useMemo(() => {
    const buckets = {};
    for (let h = 7; h <= 17; h++) buckets[h] = 0;
    records.forEach((r) => {
      const ts = r.timestamp || '';
      const timePart = ts.includes(' ') ? ts.split(' ')[1] : ts;
      const hour = parseInt(timePart?.split(':')[0]);
      if (!isNaN(hour) && buckets[hour] !== undefined) buckets[hour]++;
    });
    return buckets;
  }, [records]);

  const maxBucket = Math.max(...Object.values(hourlyBuckets), 1);

  const attendanceRate = enrolled.length > 0
    ? ((summary.total / enrolled.length) * 100).toFixed(1)
    : summary.total > 0 ? '—' : '0';

  return (
    <>
      <Head>
        <title>Attendance Dashboard — BINUS</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="aura-theme antialiased min-h-screen font-sans selection:bg-brand-500/30 selection:text-brand-400 overflow-x-hidden relative">
        <div className="noise-overlay"></div>

        {/* ─── Top Navigation ─── */}
        <header className="fixed top-0 left-0 right-0 z-40 glass-panel border-b-0 border-slate-800/80">
          <div className="max-w-[90rem] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            {/* Brand */}
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-400 to-indigo-600 flex items-center justify-center shadow-[0_0_15px_rgba(34,211,238,0.3)] relative overflow-hidden">
                <i className="ph ph-scan text-white text-xl z-10"></i>
                <div className="absolute inset-0 bg-white/20 h-[2px] w-full animate-scan-line"></div>
              </div>
              <span className="font-bold text-lg tracking-tight text-white">BINUS<span className="text-brand-400">Face</span></span>
            </div>

            {/* Nav Links */}
            <nav className="hidden md:flex items-center gap-1">
              <span className="px-4 py-2 text-sm font-medium rounded-md bg-white/10 text-brand-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
                Dashboard
              </span>
              <Link href="/enrollment" className="px-4 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all">
                Capture
              </Link>
              <Link href="/hikvision" className="px-4 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all">
                Enrollment
              </Link>
              <Link href="/attendance-monitor" className="px-4 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all">
                BINUS Logs
              </Link>
              <Link href="/device-manager" className="px-4 py-2 text-sm font-medium rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all">
                Devices
              </Link>
              <div className="h-5 w-px bg-slate-800 mx-1"></div>
              <Link href="/v2" className="px-3 py-1.5 text-xs font-bold rounded-md text-brand-400 bg-brand-500/10 border border-brand-500/30 hover:bg-brand-500/20 transition-all uppercase tracking-wide">
                v2 ✨
              </Link>
            </nav>

            {/* Right side */}
            <div className="flex items-center gap-3">
              <span className="text-sm font-mono text-slate-400">{clock} <span className="text-slate-600">WIB</span></span>
              <div className="h-5 w-px bg-slate-800"></div>
              <button
                onClick={() => setAutoRefresh(!autoRefresh)}
                title={autoRefresh ? 'Auto-refresh ON (10s)' : 'Auto-refresh OFF'}
                className={`text-sm px-2 py-1 rounded transition-colors ${autoRefresh ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <i className={`ph ${autoRefresh ? 'ph-arrow-clockwise' : 'ph-pause'}`}></i>
              </button>
              <button
                onClick={() => setShowSettings(!showSettings)}
                title="Device Settings"
                className="text-slate-400 hover:text-white transition-colors"
              >
                <i className="ph ph-gear text-xl"></i>
              </button>
            </div>
          </div>
        </header>

        {/* ─── Main Content ─── */}
        <main className="max-w-[90rem] mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-12 space-y-6">

          {/* Device Settings Panel (slide-down) */}
          {showSettings && (
            <div className="glass-panel rounded-2xl p-6 border border-slate-700 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-white font-semibold">Device Connection</h3>
                  <p className="text-xs text-slate-400 mt-1">Connect to Hikvision terminal to track absent students</p>
                </div>
                {deviceConnected === true && (
                  <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">
                    <i className="ph ph-check-circle"></i> Connected · {enrolled.length} enrolled
                  </span>
                )}
                {deviceConnected === false && (
                  <span className="text-xs text-red-400 bg-red-500/10 px-2 py-1 rounded border border-red-500/20">
                    <i className="ph ph-x-circle"></i> Cannot reach device
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  placeholder="Device IP"
                  value={credentials.ip}
                  onChange={(e) => setCredentials({ ...credentials, ip: e.target.value })}
                  className="bg-slate-950/50 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all w-40"
                />
                <input
                  placeholder="Username"
                  value={credentials.username}
                  onChange={(e) => setCredentials({ ...credentials, username: e.target.value })}
                  className="bg-slate-950/50 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all w-36"
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={credentials.password}
                  onChange={(e) => setCredentials({ ...credentials, password: e.target.value })}
                  className="bg-slate-950/50 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all w-36"
                />
                <button
                  onClick={saveCredentials}
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] active:scale-95"
                >
                  Connect
                </button>
              </div>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="glass-panel rounded-xl p-4 border border-red-500/30 bg-red-500/5 flex items-center justify-between">
              <span className="text-sm text-red-400"><i className="ph ph-warning"></i> {error}</span>
              <button onClick={fetchAttendance} className="text-xs text-white bg-red-500/20 hover:bg-red-500/30 px-3 py-1 rounded transition-colors">Retry</button>
            </div>
          )}

          {/* Hero Section */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-1">
                {isToday && autoRefresh ? (
                  <>
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                    </span>
                    <span className="text-sm font-medium text-emerald-500 tracking-wide uppercase">System Active · Live Monitoring</span>
                  </>
                ) : (
                  <>
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-slate-500"></span>
                    </span>
                    <span className="text-sm font-medium text-slate-400 tracking-wide uppercase">
                      {isToday ? 'Auto-refresh paused' : 'Viewing historical data'}
                    </span>
                  </>
                )}
              </div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">Campus Attendance</h1>
              <p className="text-slate-400 mt-2 max-w-2xl">Real-time facial recognition tracking. Showing data for {isToday ? 'today' : date}.</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="bg-slate-900/80 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-slate-200 focus:outline-none focus:border-brand-500 transition-all cursor-pointer appearance-none"
                />
              </div>
              {!isToday && (
                <button
                  onClick={() => setDate(getWIBDate())}
                  className="flex items-center gap-2 px-4 py-2.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] active:scale-95"
                >
                  <i className="ph ph-arrow-counter-clockwise text-lg"></i>
                  Back to Today
                </button>
              )}
            </div>
          </div>

          {/* ─── Stats Summary Grid ─── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Stat: Total Present */}
            <div className="glass-panel rounded-2xl p-5 hover:border-slate-700 transition-colors relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <i className="ph-fill ph-users text-6xl text-brand-400"></i>
              </div>
              <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-sm font-medium text-slate-400">Total Present</h3>
                {lastFetch && (
                  <span className="text-[10px] text-slate-500">{lastFetch}</span>
                )}
              </div>
              <div className="relative z-10">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-white">{summary.total.toLocaleString()}</span>
                  {enrolled.length > 0 && (
                    <span className="text-sm text-slate-500">/ {enrolled.length}</span>
                  )}
                </div>
                {enrolled.length > 0 && (
                  <>
                    <div className="w-full bg-slate-800 rounded-full h-1.5 mt-4 overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-brand-600 to-brand-400 h-1.5 rounded-full transition-all duration-500"
                        style={{ width: `${Math.min((summary.total / enrolled.length) * 100, 100)}%` }}
                      ></div>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">{attendanceRate}% overall attendance rate</p>
                  </>
                )}
              </div>
            </div>

            {/* Stat: On Time */}
            <div className="glass-panel rounded-2xl p-5 hover:border-slate-700 transition-colors relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <i className="ph-fill ph-check-circle text-6xl text-emerald-400"></i>
              </div>
              <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-sm font-medium text-slate-400">On Time</h3>
                <span className="px-2 py-1 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {summary.total > 0 ? `${((summary.present / summary.total) * 100).toFixed(0)}%` : '—'}
                </span>
              </div>
              <div className="relative z-10">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-white">{summary.present.toLocaleString()}</span>
                  <span className="text-sm text-slate-500">students</span>
                </div>
                <div className="w-full bg-slate-800 rounded-full h-1.5 mt-4 overflow-hidden">
                  <div
                    className="bg-emerald-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: summary.total > 0 ? `${(summary.present / summary.total) * 100}%` : '0%' }}
                  ></div>
                </div>
                <p className="text-xs text-slate-500 mt-2">Before 07:30 WIB cutoff</p>
              </div>
            </div>

            {/* Stat: Late */}
            <div className="glass-panel rounded-2xl p-5 hover:border-slate-700 transition-colors relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <i className="ph-fill ph-clock-countdown text-6xl text-amber-400"></i>
              </div>
              <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-sm font-medium text-slate-400">Late Arrivals</h3>
                {summary.late > 0 && (
                  <span className="px-2 py-1 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    <i className="ph ph-trend-up"></i> {summary.total > 0 ? `${((summary.late / summary.total) * 100).toFixed(0)}%` : '0%'}
                  </span>
                )}
              </div>
              <div className="relative z-10">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-white">{summary.late.toLocaleString()}</span>
                  <span className="text-sm text-slate-500">students</span>
                </div>
                <div className="w-full bg-slate-800 rounded-full h-1.5 mt-4 overflow-hidden">
                  <div
                    className="bg-amber-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: summary.total > 0 ? `${(summary.late / summary.total) * 100}%` : '0%' }}
                  ></div>
                </div>
                <p className="text-xs text-slate-500 mt-2">After 07:30 WIB cutoff</p>
              </div>
            </div>

            {/* Stat: Absent */}
            <div className="glass-panel rounded-2xl p-5 hover:border-red-900/50 transition-colors relative overflow-hidden group">
              <div className="absolute inset-0 bg-red-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <i className="ph-fill ph-user-minus text-6xl text-red-500"></i>
              </div>
              <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-sm font-medium text-slate-400">Absent / Unrecognized</h3>
                {absentStudents.length > 0 && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                )}
              </div>
              <div className="relative z-10">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-white">
                    {enrolled.length > 0 ? absentStudents.length : '—'}
                  </span>
                  <span className="text-sm text-slate-500">
                    {enrolled.length > 0 ? 'remaining' : 'no device'}
                  </span>
                </div>
                {enrolled.length === 0 && (
                  <button
                    onClick={() => setShowSettings(true)}
                    className="text-xs text-brand-400 hover:text-brand-300 mt-3 flex items-center gap-1 transition-colors"
                  >
                    <i className="ph ph-plug"></i> Connect device to track
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ─── Middle Section: Chart + Absent List ─── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Arrival Distribution Chart */}
            <div className="lg:col-span-2 glass-panel rounded-2xl border border-slate-800 p-6 flex flex-col h-[400px]">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-white">Arrival Distribution</h2>
                  <p className="text-sm text-slate-400">Check-in volume by hour</p>
                </div>
                <Link href="/attendance-monitor" className="text-sm text-brand-400 hover:text-brand-300 font-medium flex items-center gap-1 transition-colors">
                  BINUS Logs <i className="ph ph-arrow-right"></i>
                </Link>
              </div>

              <div className="flex-1 flex items-end gap-2 sm:gap-4 mt-4 pb-6 border-b border-slate-800 relative">
                {/* Y-Axis labels */}
                <div className="absolute left-0 top-0 bottom-6 w-8 flex flex-col justify-between text-[10px] text-slate-500">
                  <span>{maxBucket}</span>
                  <span>{Math.round(maxBucket * 0.66)}</span>
                  <span>{Math.round(maxBucket * 0.33)}</span>
                  <span>0</span>
                </div>
                {/* Bars */}
                <div className="flex-1 flex items-end gap-2 sm:gap-3 ml-8 h-full pt-4">
                  {Object.entries(hourlyBuckets).map(([hour, count]) => {
                    const pct = maxBucket > 0 ? (count / maxBucket) * 100 : 0;
                    const isPeak = count === maxBucket && count > 0;
                    const label = parseInt(hour) <= 12 ? `${hour}AM` : `${hour - 12}PM`;
                    const showLabel = [7, 8, 9, 10, 11, 12, 14, 17].includes(parseInt(hour));
                    return (
                      <div key={hour} className="w-full flex flex-col items-center group relative cursor-pointer" style={{ height: `${Math.max(pct, 2)}%` }}>
                        <div className={`w-full rounded-t-sm h-full transition-colors relative ${
                          isPeak
                            ? 'bg-gradient-to-t from-brand-600 to-brand-400 shadow-[0_0_15px_rgba(34,211,238,0.2)]'
                            : count > 0
                            ? 'bg-slate-700 hover:bg-slate-600'
                            : 'bg-slate-800/50'
                        }`}></div>
                        {count > 0 && (
                          <div className="absolute -top-8 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 border border-slate-700 text-xs py-1 px-2 rounded pointer-events-none whitespace-nowrap z-10">
                            {count} {count === 1 ? 'scan' : 'scans'}
                          </div>
                        )}
                        {showLabel && (
                          <span className={`absolute -bottom-6 text-[10px] ${isPeak ? 'text-slate-300 font-medium' : 'text-slate-500'}`}>
                            {parseInt(hour) === 7 ? '7AM' : parseInt(hour) === 12 ? '12PM' : label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Absent Students Sidebar */}
            <div className="glass-panel rounded-2xl border border-slate-800 flex flex-col h-[400px]">
              <div className="p-6 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">Not Yet Present</h2>
                  <p className="text-sm text-slate-400">Students not yet scanned</p>
                </div>
                {absentStudents.length > 0 && (
                  <div className="bg-red-500/10 text-red-400 text-xs font-bold px-2 py-1 rounded border border-red-500/20">
                    {absentStudents.length}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto no-scrollbar p-2">
                {enrolled.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center p-4">
                    <i className="ph ph-plugs-connected text-4xl text-slate-600 mb-3"></i>
                    <p className="text-sm text-slate-400">Connect device to see absent list</p>
                    <button
                      onClick={() => setShowSettings(true)}
                      className="mt-3 text-xs text-brand-400 hover:text-brand-300 px-3 py-1.5 border border-slate-700 rounded-lg hover:bg-white/5 transition-all"
                    >
                      <i className="ph ph-gear"></i> Device Settings
                    </button>
                  </div>
                ) : absentStudents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center p-4">
                    <i className="ph ph-confetti text-4xl text-emerald-500 mb-3"></i>
                    <p className="text-sm text-emerald-400 font-medium">All students recognized!</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {absentStudents.map((u) => (
                      <div key={u.employeeNo} className="p-3 rounded-xl hover:bg-white/5 transition-colors flex gap-3 items-center border border-transparent hover:border-slate-700/50">
                        <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0">
                          <i className="ph ph-user text-slate-500"></i>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{u.name}</p>
                          <p className="text-[10px] text-slate-500 font-mono">{u.employeeNo}</p>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 flex-shrink-0">Absent</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ─── Attendance Table ─── */}
          <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden flex flex-col shadow-lg shadow-black/20">

            {/* Table Header / Controls */}
            <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/40">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Live Roster Feed
                  {lastFetch && autoRefresh && isToday && (
                    <span className="relative ml-2 inline-flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                  )}
                </h2>
                <p className="text-sm text-slate-400">
                  {sortedRecords.length} record{sortedRecords.length !== 1 ? 's' : ''}
                  {filteredRecords.length !== records.length && ` (filtered from ${records.length})`}
                  {' · '}{date}
                </p>
              </div>

              <div className="flex items-center gap-3">
                {/* Search */}
                <div className="relative">
                  <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
                  <input
                    type="text"
                    placeholder="Search student or ID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full sm:w-64 bg-slate-950/50 border border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all"
                  />
                </div>
                {/* Filter toggle */}
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className={`px-3 py-2 border rounded-lg text-sm flex items-center gap-2 transition-all ${
                    hasActiveFilters
                      ? 'border-brand-500/50 bg-brand-500/10 text-brand-400'
                      : 'border-slate-700 bg-slate-950/50 text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <i className="ph ph-faders"></i>
                  <span className="hidden sm:inline">Filters</span>
                  {hasActiveFilters && (
                    <span className="w-2 h-2 rounded-full bg-brand-400"></span>
                  )}
                </button>
              </div>
            </div>

            {/* Filter row (toggled) */}
            {showFilters && (
              <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/30 flex flex-wrap items-center gap-3">
                <select value={filterGrade} onChange={(e) => setFilterGrade(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-brand-500 transition-all">
                  <option value="">All Grades</option>
                  {availableGrades.map((g) => <option key={g} value={g}>Grade {g}</option>)}
                </select>
                <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-brand-500 transition-all">
                  <option value="">All Classes</option>
                  {availableClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-brand-500 transition-all">
                  <option value="">All Status</option>
                  <option value="present">Present</option>
                  <option value="late">Late</option>
                </select>
                <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-brand-500 transition-all">
                  <option value="">All Sources</option>
                  <option value="mobile_face">Mobile</option>
                  <option value="hikvision_terminal">Hikvision</option>
                </select>
                {hasActiveFilters && (
                  <button onClick={clearFilters} className="text-xs text-slate-400 hover:text-white px-2 py-1 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors">
                    Clear all
                  </button>
                )}
              </div>
            )}

            {/* Table */}
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="text-center">
                  <i className="ph ph-spinner text-3xl text-brand-400 animate-spin"></i>
                  <p className="text-sm text-slate-400 mt-3">Loading attendance data...</p>
                </div>
              </div>
            ) : records.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <div className="text-center">
                  <i className="ph ph-tray text-5xl text-slate-600 mb-3"></i>
                  <p className="text-slate-400">No attendance records for {date}</p>
                  {isToday && (
                    <p className="text-xs text-slate-500 mt-2">
                      Make sure <code className="text-brand-400">attendance_listener.py</code> is running on the Jetson
                    </p>
                  )}
                </div>
              </div>
            ) : sortedRecords.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <div className="text-center">
                  <i className="ph ph-magnifying-glass text-5xl text-slate-600 mb-3"></i>
                  <p className="text-slate-400">No records match current filters</p>
                  <button onClick={clearFilters} className="mt-3 text-sm text-brand-400 hover:text-brand-300 px-4 py-2 border border-slate-700 rounded-lg hover:bg-white/5 transition-all">
                    Clear Filters
                  </button>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left whitespace-nowrap text-sm border-collapse">
                  <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800 text-xs uppercase tracking-wider font-semibold">
                    <tr>
                      <th className="px-6 py-4 w-12">#</th>
                      <th className="px-6 py-4 cursor-pointer hover:text-slate-200 transition-colors" onClick={() => handleSort('name')}>
                        Student <span className="text-slate-600 ml-1">{sortIcon('name')}</span>
                      </th>
                      <th className="px-6 py-4 cursor-pointer hover:text-slate-200 transition-colors" onClick={() => handleSort('class')}>
                        Class <span className="text-slate-600 ml-1">{sortIcon('class')}</span>
                      </th>
                      <th className="px-6 py-4 cursor-pointer hover:text-slate-200 transition-colors" onClick={() => handleSort('grade')}>
                        Grade <span className="text-slate-600 ml-1">{sortIcon('grade')}</span>
                      </th>
                      <th className="px-6 py-4 cursor-pointer hover:text-slate-200 transition-colors" onClick={() => handleSort('time')}>
                        Time <span className="text-slate-600 ml-1">{sortIcon('time')}</span>
                      </th>
                      <th className="px-6 py-4 cursor-pointer hover:text-slate-200 transition-colors" onClick={() => handleSort('status')}>
                        Status <span className="text-slate-600 ml-1">{sortIcon('status')}</span>
                      </th>
                      <th className="px-6 py-4 cursor-pointer hover:text-slate-200 transition-colors" onClick={() => handleSort('source')}>
                        Source <span className="text-slate-600 ml-1">{sortIcon('source')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {sortedRecords.map((r, i) => (
                      <tr key={r.id || i} className={`hover:bg-slate-800/30 transition-colors ${r.late ? 'bg-amber-950/5' : ''}`}>
                        <td className="px-6 py-4 text-slate-500 font-mono text-xs">{i + 1}</td>
                        <td className="px-6 py-4">
                          <div>
                            <div className="font-medium text-white">{r.name}</div>
                            <div className="text-xs text-slate-500 font-mono mt-0.5">{r.employeeNo || '—'}</div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          {r.homeroom ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-xs">
                              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                              {r.homeroom}
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-slate-300">{r.grade || '—'}</td>
                        <td className="px-6 py-4">
                          <span className="text-slate-300 font-mono text-xs">
                            {r.timestamp ? (r.timestamp.split(' ')[1] || r.timestamp) : '—'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          {r.late ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              <i className="ph-fill ph-clock"></i> Late
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <i className="ph-fill ph-check-circle"></i> Present
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {r.source === 'mobile_face' ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-violet-500/10 text-violet-400 border border-violet-500/20 text-xs">
                              <i className="ph ph-device-mobile"></i> Mobile
                            </span>
                          ) : r.source === 'hikvision_terminal' ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-brand-500/10 text-brand-400 border border-brand-500/20 text-xs">
                              <i className="ph ph-fingerprint"></i> {r.deviceName || 'Hikvision'}
                            </span>
                          ) : (
                            <span className="text-slate-500 text-xs">{r.source || '—'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Table footer */}
            <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/40 flex items-center justify-between text-sm">
              <div className="text-slate-500">
                Showing <span className="text-white font-medium">{sortedRecords.length}</span> of <span className="text-white font-medium">{records.length}</span> records
              </div>
              <div className="text-slate-500 text-xs">
                {lastFetch && <>Last updated: {lastFetch} WIB</>}
              </div>
            </div>
          </div>

        </main>

        {/* ─── Footer ─── */}
        <footer className="border-t border-slate-800/50 bg-slate-950/80 backdrop-blur-sm py-8">
          <div className="max-w-[90rem] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <i className="ph ph-shield-check text-brand-500 text-lg"></i>
              <span>{isToday && autoRefresh && '● Live · '}{date} · BINUS School Simprug AI Club</span>
            </div>
            <div className="flex items-center gap-6 text-sm">
              <Link href="/attendance-monitor" className="text-slate-400 hover:text-white transition-colors">BINUS Logs</Link>
              <Link href="/device-manager" className="text-slate-400 hover:text-white transition-colors">Device Manager</Link>
              <span className="text-slate-600">© 2026</span>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
