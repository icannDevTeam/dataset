// pages/attendance-records.js
// Attendance records page with lateness, early arrival tracking

import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { mockAttendanceRecords } from '../lib/mockData';
import styles from '../styles/attendance.module.css';

export default function AttendanceRecords() {
  const [records, setRecords] = useState(mockAttendanceRecords);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    studentId: '',
    className: '',
    dateFrom: '',
    dateTo: '',
    status: 'all', // all, on_time, late, early
  });
  const [statistics, setStatistics] = useState({
    totalRecords: 0,
    onTime: 0,
    late: 0,
    early: 0,
    avgAccuracy: 0,
  });
  const [useMockData, setUseMockData] = useState(true);

  useEffect(() => {
    if (useMockData) {
      fetchAttendanceRecords();
    } else {
      // Set up real API polling
      fetchAttendanceRecords();
      const interval = setInterval(fetchAttendanceRecords, 60000); // Refresh every minute
      return () => clearInterval(interval);
    }
  }, [useMockData]);

  const fetchAttendanceRecords = async () => {
    try {
      setLoading(true);

      // Use mock data with client-side filtering
      let recordsList = [...mockAttendanceRecords];

      if (filters.studentId) {
        recordsList = recordsList.filter(r =>
          r.studentId.includes(filters.studentId) || r.studentName.toLowerCase().includes(filters.studentId.toLowerCase())
        );
      }
      if (filters.className) {
        recordsList = recordsList.filter(r => r.className === filters.className);
      }

      // Client-side filtering by status
      if (filters.status !== 'all') {
        recordsList = recordsList.filter(r => r.status === filters.status);
      }

      setRecords(recordsList);

      // Calculate statistics
      calculateStatistics(recordsList);
      setError('');
    } catch (err) {
      console.error('Attendance fetch error:', err);
      setError('Failed to load attendance records');
    } finally {
      setLoading(false);
    }
  };

  const calculateStatistics = (recordsList) => {
    let onTime = 0,
      late = 0,
      early = 0;
    let accuracySum = 0;

    recordsList.forEach(record => {
      if (record.status === 'on_time') onTime++;
      else if (record.status === 'late') late++;
      else if (record.status === 'early') early++;

      if (record.accuracy) {
        accuracySum += record.accuracy;
      }
    });

    setStatistics({
      totalRecords: recordsList.length,
      onTime,
      late,
      early,
      avgAccuracy: recordsList.length > 0
        ? (accuracySum / recordsList.length).toFixed(2)
        : 0,
    });
  };

  const getStatusBadge = (status) => {
    const badges = {
      on_time: { emoji: '✅', label: 'On Time', color: '#10b981' },
      late: { emoji: '🔴', label: 'Late', color: '#ef4444' },
      early: { emoji: '⭐', label: 'Early', color: '#f59e0b' },
    };
    const badge = badges[status] || badges.on_time;
    return (
      <span
        className={styles.status_badge}
        style={{ borderColor: badge.color, color: badge.color }}
      >
        {badge.emoji} {badge.label}
      </span>
    );
  };

  const getAccuracyBadge = (accuracy) => {
    if (!accuracy) return <span className={styles.accuracy_unavailable}>N/A</span>;
    
    const percent = accuracy * 100;
    let color, label;
    
    if (percent >= 95) {
      color = '#10b981'; // Green - Excellent
      label = 'Excellent';
    } else if (percent >= 90) {
      color = '#3b82f6'; // Blue - Good
      label = 'Good';
    } else if (percent >= 85) {
      color = '#f59e0b'; // Yellow - Fair
      label = 'Fair';
    } else {
      color = '#ef4444'; // Red - Poor
      label = 'Poor';
    }
    
    return (
      <span
        className={styles.accuracy_badge}
        style={{ borderColor: color, color: color }}
      >
        {percent.toFixed(1)}% <span className={styles.accuracy_label}>({label})</span>
      </span>
    );
  };

  const downloadCSV = () => {
    const headers = [
      'Student ID',
      'Student Name',
      'Class Name',
      'Date',
      'Time',
      'Status',
      'Accuracy',
      'Method',
    ];
    const rows = records.map(r => [
      r.studentId,
      r.studentName,
      r.className,
      r.date,
      r.time,
      r.status,
      r.accuracy ? (r.accuracy * 100).toFixed(2) : 'N/A',
      r.method,
    ]);

    let csv = headers.join(',') + '\n';
    rows.forEach(row => {
      csv += row.map(cell => `"${cell}"`).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.attendance_container}>
      <div className={styles.header}>
        <h1>📅 ATTENDANCE RECORDS</h1>
        <button onClick={downloadCSV} className={styles.download_btn}>
          📥 Download CSV
        </button>
      </div>

      {error && <div className={styles.error_message}>{error}</div>}

      {/* Statistics Cards */}
      <div className={styles.stats_grid}>
        <div className={styles.stat_card}>
          <div className={styles.stat_label}>Total Records</div>
          <div className={styles.stat_value}>{statistics.totalRecords}</div>
        </div>
        <div className={styles.stat_card}>
          <div className={styles.stat_label} style={{ color: '#10b981' }}>
            On Time ✅
          </div>
          <div className={styles.stat_value} style={{ color: '#10b981' }}>
            {statistics.onTime}
          </div>
        </div>
        <div className={styles.stat_card}>
          <div className={styles.stat_label} style={{ color: '#ef4444' }}>
            Late 🔴
          </div>
          <div className={styles.stat_value} style={{ color: '#ef4444' }}>
            {statistics.late}
          </div>
        </div>
        <div className={styles.stat_card}>
          <div className={styles.stat_label} style={{ color: '#f59e0b' }}>
            Early ⭐
          </div>
          <div className={styles.stat_value} style={{ color: '#f59e0b' }}>
            {statistics.early}
          </div>
        </div>
        <div className={styles.stat_card}>
          <div className={styles.stat_label}>Avg Accuracy</div>
          <div className={styles.stat_value}>{statistics.avgAccuracy}%</div>
        </div>
      </div>

      {/* Filters */}
      <div className={styles.filters_section}>
        <h3>Filters</h3>
        <div className={styles.filters_grid}>
          <input
            type="text"
            placeholder="Student ID"
            value={filters.studentId}
            onChange={(e) => setFilters({ ...filters, studentId: e.target.value })}
            className={styles.filter_input}
          />

          <input
            type="text"
            placeholder="Class Name"
            value={filters.className}
            onChange={(e) => setFilters({ ...filters, className: e.target.value })}
            className={styles.filter_input}
          />

          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
            className={styles.filter_input}
          />

          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
            className={styles.filter_input}
          />

          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            className={styles.filter_input}
          >
            <option value="all">All Status</option>
            <option value="on_time">On Time</option>
            <option value="late">Late</option>
            <option value="early">Early</option>
          </select>

          <button
            onClick={fetchAttendanceRecords}
            disabled={loading}
            className={styles.filter_btn}
          >
            {loading ? 'Loading...' : 'Apply Filters'}
          </button>
        </div>
      </div>

      {/* Records Table */}
      <div className={styles.table_container}>
        {loading && records.length === 0 ? (
          <div className={styles.loading}>Loading attendance records...</div>
        ) : records.length > 0 ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date & Time</th>
                <th>Student ID</th>
                <th>Student Name</th>
                <th>Class</th>
                <th>Time</th>
                <th>Status</th>
                <th>Face Recognition Accuracy</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record, idx) => (
                <tr key={idx} className={styles[`row_${record.status}`]}>
                  <td className={styles.datetime}>
                    {new Date(record.timestamp).toLocaleString()}
                  </td>
                  <td className={styles.student_id}>{record.studentId}</td>
                  <td>{record.studentName}</td>
                  <td>{record.className}</td>
                  <td className={styles.time_cell}>{record.time}</td>
                  <td>{getStatusBadge(record.status)}</td>
                  <td>{getAccuracyBadge(record.accuracy)}</td>
                  <td className={styles.method}>{record.method}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={styles.no_data}>
            No attendance records found. Try adjusting your filters.
          </div>
        )}
      </div>
    </div>
  );
}
