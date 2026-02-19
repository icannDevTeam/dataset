/**
 * Hikvision Enrollment Portal
 *
 * 3-step flow:
 *   1. Connect — Enter device IP/credentials, test connection
 *   2. Select — Browse Firebase dataset, pick students to enroll
 *   3. Enroll — Push selected faces to the Hikvision device
 */

import Head from 'next/head';
import Link from 'next/link';
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import styles from '../styles/hikvision.module.css';

const STEPS = ['Connect Device', 'Select Students', 'Enroll Faces'];

export default function HikvisionPortal() {
  // Step state (0 = connect, 1 = select, 2 = enroll)
  const [currentStep, setCurrentStep] = useState(0);

  // Connection state
  const [device, setDevice] = useState({
    ip: '10.26.30.200',
    username: '',
    password: '',
  });
  const [connecting, setConnecting] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [enrolledUsers, setEnrolledUsers] = useState([]);
  const [deviceStats, setDeviceStats] = useState({});

  // Dataset state
  const [students, setStudents] = useState([]);
  const [loadingDataset, setLoadingDataset] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // Enrollment state
  const [enrolling, setEnrolling] = useState(false);
  const [enrollProgress, setEnrollProgress] = useState(0);
  const [enrollResults, setEnrollResults] = useState([]);
  const [enrollMessage, setEnrollMessage] = useState('');

  // Delete state
  const [deletingUser, setDeletingUser] = useState(null);

  // Error
  const [error, setError] = useState('');

  // ── Step 1: Connect to device ──
  const handleConnect = async () => {
    setError('');
    setConnecting(true);
    try {
      const res = await axios.post('/api/hikvision/connect', device);
      setDeviceInfo(res.data.device);
      setEnrolledUsers(res.data.users || []);
      setDeviceStats({
        totalUsers: res.data.totalUsers,
        totalFaces: res.data.totalFaces,
        capacity: res.data.capacity,
      });
      setCurrentStep(1);
      // Auto-load dataset
      loadDataset();
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.details || err.message;
      setError(`Connection failed: ${msg}`);
    } finally {
      setConnecting(false);
    }
  };

  // ── Delete user from device ──
  const handleDeleteUser = async (user) => {
    if (!confirm(`Remove ${user.name} (${user.employeeNo}) from the device?`)) return;
    setDeletingUser(user.employeeNo);
    setError('');
    try {
      await axios.post('/api/hikvision/delete', {
        device,
        employeeNo: user.employeeNo,
        name: user.name,
      });
      // Remove from local state
      setEnrolledUsers((prev) => prev.filter((u) => u.employeeNo !== user.employeeNo));
      setDeviceStats((prev) => ({
        ...prev,
        totalUsers: Math.max(0, (prev.totalUsers || 0) - 1),
        totalFaces: Math.max(0, (prev.totalFaces || 0) - (user.numOfFace || 0)),
      }));
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.details || err.message;
      setError(`Delete failed: ${msg}`);
    } finally {
      setDeletingUser(null);
    }
  };

  // ── Step 2: Load dataset from Firebase ──
  const loadDataset = async () => {
    setLoadingDataset(true);
    setError('');
    try {
      const res = await axios.get('/api/dataset/list');
      setStudents(res.data.students || []);
    } catch (err) {
      setError(`Failed to load dataset: ${err.response?.data?.details || err.message}`);
    } finally {
      setLoadingDataset(false);
    }
  };

  // Check if a student is already enrolled on the device
  const isEnrolledOnDevice = useCallback(
    (studentName) => {
      return enrolledUsers.some(
        (u) => u.name?.toLowerCase() === studentName?.toLowerCase()
      );
    },
    [enrolledUsers]
  );

  // Toggle student selection
  const toggleSelect = (idx) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // Select all / none
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredStudents.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredStudents.map((_, i) => i)));
    }
  };

  // Select only unenrolled
  const selectUnenrolled = () => {
    const ids = new Set();
    filteredStudents.forEach((s, i) => {
      if (!isEnrolledOnDevice(s.studentName)) {
        ids.add(i);
      }
    });
    setSelectedIds(ids);
  };

  // Filter students by search
  const filteredStudents = students.filter((s) => {
    const q = searchQuery.toLowerCase();
    return (
      s.studentName.toLowerCase().includes(q) ||
      s.className.toLowerCase().includes(q)
    );
  });

  // ── Step 3: Enroll selected students ──
  const handleEnroll = async () => {
    if (selectedIds.size === 0) return;

    setCurrentStep(2);
    setEnrolling(true);
    setEnrollProgress(0);
    setEnrollResults([]);
    setEnrollMessage('');
    setError('');

    // Prepare student list with the first photo URL for each
    const toEnroll = Array.from(selectedIds).map((idx) => {
      const s = filteredStudents[idx];
      return {
        studentName: s.studentName,
        className: s.className,
        studentId: s.studentId || '',
        photoUrl: s.photos[0]?.url || '',
      };
    });

    // Enroll in small batches to avoid timeout (5 at a time)
    const batchSize = 5;
    const allResults = [];

    for (let i = 0; i < toEnroll.length; i += batchSize) {
      const batch = toEnroll.slice(i, i + batchSize);
      try {
        const res = await axios.post('/api/hikvision/batch-enroll', {
          device,
          students: batch,
        });
        allResults.push(...(res.data.results || []));
      } catch (err) {
        // Log failures for this batch
        batch.forEach((s) => {
          allResults.push({
            studentName: s.studentName,
            className: s.className,
            success: false,
            error: err.response?.data?.error || err.message,
          });
        });
      }
      setEnrollProgress(Math.min(i + batchSize, toEnroll.length));
      setEnrollResults([...allResults]);
    }

    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;
    setEnrollMessage(
      `Enrolled ${successCount} of ${toEnroll.length} students` +
        (failCount > 0 ? ` (${failCount} failed)` : '')
    );
    setEnrolling(false);

    // Refresh device user list
    try {
      const res = await axios.post('/api/hikvision/connect', device);
      setEnrolledUsers(res.data.users || []);
      setDeviceStats({
        totalUsers: res.data.totalUsers,
        totalFaces: res.data.totalFaces,
        capacity: res.data.capacity,
      });
    } catch (e) {
      // Non-fatal
    }
  };

  // ── Render ──
  return (
    <>
      <Head>
        <title>Hikvision Enrollment Portal</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <h1>🔐 Hikvision Enrollment Portal</h1>
          <div className={styles.headerActions}>
            <Link href="/device-manager" className={styles.navLink}>📋 Device</Link>
            <Link href="/dashboard" className={styles.navLink}>📊 Dashboard</Link>
            <Link href="/" className={styles.navLink}>📸 Capture</Link>
          </div>
        </div>

        {/* Steps indicator */}
        <div className={styles.steps}>
          {STEPS.map((label, i) => (
            <div
              key={i}
              className={`${styles.step} ${
                i === currentStep ? styles.stepActive : ''
              } ${i < currentStep ? styles.stepDone : ''}`}
              onClick={() => {
                if (i < currentStep) setCurrentStep(i);
              }}
              style={{ cursor: i < currentStep ? 'pointer' : 'default' }}
            >
              <span className={styles.stepNum}>{i + 1}.</span>
              {label}
            </div>
          ))}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        {/* ── Step 1: Connect ── */}
        {currentStep === 0 && (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>📡 Device Connection</h2>
            <div className={styles.formGrid}>
              <div className={styles.formGroup}>
                <label>IP Address</label>
                <input
                  type="text"
                  value={device.ip}
                  onChange={(e) => setDevice({ ...device, ip: e.target.value })}
                  placeholder="e.g. 10.26.30.200"
                />
              </div>
              <div className={styles.formGroup}>
                <label>Username</label>
                <input
                  type="text"
                  value={device.username}
                  onChange={(e) => setDevice({ ...device, username: e.target.value })}
                  placeholder="admin"
                />
              </div>
              <div className={styles.formGroup}>
                <label>Password</label>
                <input
                  type="password"
                  value={device.password}
                  onChange={(e) => setDevice({ ...device, password: e.target.value })}
                  placeholder="password"
                />
              </div>
            </div>
            <button
              className={styles.connectBtn}
              onClick={handleConnect}
              disabled={connecting || !device.ip}
            >
              {connecting ? (
                <>
                  <span className={styles.spinner}></span> Connecting...
                </>
              ) : (
                'Connect'
              )}
            </button>

            {deviceInfo && !connecting && (
              <div className={styles.deviceCard}>
                <div className={styles.deviceInfo}>
                  <h3>Device Info</h3>
                  {deviceInfo.error ? (
                    <p style={{ color: '#ef4444' }}>{deviceInfo.error}</p>
                  ) : (
                    <>
                      <div className={styles.infoRow}>
                        <span className={styles.infoLabel}>Model</span>
                        <span className={styles.infoValue}>{deviceInfo.model}</span>
                      </div>
                      <div className={styles.infoRow}>
                        <span className={styles.infoLabel}>Name</span>
                        <span className={styles.infoValue}>{deviceInfo.deviceName}</span>
                      </div>
                      <div className={styles.infoRow}>
                        <span className={styles.infoLabel}>Firmware</span>
                        <span className={styles.infoValue}>{deviceInfo.firmware}</span>
                      </div>
                      <div className={styles.infoRow}>
                        <span className={styles.infoLabel}>Serial</span>
                        <span className={styles.infoValue}>{deviceInfo.serial}</span>
                      </div>
                      <div className={styles.infoRow}>
                        <span className={styles.infoLabel}>MAC</span>
                        <span className={styles.infoValue}>{deviceInfo.mac}</span>
                      </div>
                    </>
                  )}
                </div>
                <div className={styles.enrolledList}>
                  <h3>Enrolled Users ({enrolledUsers.length})</h3>
                  {enrolledUsers.length === 0 ? (
                    <p style={{ color: '#64748b', fontSize: '0.85rem' }}>
                      No users enrolled on device
                    </p>
                  ) : (
                    enrolledUsers.map((u, i) => (
                      <div key={i} className={styles.enrolledUser}>
                        <span className={styles.enrolledName}>{u.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={styles.enrolledBadge}>
                            {u.numOfFace} face{u.numOfFace !== 1 ? 's' : ''}
                          </span>
                          <button
                            className={styles.deleteBtn}
                            onClick={() => handleDeleteUser(u)}
                            disabled={deletingUser === u.employeeNo}
                            title={`Remove ${u.name} from device`}
                          >
                            {deletingUser === u.employeeNo ? '...' : '✕'}
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Select Students ── */}
        {currentStep === 1 && (
          <div className={styles.panel}>
            <div className={styles.datasetHeader}>
              <h2 className={styles.panelTitle}>
                📂 Firebase Dataset
                {!loadingDataset && (
                  <span style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 400 }}>
                    {' '}
                    — {students.length} students
                  </span>
                )}
              </h2>
              <div className={styles.datasetControls}>
                <input
                  className={styles.searchInput}
                  type="text"
                  placeholder="Search name or class..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button className={styles.selectAll} onClick={toggleSelectAll}>
                  {selectedIds.size === filteredStudents.length ? 'Deselect All' : 'Select All'}
                </button>
                <button className={styles.selectAll} onClick={selectUnenrolled}>
                  Select New Only
                </button>
                <button
                  className={styles.selectAll}
                  onClick={loadDataset}
                  disabled={loadingDataset}
                >
                  {loadingDataset ? 'Loading...' : '↻ Refresh'}
                </button>
              </div>
            </div>

            {/* Device summary bar */}
            <div
              style={{
                display: 'flex',
                gap: 20,
                marginBottom: 16,
                fontSize: '0.85rem',
                color: '#94a3b8',
              }}
            >
              <span>
                Device:{' '}
                <strong style={{ color: '#22c55e' }}>
                  {deviceInfo?.model || device.ip}
                </strong>
              </span>
              <span>
                Users on device: <strong>{deviceStats.totalUsers || 0}</strong>
              </span>
              <span>
                Faces on device: <strong>{deviceStats.totalFaces || 0}</strong>
              </span>
              {deviceStats.capacity?.maxUsers > 0 && (
                <span>
                  Capacity: <strong>{deviceStats.capacity.maxUsers}</strong> max
                </span>
              )}
            </div>

            {loadingDataset ? (
              <div className={styles.emptyState}>
                <span className={styles.spinner}></span>
                <h3>Loading dataset from Firebase...</h3>
                <p>Fetching student photos and metadata</p>
              </div>
            ) : filteredStudents.length === 0 ? (
              <div className={styles.emptyState}>
                <h3>No students found</h3>
                <p>
                  {students.length === 0
                    ? 'Upload photos via the Capture page first'
                    : 'No matches for your search'}
                </p>
              </div>
            ) : (
              <div className={styles.studentGrid}>
                {filteredStudents.map((student, idx) => {
                  const enrolled = isEnrolledOnDevice(student.studentName);
                  const selected = selectedIds.has(idx);
                  return (
                    <div
                      key={`${student.className}-${student.studentName}`}
                      className={`${styles.studentCard} ${
                        selected ? styles.studentCardSelected : ''
                      } ${enrolled ? styles.studentCardEnrolled : ''}`}
                      onClick={() => toggleSelect(idx)}
                    >
                      <div
                        className={`${styles.checkmark} ${
                          enrolled
                            ? styles.checkmarkEnrolled
                            : selected
                            ? styles.checkmarkSelected
                            : ''
                        }`}
                      >
                        {enrolled ? '✓' : selected ? '✓' : ''}
                      </div>
                      {student.photos[0]?.url && (
                        <img
                          className={styles.studentPhoto}
                          src={student.photos[0].url}
                          alt={student.studentName}
                          onError={(e) => {
                            e.target.style.display = 'none';
                          }}
                        />
                      )}
                      <div className={styles.studentName}>{student.studentName}</div>
                      <div className={styles.studentMeta}>
                        Class: {student.className}
                        {student.studentId && ` • ID: ${student.studentId}`}
                      </div>
                      <span className={styles.photoCount}>
                        {student.totalImages} photo{student.totalImages !== 1 ? 's' : ''}
                      </span>
                      {enrolled && (
                        <span
                          className={`${styles.statusBadge} ${styles.statusConnected}`}
                          style={{ marginLeft: 6 }}
                        >
                          On Device
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Action bar */}
            {filteredStudents.length > 0 && (
              <div className={styles.actionBar}>
                <div className={styles.selectionInfo}>
                  <span className={styles.selectionCount}>{selectedIds.size}</span> students
                  selected
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    className={styles.connectBtn}
                    onClick={() => setCurrentStep(0)}
                  >
                    ← Back
                  </button>
                  <button
                    className={styles.enrollBtn}
                    onClick={handleEnroll}
                    disabled={selectedIds.size === 0 || enrolling}
                  >
                    {enrolling ? (
                      <>
                        <span className={styles.spinner}></span> Enrolling...
                      </>
                    ) : (
                      `Enroll ${selectedIds.size} Student${selectedIds.size !== 1 ? 's' : ''}`
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Enroll Progress ── */}
        {currentStep === 2 && (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>
              {enrolling ? '⏳ Enrolling Faces...' : '✅ Enrollment Complete'}
            </h2>

            <div className={styles.progressPanel}>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{
                    width: `${
                      selectedIds.size > 0
                        ? (enrollProgress / selectedIds.size) * 100
                        : 0
                    }%`,
                  }}
                ></div>
              </div>
              <div className={styles.progressText}>
                {enrolling
                  ? `Processing ${enrollProgress} of ${selectedIds.size}...`
                  : enrollMessage}
              </div>

              <div className={styles.resultsList}>
                {enrollResults.map((r, i) => (
                  <div
                    key={i}
                    className={`${styles.resultItem} ${
                      r.success ? styles.resultSuccess : styles.resultFail
                    }`}
                  >
                    <span>
                      {r.success ? '✅' : '❌'} {r.studentName}{' '}
                      <span style={{ color: '#64748b' }}>({r.className})</span>
                    </span>
                    {r.success ? (
                      <span>Enrolled as {r.employeeNo}</span>
                    ) : (
                      <span className={styles.resultError}>{r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {!enrolling && (
              <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
                <button
                  className={styles.connectBtn}
                  onClick={() => {
                    setSelectedIds(new Set());
                    setEnrollResults([]);
                    setCurrentStep(1);
                  }}
                >
                  ← Select More Students
                </button>
                <button
                  className={styles.connectBtn}
                  onClick={() => {
                    setCurrentStep(0);
                    setSelectedIds(new Set());
                    setEnrollResults([]);
                  }}
                >
                  Reconnect Device
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
