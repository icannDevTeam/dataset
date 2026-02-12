/**
 * /dashboard — Real-time Attendance Dashboard
 *
 * Displays today's attendance records from Firestore (populated by
 * the Python attendance_listener.py running on the Jetson).
 *
 * Features:
 *   - Auto-refresh every 10 seconds
 *   - Today's summary stats (present, late, absent)
 *   - Student attendance list with timestamps
 *   - Date picker for historical view
 *   - Device connection status
 */

import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect, useCallback, useRef } from 'react';
import styles from '../styles/dashboard.module.css';

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
  const prevRecordCount = useRef(0);

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
        // New attendance detected — could trigger notification
      }
      prevRecordCount.current = data.records.length;

      setRecords(data.records);
      setSummary(data.summary);
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

  return (
    <>
      <Head>
        <title>Attendance Dashboard — BINUS</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={styles.page}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.title}>📊 Attendance Dashboard</h1>
            <span className={styles.subtitle}>BINUS Facial Recognition</span>
          </div>
          <div className={styles.headerRight}>
            <span className={styles.clock}>{clock}</span>
            <span className={styles.timezone}>WIB</span>
          </div>
        </header>

        {/* Navigation */}
        <nav className={styles.nav}>
          <Link href="/" className={styles.navLink}>📷 Capture</Link>
          <Link href="/hikvision" className={styles.navLink}>🔐 Enrollment</Link>
          <span className={`${styles.navLink} ${styles.navActive}`}>📊 Dashboard</span>
          <div className={styles.navSpacer} />

          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={styles.datePicker}
          />
          {!isToday && (
            <button className={styles.todayBtn} onClick={() => setDate(getWIBDate())}>
              Today
            </button>
          )}

          <button
            className={`${styles.refreshBtn} ${autoRefresh ? styles.active : ''}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            title={autoRefresh ? 'Auto-refresh ON (10s)' : 'Auto-refresh OFF'}
          >
            {autoRefresh ? '🔄' : '⏸️'}
          </button>

          <button
            className={styles.settingsBtn}
            onClick={() => setShowSettings(!showSettings)}
            title="Device Settings"
          >
            ⚙️
          </button>
        </nav>

        {/* Settings panel */}
        {showSettings && (
          <div className={styles.settingsPanel}>
            <h3>Device Connection</h3>
            <p className={styles.settingsHint}>
              Connect to device to see absent students list
            </p>
            <div className={styles.settingsRow}>
              <input
                placeholder="Device IP"
                value={credentials.ip}
                onChange={(e) => setCredentials({ ...credentials, ip: e.target.value })}
                className={styles.settingsInput}
              />
              <input
                placeholder="Username"
                value={credentials.username}
                onChange={(e) => setCredentials({ ...credentials, username: e.target.value })}
                className={styles.settingsInput}
              />
              <input
                type="password"
                placeholder="Password"
                value={credentials.password}
                onChange={(e) => setCredentials({ ...credentials, password: e.target.value })}
                className={styles.settingsInput}
              />
              <button onClick={saveCredentials} className={styles.settingsSave}>
                Connect
              </button>
            </div>
            {deviceConnected === true && (
              <span className={styles.deviceOk}>✓ Connected · {enrolled.length} enrolled</span>
            )}
            {deviceConnected === false && (
              <span className={styles.deviceErr}>✗ Cannot reach device</span>
            )}
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className={styles.errorBanner}>
            ⚠️ {error}
            <button onClick={fetchAttendance} className={styles.retryBtn}>Retry</button>
          </div>
        )}

        {/* Summary cards */}
        <div className={styles.cards}>
          <div className={`${styles.card} ${styles.cardTotal}`}>
            <div className={styles.cardNumber}>{summary.total}</div>
            <div className={styles.cardLabel}>Total Recognized</div>
          </div>
          <div className={`${styles.card} ${styles.cardPresent}`}>
            <div className={styles.cardNumber}>{summary.present}</div>
            <div className={styles.cardLabel}>On Time</div>
          </div>
          <div className={`${styles.card} ${styles.cardLate}`}>
            <div className={styles.cardNumber}>{summary.late}</div>
            <div className={styles.cardLabel}>Late</div>
          </div>
          <div className={`${styles.card} ${styles.cardAbsent}`}>
            <div className={styles.cardNumber}>
              {enrolled.length > 0 ? absentStudents.length : '—'}
            </div>
            <div className={styles.cardLabel}>
              {enrolled.length > 0 ? 'Absent' : 'No Device'}
            </div>
          </div>
        </div>

        {/* Main content: two columns */}
        <div className={styles.columns}>
          {/* Attendance log */}
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>Attendance Log · {date}</h2>
              {lastFetch && (
                <span className={styles.lastFetch}>
                  Updated {lastFetch}
                  {autoRefresh && <span className={styles.liveIndicator} />}
                </span>
              )}
            </div>

            {loading ? (
              <div className={styles.empty}>Loading...</div>
            ) : records.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>📭</div>
                <p>No attendance records for this date</p>
                {isToday && (
                  <p className={styles.emptyHint}>
                    Make sure <code>attendance_listener.py</code> is running on the Jetson
                  </p>
                )}
              </div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Time</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r, i) => (
                      <tr key={r.id || i} className={r.late ? styles.rowLate : styles.rowPresent}>
                        <td className={styles.rowNum}>{i + 1}</td>
                        <td className={styles.rowName}>{r.name}</td>
                        <td className={styles.rowTime}>
                          {r.timestamp ? r.timestamp.split(' ')[1] || r.timestamp : '—'}
                        </td>
                        <td>
                          <span className={`${styles.badge} ${r.late ? styles.badgeLate : styles.badgePresent}`}>
                            {r.status || (r.late ? 'Late' : 'Present')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Absent list */}
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2>Not Yet Recognized</h2>
              {enrolled.length > 0 && (
                <span className={styles.absentCount}>{absentStudents.length} remaining</span>
              )}
            </div>

            {enrolled.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>🔗</div>
                <p>Connect device to see absent list</p>
                <button
                  className={styles.connectBtn}
                  onClick={() => setShowSettings(true)}
                >
                  ⚙️ Device Settings
                </button>
              </div>
            ) : absentStudents.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>🎉</div>
                <p>All students recognized!</p>
              </div>
            ) : (
              <ul className={styles.absentList}>
                {absentStudents.map((u) => (
                  <li key={u.employeeNo} className={styles.absentItem}>
                    <span className={styles.absentDot} />
                    <span>{u.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className={styles.footer}>
          <span>
            Listener: <code>python attendance_listener.py</code> on Jetson
          </span>
          <span>
            {isToday && autoRefresh && '● Live'} · {date}
          </span>
        </footer>
      </div>
    </>
  );
}
