import React, { useState, useRef, useEffect, useCallback } from 'react';
import styles from '../styles/capture.module.css';

const POSITIONS = ['front', 'left', 'right'];
const JPEG_QUALITY = 0.92;

export default function CapturePage({ studentData, onBack, onUploadComplete }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [capturedImages, setCapturedImages] = useState({});
  const [currentPosition, setCurrentPosition] = useState(0);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [cameras, setCameras] = useState([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [cameraLabel, setCameraLabel] = useState('');

  // Enumerate available video devices
  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      setCameras(videoDevices);
      console.log('Available cameras:', videoDevices.map(d => `${d.label || 'Unnamed'} [${d.deviceId.slice(0, 8)}]`));
      return videoDevices;
    } catch (err) {
      console.error('Failed to enumerate cameras:', err);
      return [];
    }
  }, []);

  // Start a specific camera by deviceId (or best available)
  const startCamera = useCallback(async (deviceId) => {
    // Stop any existing stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setCameraReady(false);
    setError('');

    const tryConstraints = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await new Promise((resolve) => {
          videoRef.current.onloadedmetadata = () => {
            videoRef.current.play();
            resolve();
          };
        });
      }
      // Read the active track label
      const track = stream.getVideoTracks()[0];
      const label = track?.label || 'Unknown Camera';
      const settings = track?.getSettings?.() || {};
      setCameraLabel(`${label} (${settings.width || '?'}×${settings.height || '?'})`);
      setSelectedCameraId(track?.getSettings?.()?.deviceId || deviceId || '');
      setCameraReady(true);
      console.log(`Camera started: ${label}`, settings);
      return stream;
    };

    // Attempt 1: specific device with high-res constraints
    if (deviceId) {
      try {
        return await tryConstraints({
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1280, min: 640 },
            height: { ideal: 720, min: 480 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
      } catch (err) {
        console.warn(`High-res failed for device ${deviceId}, trying basic:`, err.message);
        try {
          return await tryConstraints({
            video: { deviceId: { exact: deviceId } },
            audio: false,
          });
        } catch (err2) {
          console.error(`Device ${deviceId} failed entirely:`, err2.message);
        }
      }
    }

    // Attempt 2: no facingMode constraint (picks any available camera)
    try {
      return await tryConstraints({
        video: {
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (err) {
      console.warn('Standard constraints failed, trying bare minimum:', err.message);
    }

    // Attempt 3: absolute fallback
    try {
      return await tryConstraints({ video: true, audio: false });
    } catch (err) {
      setError('Failed to access any camera. Check permissions and that the camera is connected.');
      console.error('All camera attempts failed:', err);
    }
  }, []);

  // Initial camera setup: enumerate, prefer external camera, then start
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // Check if getUserMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('Camera access is not supported in this browser. Please use a modern browser with HTTPS.');
        return;
      }

      // Trigger a permission prompt first (needed to get device labels)
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tempStream.getTracks().forEach(t => t.stop());
      } catch (permErr) {
        console.error('Camera permission error:', permErr.name, permErr.message);
        if (permErr.name === 'NotAllowedError') {
          setError('Camera access denied. Please allow camera permissions in your browser settings and reload the page.');
        } else if (permErr.name === 'NotFoundError') {
          setError('No camera found on this device.');
        } else if (permErr.name === 'NotReadableError') {
          setError('Camera is in use by another application. Please close other apps using the camera and try again.');
        } else {
          setError(`Camera error: ${permErr.message || permErr.name}`);
        }
        return;
      }

      if (cancelled) return;

      const videoDevices = await enumerateCameras();
      if (cancelled) return;

      if (videoDevices.length === 0) {
        setError('No cameras detected. Please connect a camera and refresh.');
        return;
      }

      // Prefer external / USB camera: pick any that is NOT labelled as
      // "built-in", "integrated", "IR", or "facing front"
      const externalCam = videoDevices.find(d => {
        const lbl = (d.label || '').toLowerCase();
        return lbl && !lbl.includes('built-in') && !lbl.includes('integrated')
          && !lbl.includes('ir ') && !lbl.includes('front');
      });

      const preferred = externalCam || videoDevices[videoDevices.length - 1];
      console.log('Selected camera:', preferred.label || preferred.deviceId);
      await startCamera(preferred.deviceId);
    };

    init();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle camera switch from dropdown
  const handleCameraChange = (e) => {
    const deviceId = e.target.value;
    setSelectedCameraId(deviceId);
    startCamera(deviceId);
  };

  // Capture with countdown
  const startCapture = useCallback(() => {
    if (loading || !cameraReady) return;

    setCountdown(3);
    setError('');
    let count = 3;
    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        setCountdown(count);
      } else {
        clearInterval(interval);
        setCountdown(null);
        captureImage();
      }
    }, 700);
  }, [loading, cameraReady, currentPosition]);

  // Take the actual photo — no OpenCV, no cropping, just a clean camera capture
  const captureImage = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    setLoading(true);
    setError('');

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    // Use native video resolution for high quality
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    if (canvas.width === 0 || canvas.height === 0) {
      setError('Camera not ready yet. Please wait.');
      setLoading(false);
      return;
    }

    // Draw full frame — no processing, no cropping
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert to high-quality JPEG
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError('Failed to capture photo. Try again.');
          setLoading(false);
          return;
        }

        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        const position = POSITIONS[currentPosition];
        const sizeKB = Math.round(blob.size / 1024);

        setCapturedImages(prev => ({
          ...prev,
          [position]: {
            dataUrl,
            blob,
            width: canvas.width,
            height: canvas.height,
            sizeKB,
            timestamp: Date.now(),
          },
        }));

        setSuccess(`✓ ${position.charAt(0).toUpperCase() + position.slice(1)} photo captured (${canvas.width}×${canvas.height}, ${sizeKB}KB)`);
        setLoading(false);

        // Auto-advance to next position after 1.5s
        setTimeout(() => {
          setSuccess('');
          if (currentPosition < POSITIONS.length - 1) {
            setCurrentPosition(currentPosition + 1);
          }
        }, 1500);
      },
      'image/jpeg',
      JPEG_QUALITY
    );
  }, [currentPosition]);

  const deleteImage = (position) => {
    setCapturedImages(prev => {
      const updated = { ...prev };
      delete updated[position];
      return updated;
    });
    setSuccess('');
  };

  const retakeImage = (position) => {
    const posIndex = POSITIONS.indexOf(position);
    setCurrentPosition(posIndex);
    deleteImage(position);
  };

  // Upload all captured images to Firebase
  const handleUpload = async () => {
    const imageEntries = Object.entries(capturedImages);
    if (imageEntries.length === 0) {
      setError('Please capture at least one image');
      return;
    }

    setUploading(true);
    setError('');
    setSuccess('');

    try {
      let uploaded = 0;
      const total = imageEntries.length;

      for (let i = 0; i < imageEntries.length; i++) {
        const [position, imgData] = imageEntries[i];

        const formData = new FormData();
        formData.append('studentId', studentData.studentId);
        formData.append('studentName', studentData.studentName);
        formData.append('className', studentData.className);
        formData.append('gradeCode', studentData.gradeCode || '');
        formData.append('gradeName', studentData.gradeName || '');
        formData.append('photoNumber', String(i + 1));
        formData.append('totalPhotos', String(total));
        formData.append('image', imgData.blob, `${studentData.studentName}_${position}.jpg`);

        setSuccess(`Uploading ${position}... (${i + 1}/${total})`);

        const res = await fetch('/api/face/upload', { method: 'POST', body: formData });
        if (res.ok) {
          uploaded++;
        } else {
          const errData = await res.json().catch(() => ({}));
          console.error(`Upload ${position} failed:`, errData);
        }
      }

      if (uploaded === total) {
        setSuccess(`✓ All ${uploaded} photos uploaded to Firebase!`);
        setTimeout(() => onUploadComplete(), 2000);
      } else if (uploaded > 0) {
        setSuccess(`${uploaded}/${total} photos uploaded. Some failed.`);
        setTimeout(() => onUploadComplete(), 2000);
      } else {
        setError('Upload failed. Please try again.');
      }
    } catch (err) {
      setError('Error uploading images. Please try again.');
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
    }
  };

  const captureProgress = Object.keys(capturedImages).length;
  const allCaptured = captureProgress === POSITIONS.length;

  return (
    <div className={styles.captureContainer}>
      <div className={styles.header}>
        <h1 className={styles.title}>Face Capture</h1>
        <p className={styles.subtitle}>
          {studentData.studentName} — {studentData.className}
        </p>
      </div>

      <div className={styles.mainContent}>
        {/* Video / Camera Section */}
        <div className={styles.cameraSection}>
          {/* Camera selector */}
          {cameras.length > 1 && (
            <div className={styles.cameraSelector}>
              <label htmlFor="cameraSelect" className={styles.cameraSelectorLabel}>Camera:</label>
              <select
                id="cameraSelect"
                value={selectedCameraId}
                onChange={handleCameraChange}
                className={styles.cameraSelectorDropdown}
                disabled={uploading}
              >
                {cameras.map((cam, idx) => (
                  <option key={cam.deviceId} value={cam.deviceId}>
                    {cam.label || `Camera ${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}
          {cameras.length <= 1 && cameraLabel && (
            <div className={styles.cameraInfo}>{cameraLabel}</div>
          )}

          <div className={styles.videoWrapper}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={styles.video}
            />
            {!cameraReady && !error && <div className={styles.cameraLoading}>Initializing camera...</div>}
            {!cameraReady && error && (
              <div className={styles.cameraLoading} style={{ color: '#f87171', fontSize: '0.9rem', padding: '1.5rem' }}>
                ⚠️ {error}
                <br /><br />
                <button
                  onClick={() => { setError(''); window.location.reload(); }}
                  style={{
                    padding: '8px 16px', background: 'rgba(248,113,113,0.2)',
                    color: '#f87171', border: '1px solid rgba(248,113,113,0.4)',
                    borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem'
                  }}
                >
                  Retry
                </button>
              </div>
            )}

            {/* Face guide overlay */}
            <svg className={styles.faceGuide} viewBox="0 0 640 480" preserveAspectRatio="none">
              <defs>
                <mask id="guideMask">
                  <rect width="640" height="480" fill="white" />
                  <ellipse cx="320" cy="220" rx="115" ry="155" fill="black" />
                </mask>
              </defs>
              <rect width="640" height="480" fill="rgba(0,0,0,0.2)" mask="url(#guideMask)" />
              <ellipse cx="320" cy="220" rx="115" ry="155" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeDasharray="8 4" />
              <text x="320" y="420" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="14" fontFamily="sans-serif">
                Position face inside the oval
              </text>
            </svg>

            {/* Countdown overlay */}
            {countdown && (
              <div className={styles.countdownOverlay}>
                <div className={styles.countdownNumber}>{countdown}</div>
              </div>
            )}
          </div>

          <canvas ref={canvasRef} style={{ display: 'none' }} />

          <div className={styles.cameraControls}>
            {/* Position guide */}
            <div className={styles.positionIndicator}>
              {POSITIONS[currentPosition] === 'front' && 'Look straight at the camera'}
              {POSITIONS[currentPosition] === 'left' && 'Turn your head slightly to the LEFT'}
              {POSITIONS[currentPosition] === 'right' && 'Turn your head slightly to the RIGHT'}
              {' — '}
              <span className={styles.positionName}>{POSITIONS[currentPosition].toUpperCase()}</span>
            </div>

            <div className={styles.progressBar}>
              {POSITIONS.map((pos, idx) => (
                <div
                  key={pos}
                  className={`${styles.progressDot} ${
                    capturedImages[pos] ? styles.completed : idx === currentPosition ? styles.active : ''
                  }`}
                >
                  {capturedImages[pos] ? '✓' : pos.charAt(0).toUpperCase()}
                </div>
              ))}
            </div>

            {error && <div className={styles.error}>{error}</div>}
            {success && <div className={styles.success}>{success}</div>}

            <button
              onClick={startCapture}
              disabled={loading || !cameraReady || countdown !== null || uploading}
              className={styles.captureButton}
            >
              {countdown !== null
                ? `Get ready... ${countdown}`
                : loading
                  ? 'Processing...'
                  : allCaptured
                    ? 'All positions captured ✓'
                    : `Capture ${POSITIONS[currentPosition].toUpperCase()}`
              }
            </button>
          </div>
        </div>

        {/* Images Lineup Section */}
        <div className={styles.imagesSection}>
          <h3 className={styles.imagesTitle}>Captured Photos ({captureProgress}/{POSITIONS.length})</h3>
          
          <div className={styles.imagesList}>
            {POSITIONS.map(position => (
              <div key={position} className={styles.imageItem}>
                <div className={styles.imageLabel}>{position.toUpperCase()}</div>
                
                {capturedImages[position] ? (
                  <div className={styles.imageWrapper}>
                    <img
                      src={capturedImages[position].dataUrl}
                      alt={position}
                      className={styles.capturedImage}
                    />
                    <div className={styles.imageMeta}>
                      {capturedImages[position].width}×{capturedImages[position].height} • {capturedImages[position].sizeKB}KB
                    </div>
                    <div className={styles.imageActions}>
                      <button
                        onClick={() => retakeImage(position)}
                        className={styles.retakeButton}
                        disabled={uploading}
                      >
                        Retake
                      </button>
                      <button
                        onClick={() => deleteImage(position)}
                        className={styles.deleteButton}
                        disabled={uploading}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.placeholder}>No image</div>
                )}
              </div>
            ))}
          </div>

          {captureProgress > 0 && (
            <div className={styles.footerActions}>
              <button
                onClick={onBack}
                className={styles.backButton}
                disabled={uploading}
              >
                Back
              </button>
              
              <button
                onClick={handleUpload}
                disabled={uploading || captureProgress === 0}
                className={`${styles.uploadButton} ${allCaptured ? styles.complete : ''}`}
              >
                {uploading
                  ? 'Uploading...'
                  : `Upload ${captureProgress} Photo${captureProgress !== 1 ? 's' : ''} to Firebase`
                }
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Upload success overlay */}
      {success && success.includes('uploaded to Firebase') && (
        <div className={styles.successOverlay}>
          <div className={styles.successMessage}>{success}</div>
        </div>
      )}
    </div>
  );
}
