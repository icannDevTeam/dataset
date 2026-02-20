/**
 * /mobile-enrollment — Mobile App Face Enrollment Portal
 *
 * 3-step flow (similar to Hikvision portal):
 *   1. Load — Load face-api.js models in the browser
 *   2. Review — See which students have photos & descriptor status
 *   3. Seed — Compute face descriptors and push to Firestore
 *
 * The mobile attendance app reads these descriptors to recognise faces.
 */

import Head from 'next/head';
import Link from 'next/link';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import styles from '../styles/mobile-enrollment.module.css';

const STEPS = ['Load Models', 'Review Students', 'Seed Descriptors'];

export default function MobileEnrollmentPortal() {
  const [currentStep, setCurrentStep] = useState(0);

  // Model state
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelStatus, setModelStatus] = useState('Click "Load Models" to begin');
  const [loadingModels, setLoadingModels] = useState(false);
  const faceapiRef = useRef(null);

  // Students state
  const [students, setStudents] = useState([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all'); // all | unseeded | seeded

  // Seeding state
  const [seeding, setSeeding] = useState(false);
  const [seedProgress, setSeedProgress] = useState(0);
  const [seedResults, setSeedResults] = useState([]);
  const [seedMessage, setSeedMessage] = useState('');
  const abortRef = useRef(false);

  // Summary stats
  const [stats, setStats] = useState({ total: 0, seeded: 0, unseeded: 0 });

  // Error
  const [error, setError] = useState('');

  // ── Step 1: Load face-api.js models in-browser ──

  const handleLoadModels = async () => {
    setError('');
    setLoadingModels(true);
    setModelStatus('Importing face-api.js…');

    try {
      // Dynamic import — face-api.js runs purely in the browser
      const faceapi = await import('face-api.js');
      faceapiRef.current = faceapi;

      setModelStatus('Loading face detection model…');
      await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');

      setModelStatus('Loading landmark model…');
      await faceapi.nets.faceLandmark68Net.loadFromUri('/models');

      setModelStatus('Loading recognition model…');
      await faceapi.nets.faceRecognitionNet.loadFromUri('/models');

      setModelsLoaded(true);
      setModelStatus('All models loaded ✓');
      setCurrentStep(1);

      // Auto-load student list
      loadStudents();
    } catch (err) {
      setError(`Model loading failed: ${err.message}`);
      setModelStatus('Failed — check console');
    } finally {
      setLoadingModels(false);
    }
  };

  // ── Step 2: Load student list with seed status ──

  const loadStudents = async () => {
    setLoadingStudents(true);
    setError('');
    try {
      const res = await fetch('/api/dataset/seed-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      setStudents(data.students || []);
      setStats({
        total: data.totalStudents || 0,
        seeded: data.seededCount || 0,
        unseeded: data.unseededCount || 0,
      });
    } catch (err) {
      setError(`Failed to load students: ${err.message}`);
    } finally {
      setLoadingStudents(false);
    }
  };

  // ── Toggle selection ──

  const toggleStudent = (key) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllVisible = () => {
    const visible = filteredStudents.filter((s) => s.studentId);
    const allKeys = visible.map((s) => `${s.className}/${s.studentName}`);
    setSelectedIds(new Set(allKeys));
  };

  const selectUnseeded = () => {
    const unseeded = students.filter((s) => !s.seeded && s.studentId);
    const keys = unseeded.map((s) => `${s.className}/${s.studentName}`);
    setSelectedIds(new Set(keys));
  };

  const clearSelection = () => setSelectedIds(new Set());

  // ── Step 3: Seed descriptors ──

  const handleSeed = async () => {
    const toSeed = students.filter(
      (s) => selectedIds.has(`${s.className}/${s.studentName}`) && s.studentId
    );

    if (toSeed.length === 0) {
      setError('No students selected (they also need a Student ID in the system)');
      return;
    }

    setCurrentStep(2);
    setSeeding(true);
    setSeedProgress(0);
    setSeedResults([]);
    setSeedMessage(`Seeding 0 of ${toSeed.length}…`);
    abortRef.current = false;
    setError('');

    const faceapi = faceapiRef.current;
    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < toSeed.length; i++) {
      if (abortRef.current) break;
      const student = toSeed[i];
      setSeedProgress(i + 1);
      setSeedMessage(`Processing ${i + 1} of ${toSeed.length}: ${student.studentName}…`);

      try {
        // 1. Get signed photo URLs
        const photosRes = await fetch(
          `/api/dataset/seed?className=${encodeURIComponent(student.className)}&studentName=${encodeURIComponent(student.studentName)}`
        );
        if (!photosRes.ok) throw new Error('Failed to get photos');
        const photosData = await photosRes.json();

        if (!photosData.photos || photosData.photos.length === 0) {
          setSeedResults((prev) => [...prev, { studentName: student.studentName, className: student.className, success: false, error: 'No photos found' }]);
          skipped++;
          continue;
        }

        // 2. Download each photo and compute descriptors in-browser
        const descriptors = [];
        for (const photo of photosData.photos.slice(0, 5)) {
          try {
            // Create an Image element and load the photo
            const img = await loadImage(photo.url);
            const detection = await faceapi
              .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
              .withFaceLandmarks()
              .withFaceDescriptor();

            if (detection) {
              descriptors.push(Array.from(detection.descriptor));
            }
          } catch {
            // Skip individual photo errors
          }
        }

        if (descriptors.length === 0) {
          setSeedResults((prev) => [...prev, { studentName: student.studentName, className: student.className, success: false, error: 'No face detected in photos' }]);
          skipped++;
          continue;
        }

        // 3. POST descriptors to API
        const saveRes = await fetch('/api/dataset/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: student.studentId,
            studentName: student.studentName,
            className: student.className,
            gradeCode: student.gradeCode || '',
            descriptors,
            photoCount: photosData.photos.length,
          }),
        });

        if (!saveRes.ok) {
          const err = await saveRes.json();
          throw new Error(err.error || 'Save failed');
        }

        setSeedResults((prev) => [...prev, {
          studentName: student.studentName,
          className: student.className,
          success: true,
          descriptorCount: descriptors.length,
        }]);
        success++;
      } catch (err) {
        setSeedResults((prev) => [...prev, {
          studentName: student.studentName,
          className: student.className,
          success: false,
          error: err.message,
        }]);
        failed++;
      }
    }

    setSeeding(false);
    setSeedMessage(
      abortRef.current
        ? `Aborted. ${success} seeded, ${failed} failed, ${skipped} skipped`
        : `Done! ${success} seeded, ${failed} failed, ${skipped} skipped`
    );

    // Refresh student list
    loadStudents();
  };

  // Helper: load an image from URL into an HTMLImageElement
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = url;
    });
  }

  // ── Filtered students ──

  const filteredStudents = students.filter((s) => {
    if (filterStatus === 'seeded' && !s.seeded) return false;
    if (filterStatus === 'unseeded' && s.seeded) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        s.studentName.toLowerCase().includes(q) ||
        s.className.toLowerCase().includes(q) ||
        (s.studentId || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  // ── Render ──

  return (
    <>
      <Head>
        <title>Mobile Enrollment — BINUS Facial Attendance</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <h1>📱 Mobile App Enrollment</h1>
          <div className={styles.headerActions}>
            <Link href="/dashboard" className={styles.navLink}>📊 Dashboard</Link>
            <Link href="/attendance-monitor" className={styles.navLink}>📋 BINUS Logs</Link>
            <Link href="/hikvision" className={styles.navLink}>🔐 Hikvision</Link>
            <Link href="/" className={styles.navLink}>📸 Collector</Link>
          </div>
        </div>

        {/* Steps */}
        <div className={styles.steps}>
          {STEPS.map((label, i) => (
            <div
              key={i}
              className={`${styles.step} ${i === currentStep ? styles.stepActive : ''} ${i < currentStep ? styles.stepDone : ''}`}
            >
              <span className={styles.stepNum}>{i + 1}.</span>
              {label}
            </div>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className={styles.errorBar}>
            ⚠️ {error}
            <button onClick={() => setError('')} className={styles.dismissBtn}>✕</button>
          </div>
        )}

        {/* Step 0: Load Models */}
        {currentStep === 0 && (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>🧠 Load Face Recognition Models</h2>
            <p className={styles.panelDesc}>
              These models run in your browser — no backend GPU needed.
              They&apos;re used to compute face descriptors from uploaded student photos.
            </p>

            <div className={styles.modelStatus}>
              <div className={`${styles.statusDot} ${modelsLoaded ? styles.statusOk : loadingModels ? styles.statusLoading : ''}`} />
              <span>{modelStatus}</span>
            </div>

            <button
              className={styles.primaryBtn}
              onClick={handleLoadModels}
              disabled={loadingModels || modelsLoaded}
            >
              {loadingModels ? '⏳ Loading…' : modelsLoaded ? '✅ Models Ready' : '🚀 Load Models'}
            </button>
          </div>
        )}

        {/* Step 1: Review Students */}
        {currentStep === 1 && (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>👥 Student Enrollment Status</h2>

            {/* Summary cards */}
            <div className={styles.statsRow}>
              <div className={styles.statCard}>
                <div className={styles.statNum}>{stats.total}</div>
                <div className={styles.statLabel}>Total Students</div>
              </div>
              <div className={`${styles.statCard} ${styles.statSeeded}`}>
                <div className={styles.statNum}>{stats.seeded}</div>
                <div className={styles.statLabel}>Seeded ✓</div>
              </div>
              <div className={`${styles.statCard} ${styles.statUnseeded}`}>
                <div className={styles.statNum}>{stats.unseeded}</div>
                <div className={styles.statLabel}>Not Seeded</div>
              </div>
            </div>

            {/* Controls */}
            <div className={styles.controls}>
              <input
                type="text"
                placeholder="Search name, class, ID…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={styles.searchInput}
              />

              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className={styles.filterSelect}
              >
                <option value="all">All</option>
                <option value="unseeded">Not Seeded</option>
                <option value="seeded">Already Seeded</option>
              </select>

              <button onClick={selectUnseeded} className={styles.secondaryBtn} title="Select only unseeded students">
                Select Unseeded
              </button>
              <button onClick={selectAllVisible} className={styles.secondaryBtn}>
                Select All
              </button>
              <button onClick={clearSelection} className={styles.secondaryBtn}>
                Clear
              </button>
              <button onClick={loadStudents} className={styles.secondaryBtn} disabled={loadingStudents}>
                🔄 Refresh
              </button>
            </div>

            <div className={styles.selectionInfo}>
              {selectedIds.size > 0 ? (
                <span>✅ {selectedIds.size} student{selectedIds.size !== 1 ? 's' : ''} selected</span>
              ) : (
                <span>Select students to seed their face descriptors</span>
              )}
            </div>

            {/* Student list */}
            {loadingStudents ? (
              <div className={styles.loading}>Loading student list…</div>
            ) : filteredStudents.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>📭</div>
                <p>No students found. Upload photos via the Collector first.</p>
              </div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.thCheck}>
                        <input
                          type="checkbox"
                          checked={filteredStudents.length > 0 && filteredStudents.every((s) => selectedIds.has(`${s.className}/${s.studentName}`))}
                          onChange={(e) => e.target.checked ? selectAllVisible() : clearSelection()}
                        />
                      </th>
                      <th>Student Name</th>
                      <th>Class</th>
                      <th>Student ID</th>
                      <th>Photos</th>
                      <th>Status</th>
                      <th>Descriptors</th>
                      <th>Last Seeded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStudents.map((s, i) => {
                      const key = `${s.className}/${s.studentName}`;
                      const isSelected = selectedIds.has(key);
                      return (
                        <tr
                          key={key}
                          className={`${isSelected ? styles.rowSelected : ''} ${!s.studentId ? styles.rowNoId : ''}`}
                          onClick={() => s.studentId && toggleStudent(key)}
                        >
                          <td className={styles.tdCheck}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleStudent(key)}
                              disabled={!s.studentId}
                            />
                          </td>
                          <td className={styles.tdName}>{s.studentName}</td>
                          <td>{s.className}</td>
                          <td className={styles.tdId}>{s.studentId || <span className={styles.noId}>No ID</span>}</td>
                          <td>{s.photoCount}</td>
                          <td>
                            {s.seeded ? (
                              <span className={`${styles.badge} ${styles.badgeSeeded}`}>✅ Seeded</span>
                            ) : (
                              <span className={`${styles.badge} ${styles.badgeUnseeded}`}>⬜ Not Seeded</span>
                            )}
                          </td>
                          <td>{s.descriptorCount || '—'}</td>
                          <td className={styles.tdDate}>
                            {s.lastSeeded ? new Date(s.lastSeeded).toLocaleDateString() : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Seed button */}
            <div className={styles.actionRow}>
              <button
                className={styles.primaryBtn}
                onClick={handleSeed}
                disabled={selectedIds.size === 0 || seeding}
              >
                🧬 Seed {selectedIds.size} Student{selectedIds.size !== 1 ? 's' : ''} to Mobile App
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Seeding Progress */}
        {currentStep === 2 && (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>
              {seeding ? '⏳ Seeding Face Descriptors…' : '✅ Seeding Complete'}
            </h2>

            <div className={styles.progressPanel}>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{
                    width: `${selectedIds.size > 0 ? (seedProgress / selectedIds.size) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className={styles.progressText}>{seedMessage}</div>

              <div className={styles.resultsList}>
                {seedResults.map((r, i) => (
                  <div
                    key={i}
                    className={`${styles.resultItem} ${r.success ? styles.resultSuccess : styles.resultFail}`}
                  >
                    <span>
                      {r.success ? '✅' : '❌'} {r.studentName}{' '}
                      <span style={{ color: '#64748b' }}>({r.className})</span>
                    </span>
                    {r.success ? (
                      <span>{r.descriptorCount} descriptor{r.descriptorCount !== 1 ? 's' : ''}</span>
                    ) : (
                      <span className={styles.resultError}>{r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {seeding && (
                <button className={styles.dangerBtn} onClick={() => { abortRef.current = true; }}>
                  ⛔ Abort
                </button>
              )}
              {!seeding && (
                <>
                  <button
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setSelectedIds(new Set());
                      setSeedResults([]);
                      setCurrentStep(1);
                    }}
                  >
                    ← Back to Students
                  </button>
                  <button
                    className={styles.primaryBtn}
                    onClick={() => {
                      selectUnseeded();
                      setCurrentStep(1);
                      setSeedResults([]);
                    }}
                  >
                    Seed More
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className={styles.footer}>
          <span>
            Descriptors are computed in your browser using face-api.js and saved to Firestore.
            The mobile PWA reads them at launch for face recognition.
          </span>
          <span className={styles.footerCopyright}>
            © 2026 BINUS School Simprug AI Club
          </span>
        </footer>
      </div>
    </>
  );
}
