// pages/dashboard.js
// Main dashboard component for comprehensive analytics and logging

import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { mockAnalytics, mockLogs } from '../lib/mockData';
import styles from '../styles/dashboard.module.css';

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [analytics, setAnalytics] = useState(mockAnalytics);
  const [logs, setLogs] = useState(mockLogs);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [timeframe, setTimeframe] = useState('24h'); // 24h, 7d, 30d
  const [filters, setFilters] = useState({
    logType: 'all', // all, search, capture, failure, accuracy
    studentId: '',
    className: '',
  });
  const [reportGenerating, setReportGenerating] = useState(false);
  const [useMockData, setUseMockData] = useState(true); // Toggle between mock and real data

  useEffect(() => {
    if (!useMockData) {
      fetchAnalytics();
      const interval = setInterval(fetchAnalytics, 30000); // Refresh every 30 seconds
      return () => clearInterval(interval);
    }
  }, [timeframe, useMockData]);

  useEffect(() => {
    if (!useMockData) {
      fetchLogs();
    }
  }, [filters, activeTab, useMockData]);

  const fetchAnalytics = async () => {
    try {
      setLoading(true);
      const response = await axios.get('/api/dashboard/analytics', {
        params: { timeframe },
      });
      setAnalytics(response.data);
      setError('');
    } catch (err) {
      console.error('Analytics fetch error:', err);
      setError('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async () => {
    try {
      setLoading(true);

      // Apply filters to mock data
      let filteredLogs = [...mockLogs];

      if (filters.logType !== 'all') {
        filteredLogs = filteredLogs.filter(log => log.logType === filters.logType);
      }
      if (filters.studentId) {
        filteredLogs = filteredLogs.filter(log =>
          log.studentId.includes(filters.studentId) || log.studentName.toLowerCase().includes(filters.studentId.toLowerCase())
        );
      }
      if (filters.className) {
        filteredLogs = filteredLogs.filter(log => log.className === filters.className);
      }

      setLogs(filteredLogs);
      setError('');
    } catch (err) {
      console.error('Logs fetch error:', err);
      setError('Failed to load logs');
    } finally {
      setLoading(false);
    }
  };

  const generateReport = async () => {
    try {
      setReportGenerating(true);
      const response = await axios.post('/api/dashboard/claude-report', {
        reportType: 'daily',
        date: new Date().toISOString().split('T')[0],
      });

      // Display report in modal or new page
      alert('Report generated successfully!\n\n' + response.data.report);
    } catch (err) {
      console.error('Report generation error:', err);
      alert('Failed to generate report: ' + err.message);
    } finally {
      setReportGenerating(false);
    }
  };

  const MetricCard = ({ title, value, subtitle, trend }) => (
    <div className={styles.metric_card}>
      <div className={styles.metric_label}>{title}</div>
      <div className={styles.metric_value}>{value}</div>
      {subtitle && <div className={styles.metric_subtitle}>{subtitle}</div>}
      {trend && (
        <div
          className={styles.metric_trend}
          style={{
            color: trend > 0 ? '#4ade80' : '#ef4444',
          }}
        >
          {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}%
        </div>
      )}
    </div>
  );

  const renderOverview = () => {
    if (!analytics) return <div>Loading analytics...</div>;

    const successRate = analytics.totalCaptures > 0
      ? Math.round(((analytics.totalCaptures - analytics.totalFailures) / analytics.totalCaptures) * 100)
      : 0;

    return (
      <div className={styles.tab_content}>
        <div className={styles.metrics_grid}>
          <MetricCard
            title="Total Searches"
            value={analytics.totalSearches || 0}
            subtitle={`${analytics.uniqueSearchStudents || 0} unique students`}
          />
          <MetricCard
            title="Total Captures"
            value={analytics.totalCaptures || 0}
            subtitle={`${analytics.totalImages || 0} images`}
          />
          <MetricCard
            title="Failures"
            value={analytics.totalFailures || 0}
            subtitle={`Success Rate: ${successRate}%`}
            trend={successRate - 90}
          />
          <MetricCard
            title="Avg Accuracy"
            value={`${(analytics.avgAccuracy || 0).toFixed(1)}%`}
            subtitle="Face recognition accuracy"
            trend={analytics.avgAccuracy > 95 ? 5 : -5}
          />
        </div>

        <div className={styles.section}>
          <h3>Top Students by Captures</h3>
          <div className={styles.top_students}>
            {analytics.topStudents && analytics.topStudents.length > 0 ? (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Student Name</th>
                    <th>Student ID</th>
                    <th>Total Captures</th>
                    <th>Class</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.topStudents.map((student, idx) => (
                    <tr key={idx}>
                      <td>{student.studentName}</td>
                      <td>{student.studentId}</td>
                      <td className={styles.bold}>{student.count}</td>
                      <td>{student.className}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>No capture data available</p>
            )}
          </div>
        </div>

        <div className={styles.section}>
          <button
            className={styles.report_btn}
            onClick={generateReport}
            disabled={reportGenerating}
          >
            {reportGenerating ? 'Generating Report...' : 'Generate AI Report'}
          </button>
        </div>
      </div>
    );
  };

  const renderLogs = () => {
    return (
      <div className={styles.tab_content}>
        <div className={styles.filters}>
          <select
            value={filters.logType}
            onChange={(e) => setFilters({ ...filters, logType: e.target.value })}
            className={styles.filter_input}
          >
            <option value="all">All Log Types</option>
            <option value="search">Searches</option>
            <option value="capture">Captures</option>
            <option value="failure">Failures</option>
            <option value="accuracy">Accuracy</option>
          </select>

          <input
            type="text"
            placeholder="Filter by Student ID"
            value={filters.studentId}
            onChange={(e) => setFilters({ ...filters, studentId: e.target.value })}
            className={styles.filter_input}
          />

          <input
            type="text"
            placeholder="Filter by Class Name"
            value={filters.className}
            onChange={(e) => setFilters({ ...filters, className: e.target.value })}
            className={styles.filter_input}
          />

          <button
            onClick={fetchLogs}
            className={styles.filter_btn}
          >
            Apply Filters
          </button>
        </div>

        <div className={styles.logs_container}>
          {logs.length > 0 ? (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Student</th>
                  <th>Student ID</th>
                  <th>Class</th>
                  <th>Log Type</th>
                  <th>Details</th>
                  <th>Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, idx) => (
                  <tr key={idx}>
                    <td>{new Date(log.timestamp).toLocaleString()}</td>
                    <td>{log.studentName}</td>
                    <td className={styles.monospace}>{log.studentId}</td>
                    <td>{log.className}</td>
                    <td>
                      <span
                        className={`${styles.badge} ${styles[`badge_${log.logType}`]}`}
                      >
                        {log.logType}
                      </span>
                    </td>
                    <td className={styles.details}>{log.details || '-'}</td>
                    <td>
                      {log.accuracy ? `${(log.accuracy * 100).toFixed(1)}%` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={styles.no_data}>No logs found</p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={styles.dashboard_container}>
      <div className={styles.dashboard_header}>
        <h1>📊 DASHBOARD - FACIAL ATTENDANCE ANALYTICS</h1>
        <div className={styles.header_controls}>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className={styles.timeframe_select}
          >
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>
        </div>
      </div>

      {error && <div className={styles.error_message}>{error}</div>}

      <div className={styles.tabs}>
        <button
          className={`${styles.tab_btn} ${activeTab === 'overview' ? styles.active : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          📈 Overview
        </button>
        <button
          className={`${styles.tab_btn} ${activeTab === 'logs' ? styles.active : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          📋 Detailed Logs
        </button>
        <button
          className={`${styles.tab_btn} ${activeTab === 'failed' ? styles.active : ''}`}
          onClick={() => {
            setFilters({ ...filters, logType: 'failure' });
            setActiveTab('logs');
          }}
        >
          ⚠️ Failures
        </button>
      </div>

      {loading && activeTab !== 'logs' && <div className={styles.loading}>Loading...</div>}

      {activeTab === 'overview' && renderOverview()}
      {(activeTab === 'logs' || activeTab === 'failed') && renderLogs()}
    </div>
  );
}
