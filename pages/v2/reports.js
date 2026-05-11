import Head from 'next/head';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import PickupReportExportOverlay from '../../components/v2/reports/PickupReportExportOverlay';

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

// Cooldown — keep aligned with backend/attendance_listener.py DUPLICATE_WINDOW
const SCAN_COOLDOWN_HOURS = 8;

function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportPickupCSV(data, fromDate, toDate) {
  if (!data) return;
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const rows = [];
  rows.push(['BINUS Pickup System — Analytics Report']);
  rows.push(['Date Range', `${fromDate} → ${toDate}`]);
  rows.push(['Total Days', data.range?.totalDays ?? '']);
  rows.push(['Generated At', generated]);
  rows.push([]);
  rows.push(['--- Summary ---']);
  rows.push(['Total Pickups', data.summary.totalPickups]);
  rows.push(['Auto-Approved', data.summary.autoApproved, `${data.summary.approvalRate}%`]);
  rows.push(['Officer Overridden', data.summary.officerOverridden, `${data.summary.overrideRate}%`]);
  rows.push(['Flagged (non-green)', data.summary.flagged]);
  rows.push(['Average / Day', data.summary.avgPerDay]);
  if (data.peakHour) rows.push(['Peak Hour (WIB)', `${String(data.peakHour.hour).padStart(2, '0')}:00`, `${data.peakHour.count} pickups`]);
  rows.push([]);
  rows.push(['--- Card State ---']);
  rows.push(['State', 'Count']);
  Object.entries(data.byCardState || {}).forEach(([k, v]) => rows.push([k, v]));
  rows.push([]);
  rows.push(['--- Daily Volume ---']);
  rows.push(['Date', 'Total', 'Auto-Approved', 'Overridden', 'Green', 'Yellow', 'Red']);
  (data.byDate || []).forEach(d => rows.push([d.date, d.total, d.autoApproved, d.overridden, d.green, d.yellow, d.red]));
  rows.push([]);
  rows.push(['--- Hourly Volume (WIB) ---']);
  rows.push(['Hour', 'Total Pickups', 'Overrides']);
  (data.byHour || []).forEach((h, i) => rows.push([`${String(i).padStart(2, '0')}:00`, h.total, h.overridden]));
  rows.push([]);
  rows.push(['--- By Gate ---']);
  rows.push(['Gate', 'Total', 'Auto-Approved', 'Overridden']);
  (data.byGate || []).forEach(g => rows.push([g.gate, g.total, g.autoApproved, g.overridden]));
  rows.push([]);
  rows.push(['--- By Class ---']);
  rows.push(['Homeroom', 'Total Pickups']);
  (data.byClass || []).forEach(c => rows.push([c.homeroom || c.class, c.total]));
  rows.push([]);

  // ── Facial-recognition signals ──────────────────────────────
  const fr = data.fr;
  if (fr) {
    rows.push(['--- FR Confidence ---']);
    rows.push(['Sample Size', fr.sample]);
    rows.push(['Average Confidence (%)', fr.confidence?.avg ?? '']);
    rows.push(['Min Confidence (%)', fr.confidence?.min ?? '']);
    rows.push(['Max Confidence (%)', fr.confidence?.max ?? '']);
    rows.push(['Distribution: <50%', fr.confidence?.distribution?.below50 ?? 0]);
    rows.push(['Distribution: 50-70%', fr.confidence?.distribution?.['50to70'] ?? 0]);
    rows.push(['Distribution: 70-90%', fr.confidence?.distribution?.['70to90'] ?? 0]);
    rows.push(['Distribution: ≥90%', fr.confidence?.distribution?.above90 ?? 0]);
    rows.push([]);
    rows.push(['--- Liveness & Anti-Spoofing ---']);
    rows.push(['Liveness Checks', fr.liveness?.checked ?? 0]);
    rows.push(['Liveness Passed', fr.liveness?.passed ?? 0]);
    rows.push(['Liveness Pass Rate (%)', fr.liveness?.passRate ?? '']);
    rows.push(['Spoof Attempts', fr.spoofAttempts ?? 0]);
    rows.push(['Unknown Chaperone Events', fr.unknownChaperone ?? 0]);
    rows.push(['Average Retries', fr.retriesAvg ?? '']);
    rows.push([]);
    if ((data.byTerminal || []).length) {
      rows.push(['--- Per-Terminal Recognition Health ---']);
      rows.push(['Terminal', 'Gate', 'Scans', 'Avg Confidence (%)', 'Liveness Pass Rate (%)', 'Spoof Attempts', 'Low-Conf Scans', 'Unknown Chaperone', 'Avg Retries']);
      data.byTerminal.forEach(t => rows.push([
        t.terminalId, t.gate, t.total,
        t.avgConfidence ?? '', t.livenessPassRate ?? '',
        t.spoof, t.lowConfidence, t.unknownChaperone,
        t.avgRetries ?? '',
      ]));
      rows.push([]);
    }
    if ((fr.lowConfidenceFlags || []).length) {
      rows.push(['--- Top Low-Confidence Events ---']);
      rows.push(['Date', 'Gate', 'Terminal', 'Chaperone', 'Confidence']);
      fr.lowConfidenceFlags.slice(0, 25).forEach(f => rows.push([f.at, f.gate, f.terminalId, f.chaperone, f.confidence]));
      rows.push([]);
    }
    if ((fr.spoofFlags || []).length) {
      rows.push(['--- Spoof Attempts ---']);
      rows.push(['Date', 'Gate', 'Terminal', 'Chaperone', 'Liveness Score']);
      fr.spoofFlags.forEach(f => rows.push([f.at, f.gate, f.terminalId, f.chaperone, f.livenessScore ?? '']));
      rows.push([]);
    }
  }
  rows.push(['--- Top Chaperones ---']);
  rows.push(['Name', 'Pickup Count']);
  (data.topChaperones || []).forEach(c => rows.push([c.name, c.total ?? c.count]));
  rows.push([]);
  rows.push(['--- Top Officers (Overrides) ---']);
  rows.push(['Officer', 'Override Count']);
  (data.topOfficers || []).forEach(o => rows.push([o.name, o.total]));
  rows.push([]);
  rows.push(['--- Recent Events ---']);
  rows.push(['Time (UTC)', 'Gate', 'Card State', 'Override', 'Officer', 'Chaperone', 'Note', 'Students']);
  (data.recent || []).forEach(r => rows.push([
    (r.at || '').replace('T', ' ').slice(0, 19),
    r.gate,
    r.cardState,
    r.isOverride ? 'YES' : 'no',
    r.officer || '',
    r.chaperone || '',
    r.note || '',
    (r.students || []).map(s => `${s.name}${s.homeroom ? ` (${s.homeroom})` : ''}`).join(' | '),
  ]));
  downloadCSV(`pickup-system-report-${fromDate}-to-${toDate}.csv`, rows);
}


