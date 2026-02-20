/**
 * /attendance-monitor — BINUS Attendance Log Monitor
 *
 * Queries the BINUS School API (D.2) to view attendance records that
 * were pushed to their system. Compares with our local Firestore data
 * to verify sync status.
 *
 * Features:
 *   - Date range picker (defaults to today)
 *   - Optional student ID / Binusian ID filter
 *   - Stats cards: total records, unique students, date breakdown
 *   - Searchable & sortable results table
 *   - Sync comparison with local Firestore attendance data
 *   - Export to CSV
 */

import Head from 'next/head';
import Link from 'next/link';
import React, { useState, useCallback, useEffect } from 'react';
import styles from '../styles/attendance-monitor.module.css';

function getWIBDate(offset = 0) {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  now.setDate(now.getDate() + offset);
  return now.toISOString().slice(0, 10);
}

export default function AttendanceMonitor() {
  // Query state
  const [startDate, setStartDate] = useState(getWIBDate(0));
  const [endDate, setEndDate] = useState(getWIBDate(0));
  const [idStudent, setIdStudent] = useState('');
  const [idBinusian, setIdBinusian] = useState('');

  // Results
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [dateRange, setDateRange] = useState(null);
  const [error, setError] = useState('');

  // Local sync comparison
  const [localRecords, setLocalRecords] = useState([]);
  const [loadingLocal, setLoadingLocal] = useState(false);

  // Table state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState('transactionDate');
  const [sortDir, setSortDir] = useState('desc');
  const [showSyncOnly, setShowSyncOnly] = useState(false);

  // Quick range buttons
  const setQuickRange = (days) => {
    setStartDate(getWIBDate(-days));
    setEndDate(getWIBDate(0));
  };

  // Fetch BINUS logs
  const fetchLogs = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/attendance/binus-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate,
          endDate,
          idStudent: idStudent.trim() || undefined,
          idBinusian: idBinusian.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch logs');
      setRecords(data.records || []);
      setTotalRecords(data.totalRecords || 0);
      setDateRange(data.dateRange || null);
    } catch (err) {
      setError(err.message);
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, idStudent, idBinusian]);

  // Fetch local Firestore attendance for comparison
  const fetchLocal = useCallback(async () => {
    setLoadingLocal(true);
    try {
      const res = await fetch(`/api/attendance/today?date=${startDate}`);
      const data = await res.json();
      if (data.records) {
        setLocalRecords(data.records);
      }
    } catch {
      // Non-critical
    } finally {
      setLoadingLocal(false);
    }
  }, [startDate]);

  // Build sync map: studentId -> local attendance record
  const localMap = React.useMemo(() => {
    const map = new Map();
    localRecords.forEach(r => {
      if (r.studentId) map.set(r.studentId, r);
    });
    return map;
  }, [localRecords]);

  // Filter & sort records
  const displayRecords = React.useMemo(() => {
    let filtered = [...records];

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(r =>
        r.idStudent.toLowerCase().includes(q) ||
        r.idBinusian.toLowerCase().includes(q) ||
        r.date.includes(q) ||
        r.time.includes(q) ||
        r.userIn.toLowerCase().includes(q)
      );
    }

    // Sync filter
    if (showSyncOnly) {
      filtered = filtered.filter(r => !localMap.has(r.idStudent));
    }

    // Sort
    filtered.sort((a, b) => {
      let va = a[sortField] || '';
      let vb = b[sortField] || '';
      if (sortDir === 'asc') return va.localeCompare(vb);
      return vb.localeCompare(va);
    });

    return filtered;
  }, [records, searchQuery, sortField, sortDir, showSyncOnly, localMap]);

  // Stats
  const stats = React.useMemo(() => {
    const uniqueStudents = new Set(records.map(r => r.idStudent).filter(Boolean));
    const dateCounts = {};
    records.forEach(r => {
      if (r.date) dateCounts[r.date] = (dateCounts[r.date] || 0) + 1;
    });
    const localMatched = records.filter(r => localMap.has(r.idStudent)).length;
    return {
      total: records.length,
      uniqueStudents: uniqueStudents.size,
      dates: Object.entries(dateCounts).sort(([a], [b]) => b.localeCompare(a)),
      localMatched,
      localOnly: localRecords.length,
      syncRate: records.length > 0
        ? Math.round((localMatched / records.length) * 100)
        : 0,
    };
  }, [records, localMap, localRecords]);

  // Export CSV
  const exportCSV = () => {
    if (displayRecords.length === 0) return;
    const headers = ['Student ID', 'Binusian ID', 'Date', 'Time', 'User In', 'Status', 'Image Desc'];
    const rows = displayRecords.map(r => [
      r.idStudent, r.idBinusian, r.date, r.time, r.userIn,
      r.stsrc ? 'OK' : 'Error', r.imageDesc,
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `binus-attendance-${startDate}-to-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Column sort handler
  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sortIcon = (field) => {
    if (sortField !== field) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  return (
    <>
      <Head>
        <title>Attendance Monitor — BINUS School Simprug</title>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>

      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <h1>📋 BINUS Attendance Log Monitor</h1>
          <div className={styles.headerActions}>
            <Link href="/dashboard" className={styles.navLink}>📊 Dashboard</Link>
            <Link href="/hikvision" className={styles.navLink}>🔐 Hikvision</Link>
            <Link href="/mobile-enrollment" className={styles.navLink}>📱 Mobile</Link>
            <Link href="/" className={styles.navLink}>📸 Capture</Link>
          </div>
        </div>

        {/* Query Panel */}
        <div className={styles.panel}>
          <h2>🔍 Query Attendance Logs</h2>
          <p className={styles.subtext}>
            Fetch records from the BINUS School API to verify what was pushed by our system.
          </p>

          <div className={styles.queryGrid}>
            <div className={styles.field}>
              <label>Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className={styles.input}
              />
            </div>
            <div className={styles.field}>
              <label>End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className={styles.input}
              />
            </div>
            <div className={styles.field}>
              <label>Student ID <span className={styles.optional}>(optional)</span></label>
              <input
                type="text"
                placeholder="e.g. 2570010037"
                value={idStudent}
                onChange={e => setIdStudent(e.target.value)}
                className={styles.input}
              />
            </div>
            <div className={styles.field}>
              <label>Binusian ID <span className={styles.optional}>(optional)</span></label>
              <input
                type="text"
                placeholder="e.g. BN001234"
                value={idBinusian}
                onChange={e => setIdBinusian(e.target.value)}
                className={styles.input}
              />
            </div>
          </div>

          {/* Quick range buttons */}
          <div className={styles.quickRange}>
            <span>Quick:</span>
            <button onClick={() => setQuickRange(0)} className={styles.chipBtn}>Today</button>
            <button onClick={() => setQuickRange(1)} className={styles.chipBtn}>Last 2 days</button>
            <button onClick={() => setQuickRange(6)} className={styles.chipBtn}>Last 7 days</button>
            <button onClick={() => setQuickRange(13)} className={styles.chipBtn}>Last 14 days</button>
            <button onClick={() => setQuickRange(29)} className={styles.chipBtn}>Last 30 days</button>
          </div>

          <div className={styles.actions}>
            <button
              onClick={() => { fetchLogs(); fetchLocal(); }}
              disabled={loading}
              className={styles.primaryBtn}
            >
              {loading ? '⏳ Fetching...' : '🔍 Fetch Logs'}
            </button>
            {records.length > 0 && (
              <button onClick={exportCSV} className={styles.secondaryBtn}>
                📥 Export CSV
              </button>
            )}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className={styles.errorBanner}>
            ❌ {error}
          </div>
        )}

        {/* Stats Cards */}
        {records.length > 0 && (
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{stats.total}</div>
              <div className={styles.statLabel}>Total Records</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{stats.uniqueStudents}</div>
              <div className={styles.statLabel}>Unique Students</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{stats.dates.length}</div>
              <div className={styles.statLabel}>Active Days</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{stats.localMatched}</div>
              <div className={styles.statLabel}>Matched Local</div>
            </div>
            <div className={`${styles.statCard} ${stats.syncRate === 100 ? styles.statGood : stats.syncRate >= 80 ? styles.statWarn : styles.statBad}`}>
              <div className={styles.statValue}>{stats.syncRate}%</div>
              <div className={styles.statLabel}>Sync Rate</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{stats.localOnly}</div>
              <div className={styles.statLabel}>Local Records</div>
            </div>
          </div>
        )}

        {/* Date Breakdown */}
        {stats.dates.length > 1 && (
          <div className={styles.panel}>
            <h3>📅 Records by Date</h3>
            <div className={styles.dateBreakdown}>
              {stats.dates.map(([date, count]) => (
                <div key={date} className={styles.dateChip}>
                  <span className={styles.dateLabel}>{date}</span>
                  <span className={styles.dateCount}>{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Results Table */}
        {records.length > 0 && (
          <div className={styles.panel}>
            <div className={styles.tableHeader}>
              <h3>📄 Attendance Records ({displayRecords.length}{displayRecords.length !== records.length ? ` / ${records.length}` : ''})</h3>
              <div className={styles.tableControls}>
                <input
                  type="text"
                  placeholder="Search by ID, date, time..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                />
                <label className={styles.filterToggle}>
                  <input
                    type="checkbox"
                    checked={showSyncOnly}
                    onChange={e => setShowSyncOnly(e.target.checked)}
                  />
                  Show unmatched only
                </label>
              </div>
            </div>

            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th onClick={() => toggleSort('idStudent')} className={styles.sortable}>
                      Student ID {sortIcon('idStudent')}
                    </th>
                    <th onClick={() => toggleSort('idBinusian')} className={styles.sortable}>
                      Binusian ID {sortIcon('idBinusian')}
                    </th>
                    <th onClick={() => toggleSort('date')} className={styles.sortable}>
                      Date {sortIcon('date')}
                    </th>
                    <th onClick={() => toggleSort('time')} className={styles.sortable}>
                      Time {sortIcon('time')}
                    </th>
                    <th>Status</th>
                    <th>Pushed By</th>
                    <th>Local Match</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRecords.map((r, i) => {
                    const matched = localMap.has(r.idStudent);
                    return (
                      <tr key={i} className={matched ? '' : styles.unmatchedRow}>
                        <td className={styles.rowNum}>{i + 1}</td>
                        <td className={styles.mono}>{r.idStudent || '—'}</td>
                        <td className={styles.mono}>{r.idBinusian || '—'}</td>
                        <td>{r.date}</td>
                        <td className={styles.mono}>{r.time}</td>
                        <td>
                          <span className={r.stsrc ? styles.badgeOk : styles.badgeFail}>
                            {r.stsrc ? '✓ OK' : '✗ Err'}
                          </span>
                        </td>
                        <td className={styles.mono}>{r.userIn}</td>
                        <td>
                          <span className={matched ? styles.badgeOk : styles.badgeMissing}>
                            {matched ? '✓ Synced' : '— Not found'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {displayRecords.length === 0 && searchQuery && (
              <div className={styles.emptyState}>No records match &ldquo;{searchQuery}&rdquo;</div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!loading && records.length === 0 && !error && (
          <div className={styles.emptyPanel}>
            <div className={styles.emptyIcon}>📋</div>
            <h3>No Records Loaded</h3>
            <p>Select a date range and click <strong>Fetch Logs</strong> to query the BINUS attendance API.</p>
          </div>
        )}

        {/* Footer */}
        <div className={styles.footer}>
          <p>
            Data sourced from BINUS School API (D.2 — bss-get-simprug-attendance-fr).
            Local comparison uses Firestore attendance records.
          </p>
          <p>© 2026 BINUS School Simprug AI Club</p>
        </div>
      </div>
    </>
  );
}
