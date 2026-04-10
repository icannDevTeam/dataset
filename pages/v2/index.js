/**
 * /v2 — Dashboard Overview (v2 Design with Live Firestore Data)
 *
 * Wired into the same /api/attendance/today endpoint as v1 dashboard.
 * Professional dark theme with sidebar navigation.
 */

import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState, useEffect, useCallback, useMemo } from 'react';
import V2Layout from '../../components/v2/V2Layout';

function getWIBDate() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function getWIBTime() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(11, 19);
}

function formatTime12(timestamp) {
  if (!timestamp) return '—';
  const timePart = timestamp.includes(' ') ? timestamp.split(' ')[1] : timestamp;
  const [h, m, s] = timePart.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s || 0).padStart(2, '0')} ${ampm}`;
}

export default function DashboardV2() {
  const router = useRouter();
  const [date, setDate] = useState(getWIBDate());
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState({ total: 0, present: 0, late: 0, lastUpdated: null });
  const [enrolled, setEnrolled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastFetch, setLastFetch] = useState(null);

  // Thumbnails
  const [thumbnails, setThumbnails] = useState({});

  // Filter & sort
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [availableClasses, setAvailableClasses] = useState([]);
  const [availableGrades, setAvailableGrades] = useState([]);
  const [sortField, setSortField] = useState('time');
  const [sortDir, setSortDir] = useState('desc');
  const [showFilters, setShowFilters] = useState(false);

  // Fetch attendance
  const fetchAttendance = useCallback(async () => {
    try {
      const res = await fetch(`/api/attendance/today?date=${date}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
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

  useEffect(() => {
    fetchAttendance();
    if (autoRefresh) {
      const timer = setInterval(fetchAttendance, 10000);
      return () => clearInterval(timer);
    }
  }, [fetchAttendance, autoRefresh]);

  // Fetch student face thumbnails (once)
  useEffect(() => {
    fetch('/api/dataset/thumbnails')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.thumbnails) setThumbnails(data.thumbnails); })
      .catch(() => {});
  }, []);

  // Fetch enrolled for absent count
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hik_creds') || '{}');
      if (saved.ip) {
        const params = new URLSearchParams({ ip: saved.ip, username: saved.username, password: saved.password });
        fetch(`/api/attendance/enrolled?${params}`)
          .then(r => r.ok ? r.json() : Promise.reject())
          .then(data => setEnrolled(data.users || []))
          .catch(() => {});
      }
    } catch {}
  }, []);

  // Filtering
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      if (filterClass && r.homeroom !== filterClass) return false;
      if (filterGrade && r.grade !== filterGrade) return false;
      if (filterStatus === 'present' && r.late) return false;
      if (filterStatus === 'late' && !r.late) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const name = (r.name || '').toLowerCase();
        const id = (r.employeeNo || '').toLowerCase();
        if (!name.includes(q) && !id.includes(q)) return false;
      }
      return true;
    });
  }, [records, filterClass, filterGrade, filterStatus, searchQuery]);

  // Sorting
  const sortedRecords = useMemo(() => {
    const sorted = [...filteredRecords];
    sorted.sort((a, b) => {
      let va, vb;
      switch (sortField) {
        case 'name':
          va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase();
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'class':
          va = a.homeroom || ''; vb = b.homeroom || '';
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'grade':
          va = parseInt(a.grade) || 99; vb = parseInt(b.grade) || 99;
          return sortDir === 'asc' ? va - vb : vb - va;
        case 'status':
          va = a.late ? 1 : 0; vb = b.late ? 1 : 0;
          return sortDir === 'asc' ? va - vb : vb - va;
        case 'source':
          va = (a.source || '').toLowerCase(); vb = (b.source || '').toLowerCase();
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'time': default:
          va = a.timestamp || ''; vb = b.timestamp || '';
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
    });
    return sorted;
  }, [filteredRecords, sortField, sortDir]);

  const handleSort = (field) => {
    if (sortField === field) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const sortIcon = (field) => {
    if (sortField !== field) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  // Hourly distribution
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

  // Late students for sidebar
  const lateStudents = useMemo(() => records.filter(r => r.late), [records]);

  const presentIds = new Set(records.map(r => r.employeeNo));
  const absentCount = enrolled.length > 0 ? enrolled.filter(u => !presentIds.has(u.employeeNo)).length : null;
  const totalEnrolled = enrolled.length || null;
  const attendanceRate = totalEnrolled ? ((summary.total / totalEnrolled) * 100).toFixed(1) : null;
  const isToday = date === getWIBDate();

  const hasActiveFilters = filterClass || filterGrade || filterStatus || searchQuery;

  const hourLabels = { 7: '7AM', 8: '8AM', 9: '9AM', 10: '10AM', 11: '11AM', 12: '12PM', 13: '1PM', 14: '2PM', 15: '3PM', 16: '4PM', 17: '5PM' };

  const sourceIcon = (source) => {
    if (!source) return 'ph-question';
    if (source.includes('mobile')) return 'ph-device-mobile';
    if (source.includes('hikvision') || source.includes('device')) return 'ph-fingerprint';
    return 'ph-monitor';
  };

  const sourceLabel = (source) => {
    if (!source) return 'Unknown';
    if (source.includes('mobile')) return 'Mobile';
    if (source.includes('hikvision') || source.includes('device')) return 'Basement 1 Terminal';
    return source;
  };

  return (
    <V2Layout>
      <Head><title>Dashboard — BINUS Attendance</title></Head>
      <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6 max-w-[1600px] mx-auto">

        {/* Hero Section */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              <span className="text-sm font-medium text-emerald-500 tracking-wide uppercase">
                {autoRefresh ? 'Live Monitoring' : 'Paused'} {lastFetch && <span className="text-slate-500">· Updated {lastFetch}</span>}
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">Campus Attendance</h1>
            <p className="text-slate-400 mt-2 max-w-2xl">
              Real-time facial recognition tracking. {isToday ? "Showing today's data." : `Viewing ${date}.`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="date"
              value={date}
              onChange={(e) => { setDate(e.target.value); setLoading(true); }}
              className="px-4 py-2.5 glass-panel rounded-lg text-sm font-medium text-slate-200 border border-slate-700 bg-slate-950/50 focus:outline-none focus:border-brand-500"
            />
            {!isToday && (
              <button onClick={() => setDate(getWIBDate())} className="px-4 py-2.5 glass-panel rounded-lg text-sm font-medium text-brand-400 hover:bg-slate-800/80 transition-all border border-brand-500/30">
                Back to Today
              </button>
            )}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`px-4 py-2.5 rounded-lg text-sm font-semibold transition-all active:scale-95 ${
                autoRefresh
                  ? 'bg-brand-500 hover:bg-brand-400 text-slate-950 shadow-[0_0_20px_rgba(6,182,212,0.3)]'
                  : 'glass-panel text-slate-400 border border-slate-700 hover:text-white'
              }`}
            >
              <i className={`ph ${autoRefresh ? 'ph-pause' : 'ph-play'} mr-1`}></i>
              {autoRefresh ? 'Live' : 'Paused'}
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
            <i className="ph ph-warning-circle text-lg"></i>
            Failed to fetch: {error}
            <button onClick={fetchAttendance} className="ml-auto text-xs underline">Retry</button>
          </div>
        )}

        {/* Stats Summary Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Stat 1: Total Present */}
          <div className="glass-panel rounded-2xl p-5 hover:border-slate-700 transition-colors relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <i className="ph-fill ph-users text-6xl text-brand-400"></i>
            </div>
            <div className="flex items-center justify-between mb-4 relative z-10">
              <h3 className="text-sm font-medium text-slate-400">Total Present</h3>
              {attendanceRate && (
                <span className="px-2 py-1 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 flex items-center gap-1 border border-emerald-500/20">
                  {attendanceRate}%
                </span>
              )}
            </div>
            <div className="relative z-10">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-white">{summary.total.toLocaleString()}</span>
                {totalEnrolled && <span className="text-sm text-slate-500">/ {totalEnrolled}</span>}
              </div>
              <div className="w-full bg-slate-800 rounded-full h-1.5 mt-4 overflow-hidden">
                <div className="bg-gradient-to-r from-brand-600 to-brand-400 h-1.5 rounded-full transition-all duration-500" style={{ width: attendanceRate ? `${Math.min(parseFloat(attendanceRate), 100)}%` : (summary.total > 0 ? '100%' : '0%') }}></div>
              </div>
              <p className="text-xs text-slate-500 mt-2">{attendanceRate ? `${attendanceRate}% attendance rate` : `${summary.total} checked in`}</p>
            </div>
          </div>

          {/* Stat 2: On-Time */}
          <div className="glass-panel rounded-2xl p-5 hover:border-slate-700 transition-colors relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <i className="ph-fill ph-clock text-6xl text-emerald-400"></i>
            </div>
            <div className="flex items-center justify-between mb-4 relative z-10">
              <h3 className="text-sm font-medium text-slate-400">On-Time</h3>
              {summary.total > 0 && (
                <span className="px-2 py-1 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {((summary.present / summary.total) * 100).toFixed(0)}%
                </span>
              )}
            </div>
            <div className="relative z-10">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-white">{summary.present.toLocaleString()}</span>
                <span className="text-sm text-slate-500">students</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-1.5 mt-4 overflow-hidden">
                <div className="bg-emerald-500 h-1.5 rounded-full transition-all duration-500" style={{ width: summary.total > 0 ? `${(summary.present / summary.total) * 100}%` : '0%' }}></div>
              </div>
              <p className="text-xs text-slate-500 mt-2">Before 07:30 WIB cutoff</p>
            </div>
          </div>

          {/* Stat 3: Late */}
          <div className="glass-panel rounded-2xl p-5 hover:border-slate-700 transition-colors relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <i className="ph-fill ph-clock-countdown text-6xl text-amber-400"></i>
            </div>
            <div className="flex items-center justify-between mb-4 relative z-10">
              <h3 className="text-sm font-medium text-slate-400">Late Arrivals</h3>
              {summary.late > 0 && (
                <span className="px-2 py-1 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  {((summary.late / summary.total) * 100).toFixed(0)}%
                </span>
              )}
            </div>
            <div className="relative z-10">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-white">{summary.late.toLocaleString()}</span>
                <span className="text-sm text-slate-500">students</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-1.5 mt-4 overflow-hidden">
                <div className="bg-amber-500 h-1.5 rounded-full transition-all duration-500" style={{ width: summary.total > 0 ? `${(summary.late / summary.total) * 100}%` : '0%' }}></div>
              </div>
              <p className="text-xs text-slate-500 mt-2">After 07:30 WIB cutoff</p>
            </div>
          </div>

          {/* Stat 4: Absent */}
          <div className="glass-panel rounded-2xl p-5 hover:border-red-900/50 transition-colors relative overflow-hidden group">
            <div className="absolute inset-0 bg-red-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <i className="ph-fill ph-user-minus text-6xl text-red-500"></i>
            </div>
            <div className="flex items-center justify-between mb-4 relative z-10">
              <h3 className="text-sm font-medium text-slate-400">Absent</h3>
              {absentCount !== null && absentCount > 0 && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                </span>
              )}
            </div>
            <div className="relative z-10">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-white">{absentCount !== null ? absentCount.toLocaleString() : '—'}</span>
                <span className="text-sm text-slate-500">{absentCount !== null ? 'students' : 'connect device'}</span>
              </div>
              {absentCount !== null && totalEnrolled && (
                <div className="w-full bg-slate-800 rounded-full h-1.5 mt-4 overflow-hidden">
                  <div className="bg-red-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${(absentCount / totalEnrolled) * 100}%` }}></div>
                </div>
              )}
              <p className="text-xs text-slate-500 mt-2">{absentCount !== null ? 'Not yet checked in' : 'Configure in Device Manager'}</p>
            </div>
          </div>
        </div>

        {/* Middle Section: Chart & Late Students */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Arrival Distribution Chart */}
          <div className="lg:col-span-2 glass-panel rounded-2xl border border-slate-800 p-6 flex flex-col h-[400px]">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-white">Arrival Distribution</h2>
                <p className="text-sm text-slate-400">{records.length} check-ins across the day</p>
              </div>
              <button onClick={() => router.push('/v2/analytics')} className="text-sm text-brand-400 hover:text-brand-300 font-medium flex items-center gap-1 transition-colors">
                Full Analytics <i className="ph ph-arrow-right"></i>
              </button>
            </div>

            <div className="flex-1 flex items-end gap-2 sm:gap-3 mt-4 pb-6 border-b border-slate-800 relative">
              {/* Y-Axis */}
              <div className="absolute left-0 top-0 bottom-6 w-8 flex flex-col justify-between text-[10px] text-slate-500">
                <span>{maxBucket}</span>
                <span>{Math.round(maxBucket * 0.66)}</span>
                <span>{Math.round(maxBucket * 0.33)}</span>
                <span>0</span>
              </div>
              {/* Bars */}
              <div className="flex-1 flex items-end gap-1 sm:gap-2 ml-10 h-full pt-4">
                {Object.entries(hourlyBuckets).map(([hour, count]) => {
                  const pct = maxBucket > 0 ? (count / maxBucket) * 100 : 0;
                  const isPeak = count === maxBucket && count > 0;
                  return (
                    <div key={hour} className="w-full flex flex-col items-center group relative cursor-pointer" style={{ height: `${Math.max(pct, 2)}%` }}>
                      <div className={`w-full rounded-t-sm h-full transition-colors relative ${
                        isPeak ? 'bg-gradient-to-t from-brand-600 to-brand-400 shadow-[0_0_15px_rgba(34,211,238,0.2)]' :
                        count > 0 ? 'bg-slate-700 hover:bg-slate-600' : 'bg-slate-800/50'
                      }`}></div>
                      {count > 0 && (
                        <div className="absolute -top-8 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 border border-slate-700 text-xs py-1 px-2 rounded pointer-events-none whitespace-nowrap z-10">
                          {count} {count === 1 ? 'scan' : 'scans'}
                        </div>
                      )}
                      <span className={`absolute -bottom-6 text-[10px] ${isPeak ? 'text-brand-400 font-medium' : 'text-slate-500'}`}>
                        {hourLabels[hour] || ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Late Arrivals List */}
          <div className="glass-panel rounded-2xl border border-slate-800 flex flex-col h-[400px]">
            <div className="p-6 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Late Arrivals</h2>
                <p className="text-sm text-slate-400">After 07:30 WIB</p>
              </div>
              {lateStudents.length > 0 && (
                <div className="bg-amber-500/10 text-amber-400 text-xs font-bold px-2 py-1 rounded border border-amber-500/20">
                  {lateStudents.length}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar p-2">
              {lateStudents.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500">
                  <i className="ph ph-check-circle text-4xl mb-2 text-emerald-500/50"></i>
                  <p className="text-sm">No late arrivals</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {lateStudents.slice(0, 20).map((s, i) => (
                    <div key={s.employeeNo || i} className="p-3 rounded-xl hover:bg-white/5 transition-colors flex gap-3 items-start border border-transparent hover:border-slate-700/50">
                      {(thumbnails[s.employeeNo] || thumbnails[`name:${s.name}`]) ? (
                        <img
                          src={thumbnails[s.employeeNo] || thumbnails[`name:${s.name}`]}
                          alt={s.name}
                          className="w-10 h-10 rounded-lg object-cover border border-amber-500/20 flex-shrink-0 bg-slate-800"
                          onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                        />
                      ) : null}
                      <div
                        className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 items-center justify-center flex-shrink-0"
                        style={{ display: (thumbnails[s.employeeNo] || thumbnails[`name:${s.name}`]) ? 'none' : 'flex' }}
                      >
                        <i className="ph ph-clock-countdown text-lg text-amber-400"></i>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start">
                          <p className="text-sm font-medium text-white truncate">{s.name || s.employeeNo}</p>
                          <span className="text-[10px] text-slate-500 flex-shrink-0 ml-2">{formatTime12(s.timestamp)}</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {s.homeroom ? `${s.grade ? `Grade ${s.grade} · ` : ''}${s.homeroom}` : s.employeeNo}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">Late</span>
                          <span className="text-[10px] text-slate-500 flex items-center gap-1">
                            <i className={`ph ${sourceIcon(s.source)}`}></i> {sourceLabel(s.source)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {lateStudents.length > 20 && (
                    <p className="text-center text-xs text-slate-500 py-2">+{lateStudents.length - 20} more</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Attendance Table */}
        <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden flex flex-col shadow-lg shadow-black/20">
          {/* Table Controls */}
          <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/40">
            <div>
              <h2 className="text-lg font-semibold text-white">Live Roster Feed</h2>
              <p className="text-sm text-slate-400">{filteredRecords.length} of {records.length} records{hasActiveFilters ? ' (filtered)' : ''}</p>
            </div>
            <div className="flex items-center gap-3">
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
              <button onClick={() => setShowFilters(!showFilters)} className={`px-3 py-2 border rounded-lg text-sm transition-all flex items-center gap-2 ${showFilters ? 'border-brand-500 bg-brand-500/10 text-brand-400' : 'border-slate-700 bg-slate-950/50 text-slate-300 hover:bg-slate-800 hover:text-white'}`}>
                <i className="ph ph-faders"></i>
                <span className="hidden sm:inline">Filters</span>
                {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-brand-400"></span>}
              </button>
            </div>
          </div>

          {/* Filter bar */}
          {showFilters && (
            <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/20 flex flex-wrap items-center gap-3">
              <select value={filterGrade} onChange={(e) => setFilterGrade(e.target.value)} className="bg-slate-950/50 border border-slate-700 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-brand-500">
                <option value="">All Grades</option>
                {availableGrades.sort().map(g => <option key={g} value={g}>Grade {g}</option>)}
              </select>
              <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)} className="bg-slate-950/50 border border-slate-700 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-brand-500">
                <option value="">All Classes</option>
                {availableClasses.sort().map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="bg-slate-950/50 border border-slate-700 rounded-lg py-1.5 px-3 text-sm text-white focus:outline-none focus:border-brand-500">
                <option value="">All Status</option>
                <option value="present">On-Time</option>
                <option value="late">Late</option>
              </select>
              {hasActiveFilters && (
                <button onClick={() => { setFilterGrade(''); setFilterClass(''); setFilterStatus(''); setSearchQuery(''); }} className="text-xs text-brand-400 hover:text-brand-300 underline underline-offset-2">
                  Clear All
                </button>
              )}
            </div>
          )}

          {/* Table */}
          <div className="overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-sm text-slate-400">Loading attendance...</span>
                </div>
              </div>
            ) : sortedRecords.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                <i className="ph ph-clipboard-text text-5xl mb-3 opacity-30"></i>
                <p className="text-sm">{records.length === 0 ? 'No attendance records for this date.' : 'No records match your filters.'}</p>
              </div>
            ) : (
              <table className="w-full text-left whitespace-nowrap text-sm border-collapse">
                <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800 text-xs uppercase tracking-wider font-semibold">
                  <tr>
                    <th className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('name')}>Student Info{sortIcon('name')}</th>
                    <th className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('time')}>Time{sortIcon('time')}</th>
                    <th className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('class')}>Class{sortIcon('class')}</th>
                    <th className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('grade')}>Grade{sortIcon('grade')}</th>
                    <th className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('source')}>Source{sortIcon('source')}</th>
                    <th className="px-6 py-4 cursor-pointer hover:text-white transition-colors text-right" onClick={() => handleSort('status')}>Status{sortIcon('status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {sortedRecords.map((r, i) => (
                    <tr key={r.id || r.employeeNo || i} className={`hover:bg-slate-800/30 transition-colors group ${r.late ? 'bg-amber-950/5' : ''}`}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          {(thumbnails[r.employeeNo] || thumbnails[`name:${r.name}`]) ? (
                            <img
                              src={thumbnails[r.employeeNo] || thumbnails[`name:${r.name}`]}
                              alt={r.name}
                              className="w-10 h-10 rounded-lg object-cover border border-slate-700 flex-shrink-0 bg-slate-800"
                              onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                            />
                          ) : null}
                          <div
                            className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 items-center justify-center flex-shrink-0"
                            style={{ display: (thumbnails[r.employeeNo] || thumbnails[`name:${r.name}`]) ? 'none' : 'flex' }}
                          >
                            <span className="text-sm font-bold text-slate-400">{(r.name || '?')[0].toUpperCase()}</span>
                          </div>
                          <div>
                            <div className="font-medium text-white">{r.name || 'Unknown'}</div>
                            <div className="text-xs text-slate-500 font-mono mt-0.5">ID: {r.employeeNo}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-slate-300">{formatTime12(r.timestamp)}</div>
                      </td>
                      <td className="px-6 py-4">
                        {r.homeroom ? (
                          <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-800 text-slate-300 border border-slate-700">
                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-400"></div>
                            {r.homeroom}
                          </div>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-slate-300">{r.grade || '—'}</td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center gap-1.5 text-slate-400 text-xs">
                          <i className={`ph ${sourceIcon(r.source)} text-base`}></i>
                          {sourceLabel(r.source)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                          r.late
                            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                            : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        }`}>
                          <i className={`ph-fill ${r.late ? 'ph-clock-countdown' : 'ph-check-circle'}`}></i>
                          {r.late ? 'Late' : 'Present'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Table footer */}
          {sortedRecords.length > 0 && (
            <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/40 flex items-center justify-between text-sm">
              <div className="text-slate-500">
                Showing <span className="text-white font-medium">{sortedRecords.length}</span> of <span className="text-white font-medium">{records.length}</span> results
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-slate-800/50 bg-slate-950/80 backdrop-blur-sm mt-8 py-6">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <i className="ph ph-shield-check text-brand-500 text-lg"></i>
            <span>BINUS Attendance System</span>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <span className="text-slate-600">BINUS School Serpong</span>
          </div>
        </div>
      </footer>
    </V2Layout>
  );
}
