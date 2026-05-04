/**
 * /pickup/onboarding/[token] — Parent-driven chaperone onboarding.
 *
 * Public (no Firebase Auth). HMAC-signed token carries
 *   { tid, sid?, exp, p:'pickup-onboarding' }.
 *
 * Brand: BINUS School Simprug — navy #003D7A primary, orange #F58220 accent.
 * Capture: camera OR file upload (with previews + per-photo delete).
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

// ─── Brand tokens ────────────────────────────────────────────────────
const BRAND = {
  navy:        '#003D7A',
  navyDark:    '#002A55',
  navyLight:   '#1A55A0',
  orange:      '#F58220',
  orangeLight: '#FF9D45',
  bg:          '#F4F6FB',
  surface:     '#FFFFFF',
  surfaceAlt:  '#F8FAFC',
  border:      '#E2E8F0',
  borderStrong:'#CBD5E1',
  text:        '#0F172A',
  textMuted:   '#475569',
  textSubtle:  '#64748B',
  success:     '#15803D',
  successBg:   '#ECFDF5',
  danger:      '#B91C1C',
  dangerBg:    '#FEF2F2',
};

const RELATIONS = [
  { v: 'mother', l: 'Mother' },
  { v: 'father', l: 'Father' },
  { v: 'guardian', l: 'Legal guardian' },
  { v: 'driver', l: 'Family driver' },
  { v: 'nanny', l: 'Nanny / au pair' },
  { v: 'grandparent', l: 'Grandparent' },
  { v: 'sibling', l: 'Adult sibling' },
  { v: 'emergency', l: 'Emergency contact' },
  { v: 'other', l: 'Other' },
];

const FONT_STACK =
  '"Plus Jakarta Sans", "Inter", -apple-system, BlinkMacSystemFont, ' +
  '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// ─── Style helpers ───────────────────────────────────────────────────
function uid() {
  return 'tmp-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const card = (extra = {}) => ({
  background: BRAND.surface,
  border: `1px solid ${BRAND.border}`,
  borderRadius: 14,
  padding: '22px 24px',
  marginBottom: 18,
  boxShadow: '0 1px 3px rgba(15,23,42,0.04), 0 1px 2px rgba(15,23,42,0.03)',
  ...extra,
});

const label = (extra = {}) => ({
  display: 'block', fontSize: 13, color: BRAND.textMuted,
  marginBottom: 6, fontWeight: 600, letterSpacing: 0.1,
  ...extra,
});

const input = (extra = {}) => ({
  width: '100%', padding: '11px 14px',
  border: `1px solid ${BRAND.borderStrong}`,
  borderRadius: 8, fontSize: 14, color: BRAND.text,
  fontFamily: 'inherit', boxSizing: 'border-box',
  background: BRAND.surface, transition: 'all 0.15s ease',
  outline: 'none',
  ...extra,
});

const btn = (extra = {}) => ({
  padding: '10px 20px',
  border: 'none',
  background: BRAND.navy,
  color: '#fff',
  borderRadius: 8,
  fontSize: 14,
  cursor: 'pointer',
  fontWeight: 600,
  fontFamily: 'inherit',
  letterSpacing: 0.2,
  transition: 'background 0.15s ease, transform 0.05s ease',
  ...extra,
});
const btnSecondary = (extra = {}) => btn({
  background: BRAND.surface, color: BRAND.navy,
  border: `1.5px solid ${BRAND.navy}`, ...extra,
});
const btnGhost = (extra = {}) => btn({
  background: 'transparent', color: BRAND.textMuted,
  border: `1px solid ${BRAND.border}`, ...extra,
});
const btnDanger = (extra = {}) => btn({
  background: BRAND.surface, color: BRAND.danger,
  border: `1.5px solid ${BRAND.danger}`,
  padding: '6px 12px', fontSize: 12, ...extra,
});
const btnAccent = (extra = {}) => btn({
  background: BRAND.orange,
  color: '#fff',
  ...extra,
});

const sectionHeading = (n, title, subtitle) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16 }}>
    <div style={{
      flexShrink: 0,
      width: 38, height: 38, borderRadius: '50%',
      background: BRAND.navy, color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, fontSize: 15,
    }}>{n}</div>
    <div>
      <h2 style={{ margin: 0, fontSize: 18, color: BRAND.text, fontWeight: 700 }}>
        {title}
      </h2>
      {subtitle && (
        <p style={{ margin: '4px 0 0', fontSize: 13, color: BRAND.textSubtle }}>
          {subtitle}
        </p>
      )}
    </div>
  </div>
);

// ─── Reference example portrait (inline SVG, no external fetch) ─────
function ReferencePortrait({ ok = true }) {
  const stroke = ok ? BRAND.navy : BRAND.danger;
  return (
    <svg width="64" height="78" viewBox="0 0 64 78" aria-hidden="true">
      <rect x="2" y="2" width="60" height="74" rx="8"
            fill={ok ? '#EAF2FB' : '#FEF2F2'} stroke={stroke} strokeWidth="1.5" />
      <circle cx="32" cy="30" r="11" fill="#fff" stroke={stroke} strokeWidth="1.5" />
      <path d="M14 70 C 16 54 26 46 32 46 C 38 46 48 54 50 70"
            fill="#fff" stroke={stroke} strokeWidth="1.5" />
      {ok ? (
        <path d="M27 31 c 1 1 3 2 5 2 s 4 -1 5 -2"
              stroke={stroke} fill="none" strokeWidth="1.3" strokeLinecap="round" />
      ) : (
        <>
          <path d="M22 30 L 28 30" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M36 30 L 42 30" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M27 35 l 5 -2 l 5 2" stroke={stroke} strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

// ─── Photo guidelines panel ─────────────────────────────────────────
function PhotoGuidelines() {
  return (
    <div style={{
      background: BRAND.surfaceAlt,
      border: `1px solid ${BRAND.border}`,
      borderRadius: 10, padding: 14, marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          width: 22, height: 22, borderRadius: '50%',
          background: BRAND.orange, color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700,
        }}>i</span>
        <strong style={{ color: BRAND.text, fontSize: 13 }}>Photo guidelines</strong>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <ReferencePortrait ok={true} />
          <div style={{ fontSize: 11, color: BRAND.success, marginTop: 4, fontWeight: 600 }}>
            ✓ Acceptable
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <ReferencePortrait ok={false} />
          <div style={{ fontSize: 11, color: BRAND.danger, marginTop: 4, fontWeight: 600 }}>
            ✗ Avoid
          </div>
        </div>
        <ul style={{
          listStyle: 'none', padding: 0, margin: 0, fontSize: 12.5,
          color: BRAND.textMuted, flex: 1, minWidth: 200, lineHeight: 1.7,
        }}>
          <li>• Face centered, looking at camera</li>
          <li>• Even, bright lighting (no backlight)</li>
          <li>• Neutral expression, eyes open</li>
          <li>• No sunglasses, hats, or face coverings</li>
          <li>• 1–3 photos from slightly different angles</li>
          <li>• Recent photo (within 12 months)</li>
        </ul>
      </div>
    </div>
  );
}

// ─── Chaperone face capture (camera + upload) ───────────────────────
function ChaperoneFaceCapture({ tempId, token, onPhotos, disabled }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const [mode, setMode] = useState('camera'); // 'camera' | 'upload'
  const [streaming, setStreaming] = useState(false);
  const [photos, setPhotos] = useState([]);   // [{path, dataUrl}]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const MAX_PHOTOS = 3;
  const MAX_FILE_BYTES = 600 * 1024;

  function setAndEmit(next) {
    setPhotos(next);
    onPhotos(next.map((p) => p.path));
  }

  async function startCam() {
    try {
      setErr(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }, audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setStreaming(true);
      }
    } catch (e) { setErr('Cannot access camera: ' + e.message); }
  }
  function stopCam() {
    const v = videoRef.current;
    if (v && v.srcObject) {
      v.srcObject.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
    setStreaming(false);
  }
  useEffect(() => () => stopCam(), []); // eslint-disable-line
  useEffect(() => { if (mode !== 'camera') stopCam(); }, [mode]);

  async function uploadDataUrl(dataUrl) {
    const r = await fetch('/api/pickup/onboarding/face', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token, tempId, photoIndex: photos.length, imageBase64: dataUrl,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'upload failed');
    return j.path;
  }

  async function captureFromCamera() {
    if (!videoRef.current || !canvasRef.current) return;
    if (photos.length >= MAX_PHOTOS) { setErr(`Maximum ${MAX_PHOTOS} photos.`); return; }
    setBusy(true); setErr(null);
    try {
      const v = videoRef.current, c = canvasRef.current;
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      const path = await uploadDataUrl(dataUrl);
      setAndEmit([...photos, { path, dataUrl }]);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  // Downscale a File to max 800px width to fit under 600KB cap.
  function fileToScaledDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('cannot read file'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('not a valid image'));
        img.onload = () => {
          const MAX_W = 800;
          const scale = Math.min(1, MAX_W / img.width);
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    if (photos.length >= MAX_PHOTOS) { setErr(`Maximum ${MAX_PHOTOS} photos.`); return; }
    setBusy(true); setErr(null);
    try {
      const remaining = MAX_PHOTOS - photos.length;
      const accepted = Array.from(files).slice(0, remaining);
      const next = [...photos];
      for (const f of accepted) {
        if (!/^image\/(jpeg|jpg|png|webp)$/i.test(f.type)) {
          throw new Error(`${f.name}: only JPG, PNG or WebP allowed`);
        }
        if (f.size > 8 * 1024 * 1024) {
          throw new Error(`${f.name}: file too large (max 8 MB)`);
        }
        const dataUrl = await fileToScaledDataUrl(f);
        const approxBytes = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
        if (approxBytes > MAX_FILE_BYTES) {
          throw new Error(`${f.name}: image too large after compression`);
        }
        const path = await uploadDataUrl(dataUrl);
        next.push({ path, dataUrl });
        setAndEmit([...next]);
      }
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  function removePhoto(idx) {
    const next = photos.filter((_, i) => i !== idx);
    setAndEmit(next);
  }

  const TabBtn = ({ id, icon, children }) => (
    <button type="button" onClick={() => setMode(id)} disabled={disabled}
      style={{
        flex: 1, padding: '10px 14px',
        border: 'none', cursor: 'pointer',
        background: mode === id ? BRAND.surface : 'transparent',
        color: mode === id ? BRAND.navy : BRAND.textMuted,
        fontWeight: 600, fontSize: 13,
        borderBottom: mode === id ? `2px solid ${BRAND.navy}` : '2px solid transparent',
        transition: 'all 0.15s ease', fontFamily: 'inherit',
      }}>
      <span style={{ marginRight: 6 }}>{icon}</span>{children}
    </button>
  );

  return (
    <div>
      <PhotoGuidelines />

      <div style={{
        border: `1px solid ${BRAND.border}`, borderRadius: 10,
        overflow: 'hidden', background: BRAND.surfaceAlt,
      }}>
        <div style={{ display: 'flex', borderBottom: `1px solid ${BRAND.border}`, background: BRAND.surfaceAlt }}>
          <TabBtn id="camera" icon="📷">Use Camera</TabBtn>
          <TabBtn id="upload" icon="📁">Upload File</TabBtn>
        </div>

        <div style={{ padding: 16, background: BRAND.surface }}>
          {mode === 'camera' ? (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{
                position: 'relative',
                background: '#000', width: 320, height: 240,
                borderRadius: 8, overflow: 'hidden',
                border: `1px solid ${BRAND.borderStrong}`,
              }}>
                <video ref={videoRef} muted playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'cover',
                           transform: 'scaleX(-1)' }} />
                {!streaming && (
                  <div style={{
                    position: 'absolute', inset: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    color: '#94a3b8', fontSize: 13,
                  }}>Camera off</div>
                )}
                {streaming && (
                  <div style={{
                    position: 'absolute', inset: 0, pointerEvents: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <div style={{
                      width: 150, height: 200, border: '2px dashed rgba(245,130,32,0.85)',
                      borderRadius: '50%',
                    }} />
                  </div>
                )}
              </div>
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              <div style={{ flex: 1, minWidth: 200 }}>
                {!streaming ? (
                  <button type="button" style={btnSecondary()} onClick={startCam} disabled={disabled}>
                    Open camera
                  </button>
                ) : (
                  <>
                    <button type="button" style={btnAccent()}
                      onClick={captureFromCamera}
                      disabled={busy || disabled || photos.length >= MAX_PHOTOS}>
                      {busy ? 'Uploading…' : `📸 Capture (${photos.length}/${MAX_PHOTOS})`}
                    </button>
                    <button type="button" style={{ ...btnGhost(), marginLeft: 8 }} onClick={stopCam}>
                      Stop
                    </button>
                  </>
                )}
                <p style={{ fontSize: 12, color: BRAND.textSubtle, marginTop: 12, lineHeight: 1.6 }}>
                  Position your face inside the orange oval. Take 1–3 photos with
                  slight head turns left and right.
                </p>
              </div>
            </div>
          ) : (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragOver(false);
                handleFiles(e.dataTransfer.files);
              }}
              style={{
                border: `2px dashed ${dragOver ? BRAND.orange : BRAND.borderStrong}`,
                background: dragOver ? '#FFF7ED' : BRAND.surfaceAlt,
                borderRadius: 10, padding: '32px 16px', textAlign: 'center',
                transition: 'all 0.15s ease', cursor: 'pointer',
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>📤</div>
              <div style={{ fontWeight: 600, color: BRAND.text, fontSize: 14 }}>
                Drop a photo here, or click to choose
              </div>
              <div style={{ fontSize: 12, color: BRAND.textSubtle, marginTop: 6 }}>
                JPG, PNG or WebP · Up to 8 MB · Auto-compressed
              </div>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp"
                multiple style={{ display: 'none' }}
                onChange={(e) => handleFiles(e.target.files)} disabled={disabled} />
              {busy && (
                <div style={{ fontSize: 12, color: BRAND.navy, marginTop: 10 }}>
                  Uploading…
                </div>
              )}
            </div>
          )}

          {err && (
            <div style={{
              marginTop: 12, padding: '8px 12px',
              background: BRAND.dangerBg, color: BRAND.danger,
              fontSize: 13, borderRadius: 6,
              border: `1px solid ${BRAND.danger}33`,
            }}>{err}</div>
          )}

          {photos.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: BRAND.textMuted, fontWeight: 600, marginBottom: 8 }}>
                Uploaded photos ({photos.length}/{MAX_PHOTOS})
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {photos.map((p, i) => (
                  <div key={i} style={{
                    position: 'relative',
                    width: 88, height: 88, borderRadius: 8,
                    overflow: 'hidden',
                    border: `1.5px solid ${BRAND.success}`,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                  }}>
                    <img src={p.dataUrl} alt={`Photo ${i + 1}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button type="button"
                      onClick={() => removePhoto(i)} disabled={disabled}
                      title="Remove"
                      style={{
                        position: 'absolute', top: 3, right: 3,
                        width: 22, height: 22, borderRadius: '50%',
                        border: 'none', background: 'rgba(185,28,28,0.92)',
                        color: '#fff', fontSize: 13, fontWeight: 700,
                        cursor: 'pointer', lineHeight: 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────
export default function PickupOnboardingPage() {
  const router = useRouter();
  const { token } = router.query;

  const [loading, setLoading] = useState(true);
  const [tokenOk, setTokenOk] = useState(false);
  const [tenantId, setTenantId] = useState(null);
  const [primarySid, setPrimarySid] = useState(null);
  const [error, setError] = useState(null);

  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');

  const [studentInputId, setStudentInputId] = useState('');
  const [studentLookupBusy, setStudentLookupBusy] = useState(false);
  const [students, setStudents] = useState([]);

  const [chaperones, setChaperones] = useState([]);

  const [signature, setSignature] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  // Validate token + auto-fill primary student
  useEffect(() => {
    if (!token) return;
    let cancel = false;
    (async () => {
      try {
        setLoading(true);
        const probe = await fetch('/api/pickup/onboarding/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, studentId: 'PROBE-INVALID-FORMAT-zz' }),
        });
        if (probe.status === 401) throw new Error('Link is invalid or has expired. Please request a new one.');
        try {
          const body = token.split('.')[0];
          const padded = body + '='.repeat((4 - body.length % 4) % 4);
          const json = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
          if (cancel) return;
          setTenantId(json.tid || null);
          setPrimarySid(json.sid || null);
          if (json.sid) await addStudent(json.sid, true);
        } catch { /* ignore */ }
        if (!cancel) setTokenOk(true);
      } catch (e) {
        if (!cancel) setError(e.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function addStudent(sidOverride, silent = false) {
    const sid = (sidOverride || studentInputId || '').trim();
    if (!sid) return;
    if (students.find((s) => s.id === sid)) {
      if (!silent) setError('That student is already added.');
      return;
    }
    setStudentLookupBusy(true); setError(null);
    try {
      const r = await fetch('/api/pickup/onboarding/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, studentId: sid }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'lookup failed');
      setStudents((prev) => [...prev, j.student]);
      setStudentInputId('');
    } catch (e) { if (!silent) setError(e.message); }
    finally { setStudentLookupBusy(false); }
  }

  function removeStudent(id) {
    if (id === primarySid) {
      setError('The primary student from your link cannot be removed.');
      return;
    }
    setStudents((prev) => prev.filter((s) => s.id !== id));
    setChaperones((prev) => prev.map((c) => ({
      ...c,
      authorizedStudentIds: (c.authorizedStudentIds || []).filter((sid) => sid !== id),
    })));
  }

  function addChaperone() {
    setChaperones((prev) => [...prev, {
      tempId: uid(),
      name: '', relation: 'mother', phone: '', email: '', idNumber: '',
      authorizedStudentIds: students.map((s) => s.id),
      facePaths: [],
    }]);
  }
  function updateChaperone(idx, patch) {
    setChaperones((prev) => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
  }
  function removeChaperone(idx) {
    setChaperones((prev) => prev.filter((_, i) => i !== idx));
  }
  function toggleChaperoneStudent(idx, sid) {
    setChaperones((prev) => prev.map((c, i) => {
      if (i !== idx) return c;
      const has = c.authorizedStudentIds.includes(sid);
      return {
        ...c,
        authorizedStudentIds: has
          ? c.authorizedStudentIds.filter((x) => x !== sid)
          : [...c.authorizedStudentIds, sid],
      };
    }));
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!guardianName.trim()) return setError('Your full name is required.');
    if (signature.trim().toLowerCase() !== guardianName.trim().toLowerCase()) {
      return setError('Type your full name exactly as the signature.');
    }
    if (students.length === 0) return setError('Add at least one student.');
    if (chaperones.length === 0) return setError('Add at least one chaperone.');
    for (const c of chaperones) {
      if (!c.name.trim()) return setError('Every chaperone needs a name.');
      if (!c.phone.trim()) return setError(`Phone number missing for ${c.name || 'a chaperone'}.`);
      if (c.authorizedStudentIds.length === 0) return setError(`${c.name} must be authorized for at least one student.`);
      if (c.facePaths.length === 0) return setError(`${c.name} needs at least one face photo.`);
    }
    setSubmitting(true);
    try {
      const r = await fetch('/api/pickup/onboarding/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          guardianName, guardianEmail, guardianPhone,
          students, chaperones,
          consentSignature: signature,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'submission failed');
      setDone({ recordId: j.recordId, at: new Date().toISOString() });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  // Step indicator state
  const stepDone = {
    1: !!(guardianName.trim() && guardianEmail.trim() && guardianPhone.trim()),
    2: students.length > 0,
    3: chaperones.length > 0 && chaperones.every((c) => c.facePaths.length > 0 && c.name.trim()),
    4: !!done,
  };

  return (
    <>
      <Head>
        <title>Pickup Authorization · BINUS School Simprug</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <style>{`
        input:focus, select:focus, textarea:focus {
          border-color: ${BRAND.navy} !important;
          box-shadow: 0 0 0 3px ${BRAND.navy}22 !important;
        }
        button:hover:not(:disabled) { filter: brightness(0.95); }
        button:active:not(:disabled) { transform: translateY(1px); }
        button:disabled { opacity: 0.55; cursor: not-allowed; }
        @media (max-width: 640px) {
          .pog-grid-2 { grid-template-columns: 1fr !important; }
          .pog-header-title { font-size: 18px !important; }
          .pog-header-sub { font-size: 12px !important; }
        }
      `}</style>

      <div style={{
        minHeight: '100vh', background: BRAND.bg,
        fontFamily: FONT_STACK, color: BRAND.text,
      }}>
        <header style={{
          background: `linear-gradient(135deg, ${BRAND.navy} 0%, ${BRAND.navyLight} 100%)`,
          color: '#fff',
          padding: '20px 24px',
          boxShadow: '0 2px 8px rgba(0,61,122,0.15)',
        }}>
          <div style={{
            maxWidth: 880, margin: '0 auto',
            display: 'flex', alignItems: 'center', gap: 16,
          }}>
            <div style={{
              background: '#fff', borderRadius: 10,
              padding: 6, display: 'flex',
              boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
            }}>
              <img src="/binus-logo.jpg" alt="BINUS School Simprug"
                style={{ height: 44, width: 44, objectFit: 'contain', borderRadius: 6 }} />
            </div>
            <div>
              <div className="pog-header-title" style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.2 }}>
                BINUS School Simprug
              </div>
              <div className="pog-header-sub" style={{ fontSize: 13, opacity: 0.85, marginTop: 2 }}>
                PickupGuard · Authorized Pickup Registration
              </div>
            </div>
          </div>
        </header>

        <main style={{ maxWidth: 880, margin: '0 auto', padding: '28px 16px 60px' }}>
          {loading && (
            <div style={card({ textAlign: 'center', color: BRAND.textMuted })}>
              Validating your link…
            </div>
          )}

          {!loading && !tokenOk && (
            <div style={card({ borderColor: '#FECACA', background: BRAND.dangerBg })}>
              <strong style={{ color: BRAND.danger, fontSize: 16 }}>
                Cannot open this link
              </strong>
              <p style={{ color: '#7F1D1D', marginBottom: 0, marginTop: 8 }}>
                {error || 'Invalid or expired token.'}
              </p>
            </div>
          )}

          {!loading && tokenOk && done && (
            <div style={card({
              borderColor: '#86EFAC', background: BRAND.successBg,
              padding: '32px 28px',
            })}>
              <div style={{
                width: 60, height: 60, borderRadius: '50%',
                background: BRAND.success, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 32, marginBottom: 16, fontWeight: 700,
              }}>✓</div>
              <h2 style={{ color: BRAND.success, marginTop: 0, fontSize: 22 }}>
                Submission received
              </h2>
              <p style={{ color: '#166534', fontSize: 14, lineHeight: 1.6 }}>
                Your reference: <code style={{
                  background: '#fff', padding: '2px 8px', borderRadius: 4,
                  fontWeight: 600, fontSize: 13, color: BRAND.text,
                }}>{done.recordId}</code>
              </p>
              <p style={{ color: '#166534', fontSize: 14, lineHeight: 1.6 }}>
                The school office will review your submission. Once approved,
                each authorized adult will be activated at the gate. A
                confirmation will be sent to <strong>{guardianEmail}</strong>.
              </p>
            </div>
          )}

          {!loading && tokenOk && !done && (
            <>
              <div style={{
                display: 'flex', gap: 8, marginBottom: 22,
                background: BRAND.surface, padding: 8, borderRadius: 12,
                border: `1px solid ${BRAND.border}`,
              }}>
                {[
                  { n: 1, l: 'Guardian' },
                  { n: 2, l: 'Students' },
                  { n: 3, l: 'Chaperones' },
                  { n: 4, l: 'Confirm' },
                ].map((s) => {
                  const isDone = stepDone[s.n];
                  return (
                    <div key={s.n} style={{
                      flex: 1, textAlign: 'center', padding: '8px 4px',
                      borderRadius: 8,
                      background: isDone ? `${BRAND.navy}10` : 'transparent',
                    }}>
                      <div style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 26, height: 26, borderRadius: '50%',
                        background: isDone ? BRAND.success : BRAND.borderStrong,
                        color: '#fff', fontSize: 12, fontWeight: 700,
                        marginRight: 8,
                      }}>{isDone ? '✓' : s.n}</div>
                      <span style={{
                        fontSize: 13, fontWeight: 600,
                        color: isDone ? BRAND.navy : BRAND.textMuted,
                      }}>{s.l}</span>
                    </div>
                  );
                })}
              </div>

              <form onSubmit={submit}>
                <div style={card()}>
                  {sectionHeading(1, 'Your information',
                    'The parent or legal guardian making this request.')}
                  <div className="pog-grid-2" style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
                  }}>
                    <div>
                      <label style={label()}>Full name *</label>
                      <input style={input()} value={guardianName}
                        onChange={(e) => setGuardianName(e.target.value)} required />
                    </div>
                    <div>
                      <label style={label()}>Phone *</label>
                      <input style={input()} value={guardianPhone}
                        onChange={(e) => setGuardianPhone(e.target.value)} required />
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={label()}>Email *</label>
                      <input style={input()} type="email" value={guardianEmail}
                        onChange={(e) => setGuardianEmail(e.target.value)} required />
                    </div>
                  </div>
                </div>

                <div style={card()}>
                  {sectionHeading(2, 'Your child(ren)',
                    'Add by Student ID. Your link already includes one student.')}

                  {students.length === 0 ? (
                    <div style={{
                      padding: 16, background: BRAND.surfaceAlt, borderRadius: 8,
                      color: BRAND.textSubtle, fontSize: 13, textAlign: 'center',
                    }}>
                      No students added yet.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                      {students.map((s) => (
                        <div key={s.id} style={{
                          padding: '12px 16px', background: BRAND.surfaceAlt,
                          borderRadius: 8, border: `1px solid ${BRAND.border}`,
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          gap: 12,
                        }}>
                          <div>
                            <div style={{ fontWeight: 600, color: BRAND.text }}>{s.name}</div>
                            <div style={{ fontSize: 12, color: BRAND.textSubtle, marginTop: 2 }}>
                              ID {s.id}{s.homeroom ? ` · ${s.homeroom}` : ''}
                              {s.id === primarySid && (
                                <span style={{
                                  marginLeft: 8, background: BRAND.orange, color: '#fff',
                                  padding: '2px 8px', borderRadius: 10, fontSize: 10,
                                  fontWeight: 700, letterSpacing: 0.3,
                                }}>PRIMARY</span>
                              )}
                            </div>
                          </div>
                          {s.id !== primarySid && (
                            <button type="button" style={btnDanger()}
                              onClick={() => removeStudent(s.id)}>Remove</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8 }}>
                    <input style={{ ...input(), flex: 1 }}
                      placeholder="Add another student by ID (e.g. 2270005673)"
                      value={studentInputId}
                      onChange={(e) => setStudentInputId(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStudent(); } }} />
                    <button type="button" style={btnSecondary()}
                      onClick={() => addStudent()} disabled={studentLookupBusy}>
                      {studentLookupBusy ? '…' : 'Add'}
                    </button>
                  </div>
                </div>

                <div style={card()}>
                  {sectionHeading(3, 'Authorized pickup people',
                    'Yourself, your spouse, the family driver, nanny, etc. Each person needs a face photo.')}

                  {chaperones.length === 0 && (
                    <div style={{
                      padding: 18, background: BRAND.surfaceAlt, borderRadius: 8,
                      color: BRAND.textSubtle, fontSize: 13, textAlign: 'center',
                      border: `1px dashed ${BRAND.borderStrong}`, marginBottom: 14,
                    }}>
                      No people added yet. Click below to add your first authorized adult.
                    </div>
                  )}

                  {chaperones.map((c, idx) => (
                    <div key={c.tempId} style={{
                      border: `1px solid ${BRAND.border}`, borderRadius: 12,
                      padding: 18, marginBottom: 14, background: BRAND.surfaceAlt,
                    }}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center', marginBottom: 14,
                      }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <span style={{
                            width: 28, height: 28, borderRadius: '50%',
                            background: BRAND.orange, color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontWeight: 700, fontSize: 13,
                          }}>{idx + 1}</span>
                          <strong style={{ color: BRAND.text, fontSize: 15 }}>
                            {c.name || `Person #${idx + 1}`}
                          </strong>
                        </div>
                        <button type="button" style={btnDanger()}
                          onClick={() => removeChaperone(idx)}>Remove</button>
                      </div>

                      <div className="pog-grid-2" style={{
                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
                      }}>
                        <div>
                          <label style={label()}>Full name *</label>
                          <input style={input()} value={c.name}
                            onChange={(e) => updateChaperone(idx, { name: e.target.value })} />
                        </div>
                        <div>
                          <label style={label()}>Relation *</label>
                          <select style={input()} value={c.relation}
                            onChange={(e) => updateChaperone(idx, { relation: e.target.value })}>
                            {RELATIONS.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={label()}>Phone *</label>
                          <input style={input()} value={c.phone}
                            onChange={(e) => updateChaperone(idx, { phone: e.target.value })} />
                        </div>
                        <div>
                          <label style={label()}>ID / KTP # (optional)</label>
                          <input style={input()} value={c.idNumber}
                            onChange={(e) => updateChaperone(idx, { idNumber: e.target.value })} />
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={label()}>Email (optional)</label>
                          <input style={input()} type="email" value={c.email}
                            onChange={(e) => updateChaperone(idx, { email: e.target.value })} />
                        </div>
                      </div>

                      <div style={{ marginTop: 16 }}>
                        <label style={label()}>Authorized to pick up *</label>
                        {students.length === 0 ? (
                          <p style={{ color: BRAND.textSubtle, fontSize: 13 }}>
                            Add students above first.
                          </p>
                        ) : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {students.map((s) => {
                              const checked = c.authorizedStudentIds.includes(s.id);
                              return (
                                <label key={s.id} style={{
                                  display: 'inline-flex', alignItems: 'center',
                                  padding: '6px 12px',
                                  border: `1.5px solid ${checked ? BRAND.navy : BRAND.borderStrong}`,
                                  background: checked ? `${BRAND.navy}10` : BRAND.surface,
                                  color: checked ? BRAND.navy : BRAND.textMuted,
                                  borderRadius: 20, fontSize: 13, fontWeight: 500,
                                  cursor: 'pointer', userSelect: 'none',
                                  transition: 'all 0.15s ease',
                                }}>
                                  <input type="checkbox" checked={checked}
                                    onChange={() => toggleChaperoneStudent(idx, s.id)}
                                    style={{ marginRight: 6 }} />
                                  {s.name}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div style={{ marginTop: 18 }}>
                        <label style={label()}>Face photos *</label>
                        <ChaperoneFaceCapture
                          tempId={c.tempId}
                          token={token}
                          onPhotos={(paths) => updateChaperone(idx, { facePaths: paths })}
                          disabled={submitting}
                        />
                      </div>
                    </div>
                  ))}

                  <button type="button" style={btnSecondary()} onClick={addChaperone}
                    disabled={students.length === 0}>
                    + Add another person
                  </button>
                </div>

                <div style={card()}>
                  {sectionHeading(4, 'Review and sign',
                    'Read the consent statement, then type your name to sign.')}

                  <div style={{
                    background: BRAND.surfaceAlt, border: `1px solid ${BRAND.border}`,
                    borderRadius: 8, padding: 16, marginBottom: 16,
                  }}>
                    <p style={{ margin: 0, color: BRAND.textMuted, fontSize: 13.5, lineHeight: 1.7 }}>
                      By signing below, I confirm that:
                    </p>
                    <ul style={{
                      color: BRAND.textMuted, fontSize: 13, lineHeight: 1.7,
                      margin: '8px 0 0', paddingLeft: 20,
                    }}>
                      <li>The information above is accurate and complete.</li>
                      <li>I have the legal right to authorize these people to pick up my child(ren).</li>
                      <li>I understand BINUS School will enroll their face photos in a recognition system used solely at the pickup gate.</li>
                      <li>I can revoke any person's authorization at any time by contacting the school office.</li>
                      <li>I have read the BINUS School Simprug Privacy Policy regarding chaperone biometric data.</li>
                    </ul>
                  </div>

                  <label style={label()}>Type your full name to sign *</label>
                  <input style={input()} value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                    placeholder={guardianName || 'Your full name'} />

                  {error && (
                    <div style={{
                      marginTop: 14, padding: '10px 14px',
                      background: BRAND.dangerBg, color: BRAND.danger,
                      fontSize: 13.5, borderRadius: 8,
                      border: `1px solid ${BRAND.danger}33`,
                    }}>{error}</div>
                  )}

                  <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
                    <button type="submit" style={btn({ padding: '14px 28px', fontSize: 15 })}
                      disabled={submitting}>
                      {submitting ? 'Submitting…' : 'Submit for school approval →'}
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}

          <p style={{
            color: BRAND.textSubtle, fontSize: 11, textAlign: 'center',
            marginTop: 24,
          }}>
            BINUS School Simprug · {tenantId || '—'} ·
            <span style={{ color: BRAND.orange, fontWeight: 600 }}> PickupGuard</span>
          </p>
        </main>
      </div>
    </>
  );
}
