import React, { useState } from 'react';
import styles from '../styles/enrollment.module.css';

export default function EnrollmentPage({ onStudentData }) {
  const [mode, setMode] = useState('api'); // 'api' or 'manual'
  const [binusianId, setBinusianId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [studentInfo, setStudentInfo] = useState(null);

  // Manual input fields
  const [manualName, setManualName] = useState('Albert Arthur');
  const [manualId, setManualId] = useState('TEST-001');
  const [manualClass, setManualClass] = useState('4C');
  const [manualGrade, setManualGrade] = useState('EL 4');

  const handleRetrieve = async (e) => {
    e.preventDefault();
    
    if (!binusianId.trim()) {
      setError('Please enter a Binusian ID');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/student/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: binusianId.trim() }),
      });

      const data = await response.json();

      if (data.success) {
        const info = {
          name: data.name,
          homeroom: data.homeroom,
          gradeCode: data.gradeCode || '',
          gradeName: data.gradeName || '',
        };
        setStudentInfo(info);

        // Save metadata to Firebase
        await fetch('/api/student/metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: data.id || binusianId.trim(),
            studentName: info.name,
            className: info.homeroom,
            gradeCode: info.gradeCode,
            gradeName: info.gradeName,
          }),
        });
      } else {
        setError(data.error || data.message || 'Student not found. Please check the ID.');
      }
    } catch (err) {
      setError('Failed to retrieve student data. Please try again.');
      console.error('API Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();

    if (!manualName.trim() || !manualClass.trim()) {
      setError('Name and Class are required');
      return;
    }

    const info = {
      name: manualName.trim(),
      homeroom: manualClass.trim(),
      gradeCode: '',
      gradeName: manualGrade.trim(),
    };
    setStudentInfo(info);
    setBinusianId(manualId.trim() || `MANUAL-${Date.now()}`);
    setError('');

    // Try saving metadata to Firebase (non-blocking)
    try {
      await fetch('/api/student/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: manualId.trim() || `MANUAL-${Date.now()}`,
          studentName: info.name,
          className: info.homeroom,
          gradeCode: info.gradeCode,
          gradeName: info.gradeName,
        }),
      });
    } catch (_) {
      // metadata save is optional for manual mode
    }
  };

  const handleCapture = () => {
    if (studentInfo) {
      onStudentData({
        studentId: binusianId.trim() || manualId.trim(),
        studentName: studentInfo.name,
        className: studentInfo.homeroom,
        gradeCode: studentInfo.gradeCode,
        gradeName: studentInfo.gradeName,
      });
    }
  };

  const handleNewStudent = () => {
    setBinusianId('');
    setStudentInfo(null);
    setError('');
  };

  const switchMode = (newMode) => {
    setMode(newMode);
    setStudentInfo(null);
    setError('');
  };

  return (
    <div className={styles.enrollmentContainer}>
      <div className={styles.enrollmentCard}>
        <h1 className={styles.title}>Facial Attendance System</h1>
        <p className={styles.subtitle}>Enroll student details, then capture face photos</p>

        {/* Mode toggle */}
        {!studentInfo && (
          <div className={styles.modeToggle}>
            <button
              className={`${styles.modeButton} ${mode === 'api' ? styles.modeActive : ''}`}
              onClick={() => switchMode('api')}
            >
              API Lookup
            </button>
            <button
              className={`${styles.modeButton} ${mode === 'manual' ? styles.modeActive : ''}`}
              onClick={() => switchMode('manual')}
            >
              Manual Input
            </button>
          </div>
        )}

        {!studentInfo ? (
          <>
            {/* ── API Lookup Mode ── */}
            {mode === 'api' && (
              <form onSubmit={handleRetrieve} className={styles.form}>
                <div className={styles.formGroup}>
                  <label htmlFor="binusianId" className={styles.label}>
                    Binusian ID
                  </label>
                  <input
                    id="binusianId"
                    type="text"
                    value={binusianId}
                    onChange={(e) => setBinusianId(e.target.value)}
                    placeholder="Enter student ID (e.g. 2401234567)"
                    className={styles.input}
                    disabled={loading}
                    autoFocus
                  />
                </div>

                {error && <div className={styles.error}>{error}</div>}

                <button
                  type="submit"
                  className={styles.button}
                  disabled={loading || !binusianId.trim()}
                >
                  {loading ? 'Retrieving...' : 'Retrieve Student Data'}
                </button>
              </form>
            )}

            {/* ── Manual Input Mode ── */}
            {mode === 'manual' && (
              <form onSubmit={handleManualSubmit} className={styles.form}>
                <div className={styles.formGroup}>
                  <label htmlFor="manualName" className={styles.label}>
                    Full Name <span className={styles.required}>*</span>
                  </label>
                  <input
                    id="manualName"
                    type="text"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder="e.g. Albert Arthur"
                    className={styles.input}
                    autoFocus
                  />
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="manualId" className={styles.label}>
                    Student ID
                  </label>
                  <input
                    id="manualId"
                    type="text"
                    value={manualId}
                    onChange={(e) => setManualId(e.target.value)}
                    placeholder="e.g. 2401234567 (optional)"
                    className={styles.input}
                  />
                </div>

                <div className={styles.formRow}>
                  <div className={styles.formGroup}>
                    <label htmlFor="manualClass" className={styles.label}>
                      Class / Homeroom <span className={styles.required}>*</span>
                    </label>
                    <input
                      id="manualClass"
                      type="text"
                      value={manualClass}
                      onChange={(e) => setManualClass(e.target.value)}
                      placeholder="e.g. 4C"
                      className={styles.input}
                    />
                  </div>

                  <div className={styles.formGroup}>
                    <label htmlFor="manualGrade" className={styles.label}>
                      Grade
                    </label>
                    <input
                      id="manualGrade"
                      type="text"
                      value={manualGrade}
                      onChange={(e) => setManualGrade(e.target.value)}
                      placeholder="e.g. EL 4"
                      className={styles.input}
                    />
                  </div>
                </div>

                {error && <div className={styles.error}>{error}</div>}

                <button
                  type="submit"
                  className={styles.button}
                  disabled={!manualName.trim() || !manualClass.trim()}
                >
                  Confirm Details
                </button>
              </form>
            )}
          </>
        ) : (
          <div className={styles.studentInfo}>
            {mode === 'manual' && (
              <div className={styles.manualBadge}>Manual Entry</div>
            )}
            <div className={styles.infoCard}>
              <div className={styles.infoRow}>
                <span className={styles.label}>Name:</span>
                <span className={styles.value}>{studentInfo.name}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.label}>Class:</span>
                <span className={styles.value}>{studentInfo.homeroom}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.label}>Grade:</span>
                <span className={styles.value}>{studentInfo.gradeName}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.label}>Student ID:</span>
                <span className={styles.value}>{binusianId || manualId}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.label}>Attendance Label:</span>
                <span className={styles.value} style={{ color: '#667eea', fontWeight: 700 }}>
                  {studentInfo.name} {studentInfo.homeroom}
                </span>
              </div>
            </div>

            <div className={styles.buttonGroup}>
              <button onClick={handleCapture} className={styles.primaryButton}>
                Proceed to Capture
              </button>
              <button onClick={handleNewStudent} className={styles.secondaryButton}>
                Enter Another Student
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