export default function ReportsPage() {
  // Module toggle: 'attendance' | 'pickup'
  const [module, setModule] = useState('attendance');

  const [fromDate, setFromDate] = useState(getWIBDate(-6));
  const [toDate, setToDate] = useState(getWIBDate());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Pickup module state
  const [pickupData, setPickupData] = useState(null);
  const [pickupLoading, setPickupLoading] = useState(false);
  const [pickupError, setPickupError] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);

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

  const fetchPickupReport = useCallback(async () => {
    try {
      setPickupLoading(true);
      setPickupError(null);
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const res = await fetch(`/api/pickup/admin/analytics?${params}`, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setPickupData(await res.json());
    } catch (err) {
      setPickupError(err.message);
    } finally {
      setPickupLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    if (module === 'attendance') fetchReport();
    else fetchPickupReport();
  }, [module, fetchReport, fetchPickupReport]);

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

  // CSV export — full breakdown with metadata, daily, terminals, and class summary
  const exportCSV = useCallback(() => {
    if (!data) return;
    const generated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const rows = [];
    rows.push(['BINUS Facial Attendance — Detailed Report']);
    rows.push(['Date Range', `${fromDate} → ${toDate}`]);
    rows.push(['School Days With Data', `${data.range.daysWithData} of ${data.range.schoolDays}`]);
    rows.push(['Filters', `class=${filterClass || 'ALL'}, grade=${filterGrade || 'ALL'}, terminal=${filterSource || 'ALL'}`]);
    rows.push(['Generated At', generated]);
    rows.push(['Scan Cooldown', `${SCAN_COOLDOWN_HOURS} hours (one attendance per student per session)`]);
    rows.push([]);
    rows.push(['--- Summary ---']);
    rows.push(['Enrolled Students', data.summary.enrolledStudents]);
    rows.push(['Tracked Students', data.summary.totalStudents]);
    rows.push(['Total Scans', data.summary.totalScans]);
    rows.push(['On-Time Scans', data.summary.totalPresent, `${data.summary.presentRate}%`]);
    rows.push(['Late Scans', data.summary.totalLate, `${data.summary.lateRate}%`]);
    rows.push(['Avg Daily Attendance', data.summary.avgDailyAttendance]);
    rows.push([]);
    rows.push(['--- Per-Student ---']);
    rows.push(['Name', 'Student ID', 'Class', 'Grade', 'Days Present', 'Days Late', 'Days Absent', 'Attendance %', 'On-Time %']);
    [...data.studentRecords]
      .sort((a, b) => a.homeroom.localeCompare(b.homeroom) || a.name.localeCompare(b.name))
      .forEach((s) => rows.push([s.name, s.employeeNo, s.homeroom, s.grade, s.daysPresent, s.daysLate, s.daysAbsent, `${s.attendanceRate}%`, `${s.onTimeRate}%`]));
    rows.push([]);
    rows.push(['--- Class Summary ---']);
    rows.push(['Class', 'Grade', 'Enrolled', 'Tracked', 'Total Scans', 'Present', 'Late', 'Attendance %', 'On-Time %']);
    (data.classSummary || []).forEach((c) =>
      rows.push([c.homeroom, c.grade, c.enrolled, c.studentsTracked, c.totalScans, c.totalPresent, c.totalLate, `${c.attendanceRate}%`, `${c.onTimeRate}%`])
    );
    if (data.dailyBreakdown?.length || data.daily?.length) {
      rows.push([]);
      rows.push(['--- Daily Breakdown ---']);
      rows.push(['Date', 'Day', 'Total Scans', 'On-Time', 'Late']);
      (data.dailyBreakdown || data.daily || []).forEach((d) => {
        const dt = new Date((d.date || d.day) + 'T00:00:00Z');
        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()];
        rows.push([d.date || d.day, dow, d.totalScans ?? d.total ?? 0, d.present ?? d.onTime ?? 0, d.late ?? 0]);
      });
    }
    if (data.sourceSummary?.length) {
      rows.push([]);
      rows.push(['--- Terminal Breakdown ---']);
      rows.push(['Terminal', 'Total Scans', 'Unique Students', 'On-Time', 'Late', 'On-Time %']);
      data.sourceSummary.forEach((s) => rows.push([s.source, s.totalScans, s.uniqueStudents, s.present ?? 0, s.late ?? 0, `${s.presentRate ?? 0}%`]));
    }
    downloadCSV(`attendance-report-${fromDate}-to-${toDate}.csv`, rows);
  }, [data, fromDate, toDate, filterClass, filterGrade, filterSource]);

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

        {/* Print-only header (hidden on screen via .print-show) */}
        <div className="print-show hidden mb-4" style={{ borderBottom: '2px solid #8B1538', paddingBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div style={{ fontSize: '11px', letterSpacing: '0.1em', color: '#8B1538', fontWeight: 600 }}>BINUS SCHOOL SIMPRUG</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'black', marginTop: '2px' }}>
                {module === 'pickup' ? 'Pickup System Analytics Report' : 'Facial Attendance Report'}
              </div>
              <div style={{ fontSize: '11px', color: '#475569', marginTop: '4px' }}>
                Range: {fromDate} → {toDate}
                {module === 'attendance' && data && ` · ${data.range.daysWithData} of ${data.range.schoolDays} school days`}
                {module === 'pickup' && pickupData && ` · ${pickupData.range.totalDays} day(s) · ${pickupData.summary.totalPickups} pickups`}
              </div>
            </div>
            <div style={{ fontSize: '10px', color: '#64748b', textAlign: 'right' }}>
              Generated {new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC<br/>
              {module === 'attendance' && `Scan cooldown: ${SCAN_COOLDOWN_HOURS} hours per student`}
            </div>
          </div>
        </div>

        {/* Module toggle */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-900/80 border border-slate-800 w-fit no-print">
          <button
            onClick={() => setModule('attendance')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${module === 'attendance' ? 'bg-slate-800 text-white shadow-sm border border-slate-700' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
          >
            <i className="ph ph-fingerprint"></i>
            Facial Attendance
          </button>
          <button
            onClick={() => setModule('pickup')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${module === 'pickup' ? 'bg-orange-500/20 text-orange-200 shadow-sm border border-orange-500/40' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
          >
            <i className="ph ph-hand-waving"></i>
            Pickup System
          </button>
          <button
            onClick={() => setModule('forms')}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all ${module === 'forms' ? 'bg-emerald-500/20 text-emerald-200 shadow-sm border border-emerald-500/40' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
          >
            <i className="ph ph-clipboard-text"></i>
            Onboarding Forms
          </button>
        </div>

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <i className={`ph ${module === 'pickup' ? 'ph-hand-waving text-orange-400' : 'ph-file-text text-brand-500'}`}></i>
              <span className={`text-sm font-medium tracking-wide uppercase ${module === 'pickup' ? 'text-orange-400' : 'text-brand-500'}`}>
                {module === 'pickup' ? 'Pickup System Analytics' : 'Attendance Reports'}
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white print-title">
              {module === 'pickup' ? 'Pickup Analytics' : 'Attendance Report'}
            </h1>
            <p className="text-slate-400 mt-2 max-w-2xl">
              {module === 'pickup' ? (
                pickupData
                  ? <>Pickup events from <span className="text-white font-medium">{fmtDate(pickupData.range.from)}</span> to <span className="text-white font-medium">{fmtDate(pickupData.range.to)}</span> — <span className="text-white font-medium">{pickupData.summary.totalPickups}</span> total pickups</>
                  : 'Configure date range and view pickup activity.'
              ) : (
                data
                  ? <>Generate detailed reports from <span className="text-white font-medium">{fmtDate(data.range.from)}</span> to <span className="text-white font-medium">{fmtDate(data.range.to)}</span> — <span className="text-white font-medium">{data.range.daysWithData}</span> days of data</>
                  : 'Configure date range and filters below.'
              )}
            </p>
            {module === 'attendance' && (
              <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/70 border border-slate-800 text-xs text-slate-300 no-print">
                <i className="ph ph-timer text-brand-400"></i>
                <span>Each student can scan once per <span className="text-white font-semibold">{SCAN_COOLDOWN_HOURS}h</span> session — duplicates within this window are ignored.</span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 no-print">
            {module === 'attendance' && (
              <>
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
              </>
            )}
            {module === 'pickup' && (
              <>
                <button
                  onClick={() => setExportOpen(true)}
                  disabled={!pickupData}
                  className="flex items-center gap-2 px-4 py-2.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold border border-brand-400 disabled:opacity-50 shadow-[0_0_20px_rgba(6,182,212,0.3)]"
                >
                  <i className="ph ph-export text-lg"></i>
                  Export report…
                </button>
                <button
                  onClick={() => exportPickupCSV(pickupData, fromDate, toDate)}
                  disabled={!pickupData}
                  title="Quick CSV — single-shot, no parameters"
                  className="flex items-center gap-2 px-3 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium border border-slate-700 disabled:opacity-50"
                >
                  <i className="ph ph-file-csv text-lg"></i>
                  Quick CSV
                </button>
                <button
                  onClick={fetchPickupReport}
                  disabled={pickupLoading}
                  className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium border border-slate-700 disabled:opacity-50"
                >
                  <i className="ph ph-arrows-clockwise text-lg"></i>
                  Refresh
                </button>
              </>
            )}
          </div>
        </div>

        {/* ═══ PICKUP MODULE ═══ */}
        {module === 'pickup' && (
          <PickupAnalyticsView
            data={pickupData}
            loading={pickupLoading}
            error={pickupError}
            fromDate={fromDate}
            toDate={toDate}
            setFromDate={setFromDate}
            setToDate={setToDate}
            onRefresh={fetchPickupReport}
          />
        )}

        {/* ═══ ONBOARDING FORMS MODULE ═══ */}
        {module === 'forms' && (
          <OnboardingFormsView fromDate={fromDate} toDate={toDate}
            setFromDate={setFromDate} setToDate={setToDate} />
        )}

        {/* ═══ ATTENDANCE MODULE — everything below is unchanged ═══ */}
        {module === 'attendance' && (<>

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

        {/* end of attendance module */}
        </>)}
      </div>

      {/* ═══ TERMINAL DETAIL MODAL ═══ */}
      {module === 'attendance' && selectedTerminal && (() => {
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

      <PickupReportExportOverlay
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        defaultFrom={fromDate}
        defaultTo={toDate}
      />

    </V2Layout>
  );
}

// ── Pickup Analytics View ──────────────────────────────────────────────────────

function PickupAnalyticsView({ data, loading, error, fromDate, toDate, setFromDate, setToDate, onRefresh }) {
  const fmtDate = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  };

  const CARD_STATE_COLORS = {
    green:  { bg: 'bg-emerald-500/10 border-emerald-500/30', text: 'text-emerald-400', label: 'Authorized' },
    yellow: { bg: 'bg-amber-500/10 border-amber-500/30',   text: 'text-amber-400',   label: 'Conditional' },
    red:    { bg: 'bg-red-500/10 border-red-500/30',       text: 'text-red-400',      label: 'Restricted' },
  };

  return (
    <div className="space-y-6">
      {/* Date range picker */}
      <div className="glass-panel rounded-2xl border border-slate-800 p-5 no-print">
        <div className="flex flex-col sm:flex-row gap-4 items-end">
          <div>
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 block">Date Range</label>
            <div className="flex items-center gap-2">
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                className="bg-slate-900/80 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none" />
              <span className="text-slate-500">→</span>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                className="bg-slate-900/80 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:border-orange-500 focus:ring-1 focus:ring-orange-500 outline-none" />
            </div>
          </div>
          <button onClick={onRefresh} disabled={loading}
            className="flex items-center gap-2 px-4 py-2.5 bg-orange-500 hover:bg-orange-400 text-white rounded-lg text-sm font-semibold transition-all disabled:opacity-50">
            <i className="ph ph-arrows-clockwise"></i>
            {loading ? 'Loading…' : 'Fetch Report'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-5 py-4 text-red-300 text-sm flex items-center gap-3">
          <i className="ph ph-warning-circle text-xl"></i>
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="glass-panel rounded-2xl border border-slate-800 p-5 animate-pulse">
              <div className="h-3 w-1/2 bg-slate-800 rounded mb-4"></div>
              <div className="h-8 w-3/4 bg-slate-800 rounded"></div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Pickups', value: data.summary.totalPickups, icon: 'ph-hand-waving', color: 'text-orange-400 bg-orange-500/10 border-orange-500/30' },
              { label: 'Auto-Approved', value: data.summary.autoApproved, sub: data.summary.approvalRate + '% rate', icon: 'ph-check-circle', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
              { label: 'Officer Overridden', value: data.summary.officerOverridden, sub: data.summary.overrideRate + '% rate', icon: 'ph-shield-warning', color: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
              { label: 'Flagged (Red Card)', value: data.summary.flagged, icon: 'ph-flag', color: 'text-red-400 bg-red-500/10 border-red-500/30' },
            ].map((c) => (
              <div key={c.label} className={`glass-panel rounded-2xl border p-5 ${c.color}`}>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{c.label}</p>
                  <i className={`ph ${c.icon} text-lg`}></i>
                </div>
                <p className="text-3xl font-bold text-white">{c.value?.toLocaleString() ?? '—'}</p>
                {c.sub && <p className="text-xs text-slate-500 mt-1">{c.sub}</p>}
              </div>
            ))}
          </div>

          {/* Avg per day */}
          <div className="glass-panel rounded-2xl border border-slate-800 p-5">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1">Average Pickups / Day</p>
            <p className="text-2xl font-bold text-white">{data.summary.avgPerDay}</p>
            <p className="text-xs text-slate-500 mt-1">over {data.range.totalDays} day{data.range.totalDays !== 1 ? 's' : ''} ({fmtDate(data.range.from)} – {fmtDate(data.range.to)})</p>
          </div>

          {/* By Date chart */}
          {data.byDate?.length > 0 && (
            <div className="glass-panel rounded-2xl border border-slate-800 p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <i className="ph ph-chart-bar text-orange-400"></i>
                Daily Pickup Volume
              </h3>
              <div className="flex items-end gap-1 h-28">
                {data.byDate.map((d) => {
                  const max = Math.max(...data.byDate.map(x => x.total), 1);
                  const h = Math.round((d.total / max) * 100);
                  return (
                    <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                      <div className="w-full bg-orange-500/60 rounded-t hover:bg-orange-400/80 transition-colors cursor-default" style={{ height: `${Math.max(h, 4)}%` }}></div>
                      <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10">
                        {d.date}: {d.total}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-slate-600">
                <span>{fmtDate(data.byDate[0]?.date)}</span>
                <span>{fmtDate(data.byDate[data.byDate.length - 1]?.date)}</span>
              </div>
            </div>
          )}

          {/* By Gate + By Card State side by side */}
          <div className="grid lg:grid-cols-2 gap-5">
            {/* By Gate */}
            {data.byGate?.length > 0 && (
              <div className="glass-panel rounded-2xl border border-slate-800 p-5">
                <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                  <i className="ph ph-door text-orange-400"></i>
                  By Gate
                </h3>
                <div className="space-y-2">
                  {data.byGate.map((g) => {
                    const pct = data.summary.totalPickups > 0 ? Math.round((g.total / data.summary.totalPickups) * 100) : 0;
                    return (
                      <div key={g.gate}>
                        <div className="flex items-center justify-between text-xs mb-0.5">
                          <span className="text-slate-300 font-medium">{g.gate || 'Unknown'}</span>
                          <span className="text-slate-400">{g.total} <span className="text-slate-600">({pct}%)</span></span>
                        </div>
                        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-orange-500/60 rounded-full" style={{ width: `${pct}%` }}></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* By Card State */}
            <div className="glass-panel rounded-2xl border border-slate-800 p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <i className="ph ph-identification-card text-orange-400"></i>
                Card State Breakdown
              </h3>
              <div className="space-y-3">
                {Object.entries(data.byCardState || {}).map(([state, count]) => {
                  const cfg = CARD_STATE_COLORS[state] || CARD_STATE_COLORS.green;
                  const pct = data.summary.totalPickups > 0 ? Math.round((count / data.summary.totalPickups) * 100) : 0;
                  return (
                    <div key={state} className={`flex items-center justify-between px-4 py-3 rounded-xl border ${cfg.bg}`}>
                      <div className="flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full ${cfg.text.replace('text-', 'bg-')}`}></span>
                        <span className={`text-sm font-medium ${cfg.text}`}>{cfg.label}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-white font-bold text-lg">{count}</span>
                        <span className="text-slate-500 text-xs ml-1">({pct}%)</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* By Class */}
          {data.byClass?.length > 0 && (
            <div className="glass-panel rounded-2xl border border-slate-800 p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <i className="ph ph-users text-orange-400"></i>
                By Class
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 uppercase tracking-wider border-b border-slate-800">
                      <th className="pb-3 text-left pr-4">Class</th>
                      <th className="pb-3 text-right pr-4">Total</th>
                      <th className="pb-3 text-right pr-4">Auto-Approved</th>
                      <th className="pb-3 text-right">Overridden</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {data.byClass.map((c) => (
                      <tr key={c.class} className="hover:bg-white/5">
                        <td className="py-2.5 pr-4 font-medium text-white">{c.class || 'Unknown'}</td>
                        <td className="py-2.5 pr-4 text-right text-slate-300">{c.total}</td>
                        <td className="py-2.5 pr-4 text-right text-emerald-400">{c.autoApproved}</td>
                        <td className="py-2.5 text-right text-amber-400">{c.overridden}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Top Chaperones + Top Officers side by side */}
          <div className="grid lg:grid-cols-2 gap-5">
            {data.topChaperones?.length > 0 && (
              <div className="glass-panel rounded-2xl border border-slate-800 p-5">
                <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                  <i className="ph ph-person text-orange-400"></i>
                  Top Chaperones
                </h3>
                <div className="space-y-2">
                  {data.topChaperones.map((c, i) => (
                    <div key={c.name} className="flex items-center gap-3 py-2 border-b border-slate-800/40 last:border-0">
                      <span className="text-xs font-bold text-slate-600 w-5">{i + 1}</span>
                      <span className="flex-1 text-slate-200 text-sm">{c.name}</span>
                      <span className="text-sm font-semibold text-orange-300">{c.total ?? c.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.topOfficers?.length > 0 && (
              <div className="glass-panel rounded-2xl border border-slate-800 p-5">
                <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                  <i className="ph ph-shield-check text-amber-400"></i>
                  Top Officers (Manual Overrides)
                </h3>
                <div className="space-y-2">
                  {data.topOfficers.map((o, i) => (
                    <div key={o.name} className="flex items-center gap-3 py-2 border-b border-slate-800/40 last:border-0">
                      <span className="text-xs font-bold text-slate-600 w-5">{i + 1}</span>
                      <span className="flex-1 text-slate-200 text-sm">{o.name}</span>
                      <span className="text-sm font-semibold text-amber-300">{o.total}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Peak Hours (24-hour distribution, WIB) */}
          {data.byHour?.some(h => h.total > 0) && (
            <div className="glass-panel rounded-2xl border border-slate-800 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <i className="ph ph-clock-countdown text-orange-400"></i>
                  Peak Hours (WIB)
                </h3>
                {data.peakHour && (
                  <span className="text-xs text-slate-400">
                    Busiest: <span className="text-orange-300 font-medium">{String(data.peakHour.hour).padStart(2, '0')}:00</span> · {data.peakHour.count} pickups
                  </span>
                )}
              </div>
              <div className="flex items-end gap-1 h-32">
                {data.byHour.map((h, i) => {
                  const max = Math.max(...data.byHour.map(x => x.total), 1);
                  const pct = Math.round((h.total / max) * 100);
                  const overridePct = h.total > 0 ? Math.round((h.overridden / h.total) * 100) : 0;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                      <div className="w-full bg-orange-500/60 rounded-t hover:bg-orange-400/80 transition-colors cursor-default" style={{ height: `${Math.max(pct, h.total > 0 ? 4 : 0)}%` }}>
                        {h.overridden > 0 && (
                          <div className="w-full bg-amber-400/80 rounded-t" style={{ height: `${overridePct}%` }}></div>
                        )}
                      </div>
                      <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10">
                        {String(i).padStart(2, '0')}:00 — {h.total} ({h.overridden} ovr)
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 grid grid-cols-12 text-[10px] text-slate-600">
                {[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map(h => (
                  <span key={h} className="text-center">{String(h).padStart(2, '0')}</span>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-4 text-[10px] text-slate-500">
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-orange-500/60"></span> Pickups</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-amber-400/80"></span> Officer override</span>
              </div>
            </div>
          )}

          {/* ── Facial-Recognition Signals ─────────────────────────────── */}
          {data.fr && (data.fr.sample > 0 || (data.fr.spoofAttempts ?? 0) > 0) && (
            <div className="glass-panel rounded-2xl border border-slate-800 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <i className="ph ph-scan text-orange-400"></i>
                  Facial-Recognition Signals
                </h3>
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">{data.fr.sample} scans w/ FR data</span>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-300/70">Avg Confidence</p>
                  <p className="text-2xl font-bold text-white mt-1">{data.fr.confidence?.avg ?? '—'}<span className="text-base text-emerald-300/60">%</span></p>
                  <p className="text-[10px] text-slate-500 mt-1">range {data.fr.confidence?.min ?? '—'}% – {data.fr.confidence?.max ?? '—'}%</p>
                </div>
                <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-4">
                  <p className="text-[10px] uppercase tracking-wider text-sky-300/70">Liveness Pass Rate</p>
                  <p className="text-2xl font-bold text-white mt-1">{data.fr.liveness?.passRate ?? '—'}<span className="text-base text-sky-300/60">%</span></p>
                  <p className="text-[10px] text-slate-500 mt-1">{data.fr.liveness?.passed ?? 0}/{data.fr.liveness?.checked ?? 0} checks</p>
                </div>
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                  <p className="text-[10px] uppercase tracking-wider text-red-300/70">Spoof Attempts</p>
                  <p className="text-2xl font-bold text-white mt-1">{data.fr.spoofAttempts ?? 0}</p>
                  <p className="text-[10px] text-slate-500 mt-1">{data.fr.unknownChaperone ?? 0} unknown chaperones</p>
                </div>
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <p className="text-[10px] uppercase tracking-wider text-amber-300/70">Low-Confidence</p>
                  <p className="text-2xl font-bold text-white mt-1">{data.fr.lowConfidence ?? 0}</p>
                  <p className="text-[10px] text-slate-500 mt-1">avg retries {data.fr.retriesAvg ?? '—'}</p>
                </div>
              </div>
              {data.fr.confidence?.distribution && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Confidence Distribution</p>
                  <div className="flex h-6 rounded-lg overflow-hidden border border-slate-800">
                    {[
                      { key: 'below50', label: '<50%', color: 'bg-red-500/70' },
                      { key: '50to70',  label: '50-70%', color: 'bg-amber-500/70' },
                      { key: '70to90',  label: '70-90%', color: 'bg-sky-500/70' },
                      { key: 'above90', label: '≥90%', color: 'bg-emerald-500/70' },
                    ].map((b) => {
                      const v = data.fr.confidence.distribution[b.key] || 0;
                      const total = data.fr.sample || 1;
                      const pct = (v / total) * 100;
                      return v > 0 ? (
                        <div key={b.key} className={`${b.color} flex items-center justify-center text-[10px] font-bold text-white`} style={{ width: `${pct}%` }} title={`${b.label}: ${v} scans`}>
                          {pct >= 8 ? `${v}` : ''}
                        </div>
                      ) : null;
                    })}
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                    <span>0%</span><span>50%</span><span>70%</span><span>90%</span><span>100%</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Per-Terminal Recognition Health ─────────────────────────── */}
          {(data.byTerminal || []).length > 0 && (
            <div className="glass-panel rounded-2xl border border-slate-800 p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <i className="ph ph-monitor text-orange-400"></i>
                Per-Terminal Recognition Health
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-800">
                      <th className="pb-2 pr-4 text-left">Terminal · Gate</th>
                      <th className="pb-2 pr-4 text-right">Scans</th>
                      <th className="pb-2 pr-4 text-right">Avg Conf.</th>
                      <th className="pb-2 pr-4 text-right">Liveness</th>
                      <th className="pb-2 pr-4 text-right">Spoof</th>
                      <th className="pb-2 pr-4 text-right">Low-Conf</th>
                      <th className="pb-2 pr-4 text-right">Unknown</th>
                      <th className="pb-2 text-right">Retries</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {data.byTerminal.map((t) => {
                      const confTone = (t.avgConfidence ?? 100) >= 90 ? 'text-emerald-400'
                        : (t.avgConfidence ?? 0) >= 70 ? 'text-amber-400' : 'text-red-400';
                      const liveTone = (t.livenessPassRate ?? 100) >= 95 ? 'text-emerald-400'
                        : (t.livenessPassRate ?? 0) >= 80 ? 'text-amber-400' : 'text-red-400';
                      return (
                        <tr key={t.terminalId} className="hover:bg-white/5">
                          <td className="py-2.5 pr-4">
                            <div className="text-white font-medium">{t.gate}</div>
                            <div className="font-mono text-[10px] text-slate-500">{t.terminalId}</div>
                          </td>
                          <td className="py-2.5 pr-4 text-right text-slate-200">{t.total}</td>
                          <td className={`py-2.5 pr-4 text-right font-mono ${confTone}`}>{t.avgConfidence != null ? `${t.avgConfidence}%` : '—'}</td>
                          <td className={`py-2.5 pr-4 text-right font-mono ${liveTone}`}>{t.livenessPassRate != null ? `${t.livenessPassRate}%` : '—'}</td>
                          <td className="py-2.5 pr-4 text-right text-red-400">{t.spoof || ''}</td>
                          <td className="py-2.5 pr-4 text-right text-amber-400">{t.lowConfidence || ''}</td>
                          <td className="py-2.5 pr-4 text-right text-slate-400">{t.unknownChaperone || ''}</td>
                          <td className="py-2.5 text-right font-mono text-slate-400">{t.avgRetries ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Low-Confidence Flags / Spoof Attempts ───────────────────── */}
          {((data.fr?.lowConfidenceFlags || []).length > 0 || (data.fr?.spoofFlags || []).length > 0) && (
            <div className="grid lg:grid-cols-2 gap-5">
              {(data.fr?.lowConfidenceFlags || []).length > 0 && (
                <div className="glass-panel rounded-2xl border border-amber-500/20 p-5">
                  <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <i className="ph ph-warning-octagon text-amber-400"></i>
                    Top Low-Confidence Scans
                  </h3>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto">
                    {data.fr.lowConfidenceFlags.slice(0, 12).map((f, i) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-900/40 border border-slate-800">
                        <span className="font-mono text-[10px] text-slate-500 w-20 flex-shrink-0">{f.at}</span>
                        <span className="flex-1 truncate text-slate-200 text-xs">{f.chaperone || '—'}</span>
                        <span className="text-[10px] text-slate-500 truncate max-w-[100px]">{f.gate}</span>
                        <span className="font-mono text-amber-300 font-semibold text-xs">{(f.confidence * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(data.fr?.spoofFlags || []).length > 0 && (
                <div className="glass-panel rounded-2xl border border-red-500/20 p-5">
                  <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <i className="ph ph-shield-warning text-red-400"></i>
                    Spoof Attempts
                  </h3>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto">
                    {data.fr.spoofFlags.slice(0, 12).map((f, i) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/20">
                        <span className="font-mono text-[10px] text-slate-500 w-20 flex-shrink-0">{f.at}</span>
                        <span className="flex-1 truncate text-slate-200 text-xs">{f.chaperone || '—'}</span>
                        <span className="text-[10px] text-slate-500 truncate max-w-[100px]">{f.gate}</span>
                        <span className="font-mono text-red-300 font-semibold text-xs">live {(f.livenessScore != null ? (f.livenessScore * 100).toFixed(0) + '%' : '—')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Recent Events */}
          {data.recent?.length > 0 && (
            <div className="glass-panel rounded-2xl border border-slate-800 p-5 print-break-inside-avoid">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <i className="ph ph-list-bullets text-orange-400"></i>
                  Recent Pickup Events
                </h3>
                <span className="text-xs text-slate-500">last {Math.min(data.recent.length, 25)} of {data.recent.length}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 uppercase tracking-wider border-b border-slate-800">
                      <th className="pb-3 text-left pr-4">Time (WIB)</th>
                      <th className="pb-3 text-left pr-4">Gate</th>
                      <th className="pb-3 text-left pr-4">Card</th>
                      <th className="pb-3 text-left pr-4">Chaperone</th>
                      <th className="pb-3 text-left pr-4">Students</th>
                      <th className="pb-3 text-left">Note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {data.recent.slice(0, 25).map((r) => {
                      const wib = r.at ? new Date(new Date(r.at).getTime() + 7 * 3600 * 1000).toISOString().slice(11, 19) : '—';
                      const cfg = CARD_STATE_COLORS[r.cardState] || CARD_STATE_COLORS.green;
                      return (
                        <tr key={r.id} className="hover:bg-white/5">
                          <td className="py-2 pr-4 font-mono text-xs text-slate-300">{wib}</td>
                          <td className="py-2 pr-4 text-slate-300">{r.gate}</td>
                          <td className="py-2 pr-4">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${cfg.bg} ${cfg.text}`}>
                              {r.isOverride && <i className="ph ph-shield-warning"></i>}
                              {cfg.label}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-slate-200">{r.chaperone || <span className="text-slate-600">—</span>}</td>
                          <td className="py-2 pr-4 text-slate-300 text-xs">
                            {(r.students || []).map(s => s.name + (s.homeroom ? ` (${s.homeroom})` : '')).join(', ') || <span className="text-slate-600">—</span>}
                          </td>
                          <td className="py-2 text-slate-400 text-xs">{r.note || (r.officer ? `via ${r.officer}` : '')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Onboarding Forms — filterable export of pickup_onboarding submissions.
// ═════════════════════════════════════════════════════════════════════════════
function OnboardingFormsView({ fromDate, toDate, setFromDate, setToDate }) {
  const [status, setStatus] = useState('all');
  const [grade, setGrade] = useState('');
  const [homeroom, setHomeroom] = useState('');
  const [studentId, setStudentId] = useState('');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('school'); // school | grade | individual
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchForms = async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (scope === 'grade' && grade) params.set('grade', grade);
      if (scope === 'individual') {
        if (studentId.trim()) params.set('studentId', studentId.trim());
        if (homeroom.trim()) params.set('homeroom', homeroom.trim());
      }
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      const r = await fetch(`/api/pickup/admin/forms-export?${params.toString()}`, { credentials: 'include' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || 'fetch failed');
      setData(j);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchForms(); /* eslint-disable-next-line */ }, []);

  const filtered = (data?.records || []).filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const hay = [
      r.guardian?.name, r.guardian?.email, r.guardian?.phone,
      ...(r.students || []).flatMap((s) => [s.name, s.id, s.homeroom]),
      ...(r.chaperones || []).flatMap((c) => [c.name, c.phone, c.email, c.idNumber]),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  const totals = useMemo(() => {
    const t = { records: filtered.length, students: 0, chaperones: 0, pending: 0, approved: 0, rejected: 0 };
    filtered.forEach((r) => {
      t.students += (r.students || []).length;
      t.chaperones += (r.chaperones || []).length;
      if (r.status === 'pending') t.pending += 1;
      if (r.status === 'approved') t.approved += 1;
      if (r.status === 'rejected') t.rejected += 1;
    });
    return t;
  }, [filtered]);

  const exportCSV = () => {
    if (!filtered.length) return;
    const rows = [[
      'Form ID', 'Status', 'Submitted', 'Reviewed', 'Reviewer',
      'Guardian Name', 'Guardian Email', 'Guardian Phone',
      'Student ID', 'Student Name', 'Homeroom',
      'Chaperone Name', 'Relation', 'Chaperone Phone', 'Chaperone Email',
      'Chaperone ID#', 'Allocated Employee No', 'Face Photos',
    ]];
    filtered.forEach((r) => {
      const students = r.students.length ? r.students : [{}];
      const chaperones = r.chaperones.length ? r.chaperones : [{}];
      students.forEach((s) => {
        chaperones.forEach((c) => {
          rows.push([
            r.id, r.status, r.submittedAt || '', r.reviewedAt || '', r.reviewedBy || '',
            r.guardian?.name || '', r.guardian?.email || '', r.guardian?.phone || '',
            s.id || '', s.name || '', s.homeroom || '',
            c.name || '', c.relation || '', c.phone || '', c.email || '',
            c.idNumber || '', c.allocatedId || '', c.faceCount || 0,
          ]);
        });
      });
    });
    const scopeLabel = scope === 'school' ? 'whole-school'
      : scope === 'grade' ? `grade-${grade || 'any'}`
      : 'individual';
    downloadCSV(`onboarding-forms_${scopeLabel}_${fromDate}_to_${toDate}.csv`, rows);
  };

  const handlePrint = () => window.print();

  const FilterPill = ({ value, label, current, onClick }) => (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
        current === value
          ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200'
          : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800'
      }`}>{label}</button>
  );

  return (
    <div className="space-y-5">
      {/* Filter panel */}
      <div className="glass-panel rounded-2xl border border-slate-800 p-5 no-print space-y-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Scope</div>
          <div className="flex flex-wrap gap-2">
            <FilterPill value="school" label="Whole school" current={scope} onClick={() => setScope('school')} />
            <FilterPill value="grade" label="By grade" current={scope} onClick={() => setScope('grade')} />
            <FilterPill value="individual" label="Individual / homeroom" current={scope} onClick={() => setScope('individual')} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {scope === 'grade' && (
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">Grade</label>
              <select value={grade} onChange={(e) => setGrade(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                <option value="">— pick a grade —</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
                  <option key={g} value={g}>Grade {g}</option>
                ))}
              </select>
            </div>
          )}

          {scope === 'individual' && (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Student ID</label>
                <input value={studentId} onChange={(e) => setStudentId(e.target.value)}
                  placeholder="e.g. BIN12345"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Homeroom</label>
                <input value={homeroom} onChange={(e) => setHomeroom(e.target.value)}
                  placeholder="e.g. 4C"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 uppercase" />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Submitted from</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Submitted to</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
          </div>
        </div>

        <div className="flex flex-wrap gap-3 items-center">
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search inside results (name / phone / email)…"
            className="flex-1 min-w-[220px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600" />
          <button onClick={fetchForms} disabled={loading}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium border border-slate-700 disabled:opacity-50">
            <i className="ph ph-arrows-clockwise mr-1"></i>{loading ? 'Loading…' : 'Apply filters'}
          </button>
          <button onClick={exportCSV} disabled={!filtered.length}
            className="px-4 py-2 bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30 rounded-lg text-sm font-medium disabled:opacity-50">
            <i className="ph ph-file-csv mr-1"></i>Download CSV ({filtered.length})
          </button>
          <button onClick={handlePrint} disabled={!filtered.length}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-lg text-sm font-semibold disabled:opacity-50">
            <i className="ph ph-printer mr-1"></i>Print
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 print-section">
        {[
          { label: 'Forms', value: totals.records, color: 'text-white' },
          { label: 'Students', value: totals.students, color: 'text-brand-300' },
          { label: 'Chaperones', value: totals.chaperones, color: 'text-orange-300' },
          { label: 'Pending', value: totals.pending, color: 'text-amber-300' },
          { label: 'Approved', value: totals.approved, color: 'text-emerald-300' },
          { label: 'Rejected', value: totals.rejected, color: 'text-red-300' },
        ].map((t) => (
          <div key={t.label} className="glass-panel rounded-xl border border-slate-800 px-4 py-3">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{t.label}</div>
            <div className={`text-2xl font-bold ${t.color} mt-0.5`}>{t.value}</div>
          </div>
        ))}
      </div>

      {/* Results table */}
      <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden print-section">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white"><i className="ph ph-list-checks mr-1.5"></i>Submissions</h3>
          <span className="text-xs text-slate-400">{filtered.length} of {data?.total || 0}</span>
        </div>
        {error && <div className="p-4 text-sm text-red-300">{error}</div>}
        {loading && <div className="p-6 text-center text-sm text-slate-400">Loading…</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="p-10 text-center text-slate-500">
            <i className="ph ph-tray text-4xl mb-2 block"></i>No matching submissions.
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Submitted</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Guardian</th>
                  <th className="text-left px-3 py-2">Students</th>
                  <th className="text-left px-3 py-2">Chaperones</th>
                  <th className="text-left px-3 py-2">Reviewer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30">
                    <td className="px-3 py-2 text-xs text-slate-300 whitespace-nowrap">
                      {r.submittedAt ? fmtDate(r.submittedAt.slice(0, 10)) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded border ${
                        r.status === 'approved' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : r.status === 'rejected' ? 'bg-red-500/15 text-red-300 border-red-500/30'
                        : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      }`}>{r.status}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="text-white font-medium">{r.guardian?.name || '—'}</div>
                      <div className="text-slate-500">{r.guardian?.email || r.guardian?.phone || ''}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.students.map((s) => (
                        <div key={s.id} className="text-slate-300">
                          {s.name} <span className="text-slate-500 font-mono">({s.homeroom || '—'})</span>
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.chaperones.map((c, i) => (
                        <div key={i} className="text-slate-300">
                          {c.name} <span className="text-slate-500">· {c.relation}</span>
                          {c.allocatedId && <span className="ml-1 font-mono text-emerald-400">#{c.allocatedId.slice(-6)}</span>}
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                      {r.reviewedBy || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
