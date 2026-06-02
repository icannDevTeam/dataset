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

// ─── Preview-modal styling helpers ──────────────────────────────────
const previewSectionTitle = {
  fontSize: 11, color: BRAND.textSubtle, fontWeight: 700,
  letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8,
};
const previewKvGrid = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 10,
};
const previewItemBox = {
  background: '#F8FAFC', border: '1px solid #E2E8F0',
  borderRadius: 10, padding: '10px 12px',
};
function previewKv(k, v) {
  return (
    <div style={previewItemBox} key={k}>
      <div style={{ fontSize: 10.5, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700 }}>{k}</div>
      <div style={{ fontSize: 13.5, color: '#0F172A', fontWeight: 600, marginTop: 3, wordBreak: 'break-word' }}>{v || '—'}</div>
    </div>
  );
}

// ─── Receipt builder ────────────────────────────────────────────────
// A self-contained HTML doc the parent can save to phone/computer
// or open later for reference (works fully offline once saved).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildReceiptHtml({
  formNumber, submittedAt,
  guardianName, guardianEmail, guardianPhone,
  students, chaperones, signature,
}) {
  const E = escapeHtml;
  const when = submittedAt
    ? new Date(submittedAt).toLocaleString('en-GB', {
        day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '';
  const studentRows = (students || []).map((s) => `
    <tr>
      <td>${E(s.name || '—')}</td>
      <td>${E(s.id || '—')}</td>
      <td>${E(s.grade || '')}${s.homeroom ? ' / ' + E(s.homeroom) : ''}</td>
    </tr>`).join('');
  const chapRows = (chaperones || []).map((c, i) => {
    const auth = (c.authorizedStudentIds || [])
      .map((sid) => ((students || []).find((s) => s.id === sid) || {}).name || sid)
      .join(', ');
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${E(c.name || '—')}</td>
        <td>${E(c.relation || '')}</td>
        <td>${E(c.phone || '')}</td>
        <td>${E(auth)}</td>
        <td>${(c.facePaths || []).length} photo(s)</td>
      </tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Pickup Authorization · ${E(formNumber || '')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         color:#0F172A; max-width:780px; margin:24px auto; padding:0 20px; }
  header { border-bottom:3px solid #003D7A; padding-bottom:12px; margin-bottom:18px; }
  h1 { color:#003D7A; margin:0; font-size:22px; }
  .sub { color:#64748B; font-size:12.5px; margin-top:4px; }
  .form-num { display:inline-block; margin:14px 0 22px; padding:12px 18px;
              border:2px solid #003D7A; border-radius:10px; }
  .form-num small { display:block; font-size:11px; color:#64748B; letter-spacing:1px;
                    text-transform:uppercase; font-weight:700; }
  .form-num strong { display:block; font-size:22px; color:#003D7A; letter-spacing:1px;
                     font-family:ui-monospace,SFMono-Regular,Menlo,monospace; margin-top:4px; }
  h2 { font-size:13px; color:#64748B; text-transform:uppercase; letter-spacing:1px;
       margin:20px 0 8px; border-bottom:1px solid #E2E8F0; padding-bottom:4px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid #E2E8F0; vertical-align:top; }
  th { color:#64748B; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; background:#F8FAFC; }
  .kv { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; }
  .kv .b { background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:8px 10px; }
  .kv small { display:block; font-size:10.5px; color:#64748B; text-transform:uppercase;
              letter-spacing:0.6px; font-weight:700; }
  .kv span { display:block; font-size:13px; font-weight:600; margin-top:2px; word-break:break-word; }
  .sig { font-family:"Brush Script MT","Lucida Handwriting",cursive; font-size:22px;
         color:#003D7A; padding:12px 14px; background:#F8FAFC; border:1px solid #E2E8F0;
         border-radius:8px; }
  footer { margin-top:24px; padding-top:14px; border-top:1px dashed #CBD5E1;
           color:#64748B; font-size:11.5px; }
  @media print { body { margin:0; } button { display:none; } }
</style></head><body>
<header>
  <h1>BINUS School Simprug · Pickup Authorization</h1>
  <div class="sub">Receipt of submitted pickup-authorization form</div>
</header>

<div class="form-num">
  <small>Form Number</small>
  <strong>${E(formNumber || '—')}</strong>
</div>
<div class="sub">Submitted ${E(when)}</div>

<h2>Parent / Guardian</h2>
<div class="kv">
  <div class="b"><small>Name</small><span>${E(guardianName || '—')}</span></div>
  <div class="b"><small>Email</small><span>${E(guardianEmail || '—')}</span></div>
  <div class="b"><small>Phone</small><span>${E(guardianPhone || '—')}</span></div>
</div>

<h2>Students (${(students || []).length})</h2>
<table>
  <thead><tr><th>Name</th><th>Binusian ID</th><th>Grade / Homeroom</th></tr></thead>
  <tbody>${studentRows || '<tr><td colspan="3">—</td></tr>'}</tbody>
</table>

<h2>Authorized pickup people (${(chaperones || []).length})</h2>
<table>
  <thead><tr><th>#</th><th>Name</th><th>Relation</th><th>Phone</th><th>Authorized for</th><th>Photos</th></tr></thead>
  <tbody>${chapRows || '<tr><td colspan="6">—</td></tr>'}</tbody>
</table>

<h2>Consent signature</h2>
<div class="sig">${E(signature || '—')}</div>

<footer>
  Keep this receipt for your records. For any changes — adding or removing a chaperone,
  replacing a photo, or correcting details — please visit the ACOP office on the 3rd floor
  or email <strong>inquiries.simprug@binus.edu</strong>.
</footer>
</body></html>`;
}

function downloadReceipt(payload) {
  try {
    const html = buildReceiptHtml(payload);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeNum = String(payload.formNumber || 'pickup-form').replace(/[^A-Za-z0-9_-]/g, '_');
    a.href = url;
    a.download = `BINUS-Pickup-${safeNum}.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 500);
  } catch (e) {
    alert('Could not save the receipt: ' + e.message);
  }
}

function printReceipt(payload) {
  try {
    const html = buildReceiptHtml(payload);
    const w = window.open('', '_blank', 'noopener,width=820,height=900');
    if (!w) {
      alert('Please allow pop-ups to print or save as PDF.');
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    // Give the new window a beat to render before triggering print.
    setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 250);
  } catch (e) {
    alert('Could not open print view: ' + e.message);
  }
}

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

/**
 * Compact, non-distracting banner showing the submission window for the
 * current invite link. Renders nothing when no window is set, the link
 * is unmanaged, or the API call failed (best-effort UX).
 *
 * Visual states:
 *   • not_yet_open  → soft sky tint, "Opens [date]"
 *   • closed        → soft amber tint, "This form has closed"
 *   • usable + closeAt within 7 days → amber accent emphasising countdown
 *   • usable + closeAt > 7 days     → muted navy, friendly "Open until [date]"
 */
function WindowBanner({ info }) {
  if (!info) return null;
  const { windowOpenAt, windowCloseAt, status } = info;
  if (!windowOpenAt && !windowCloseAt) return null;

  const fmt = (ms) => new Date(ms).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const now = Date.now();
  const closingSoon = windowCloseAt && (windowCloseAt - now) > 0 && (windowCloseAt - now) < 7 * 86400_000;

  let tone = { bg: '#EEF4FB', border: '#BFD7EE', accent: BRAND.navy, label: 'Submission window' };
  let title = '';
  let body = '';
  let icon = '🗓️';

  if (status === 'not_yet_open') {
    tone = { bg: '#EFF6FF', border: '#BFDBFE', accent: '#1D4ED8', label: 'Opens soon' };
    icon = '⏳';
    title = 'This form is not open yet.';
    body = `It opens on ${fmt(windowOpenAt)}. Please check back then.`;
  } else if (status === 'closed') {
    tone = { bg: '#FEF3C7', border: '#FCD34D', accent: '#92400E', label: 'Window closed' };
    icon = '🔒';
    title = 'The submission window for this form has closed.';
    body = windowCloseAt ? `It closed on ${fmt(windowCloseAt)}. Please contact the school office for assistance.` : 'Please contact the school office for assistance.';
  } else if (closingSoon) {
    tone = { bg: '#FFF7ED', border: '#FED7AA', accent: BRAND.orange, label: 'Closing soon' };
    icon = '⏰';
    title = 'Submission window closes soon';
    body = `Please complete and submit this form before ${fmt(windowCloseAt)}.`;
  } else {
    title = 'Submission window';
    const parts = [];
    if (windowOpenAt && windowOpenAt < now) parts.push(`Open since ${fmt(windowOpenAt)}`);
    else if (windowOpenAt) parts.push(`Opens ${fmt(windowOpenAt)}`);
    if (windowCloseAt) parts.push(`Closes ${fmt(windowCloseAt)}`);
    body = parts.join(' · ');
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: tone.bg, border: `1px solid ${tone.border}`,
      borderRadius: 12, padding: '12px 16px', marginBottom: 18,
    }}>
      <div style={{ fontSize: 20, lineHeight: 1, marginTop: 1 }} aria-hidden>{icon}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.6,
          textTransform: 'uppercase', color: tone.accent, marginBottom: 2,
        }}>{tone.label}</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: BRAND.text, lineHeight: 1.35 }}>{title}</div>
        {body && (
          <div style={{ fontSize: 13, color: BRAND.textMuted, marginTop: 2, lineHeight: 1.5 }}>{body}</div>
        )}
      </div>
    </div>
  );
}

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
  // Inline error for the Student section only — keeps lookup failures
  // (typo'd Binusian ID, already-registered, etc.) next to the input so
  // the parent doesn't have to scroll to the bottom of the form to see
  // what went wrong.
  const [studentError, setStudentError] = useState(null);

  const [chaperones, setChaperones] = useState([]);

  const [signature, setSignature] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  // Phase 3: welcome modal + dedupe conflict surfacing.
  const [welcomeAcked, setWelcomeAcked] = useState(true);   // default true; flipped after token validates
  const [conflict, setConflict] = useState(null);
  // Window-aware invite metadata (name, open/close, status). Populated from
  // /api/pickup/onboarding/info once the token validates. Drives the friendly
  // banner above the form and the close-date footer on the success screen.
  const [inviteInfo, setInviteInfo] = useState(null);

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
        if (probe.status === 401) {
          let reason = null;
          try { reason = (await probe.clone().json())?.reason || null; } catch { /* ignore */ }
          const msg =
            reason === 'expired'        ? 'This link has expired. Please request a new one from the school.' :
            reason === 'bad_signature'  ? 'This link is not valid (signature mismatch). It may have been mistyped or tampered with.' :
            reason === 'wrong_purpose'  ? 'This link is not valid for the pickup onboarding form.' :
            reason === 'malformed' ||
            reason === 'bad_payload' ||
            reason === 'token_missing'  ? 'This link is malformed. Please check the URL and try again.' :
            reason === 'secret_missing' ? 'The server is misconfigured. Please contact the school office.' :
                                          'This link is invalid or has expired. Please request a new one.';
          throw new Error(msg);
        }
        try {
          const body = token.split('.')[0];
          const padded = body + '='.repeat((4 - body.length % 4) % 4);
          const json = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
          if (cancel) return;
          setTenantId(json.tid || null);
          setPrimarySid(json.sid || null);
          if (json.sid) await addStudent(json.sid, true);
        } catch { /* ignore */ }
        if (!cancel) {
          setTokenOk(true);
          // Phase 3: show one-time welcome modal per browser session.
          try {
            const key = `pog-welcome-acked-${(token || '').slice(0, 24)}`;
            const acked = typeof window !== 'undefined' && sessionStorage.getItem(key) === '1';
            setWelcomeAcked(!!acked);
          } catch { setWelcomeAcked(false); }
          // Best-effort fetch of invite metadata so we can render the
          // submission window. Failures here are non-fatal — the form
          // still works against an unmanaged token.
          try {
            const infoRes = await fetch('/api/pickup/onboarding/info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            });
            if (infoRes.ok) {
              const info = await infoRes.json();
              if (!cancel) setInviteInfo(info);
            }
          } catch { /* non-fatal */ }
        }
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
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(sid)) {
      if (!silent) setStudentError('ID looks invalid (4–32 letters or digits).');
      return;
    }
    if (students.find((s) => s.id === sid)) {
      if (!silent) setStudentError('That student is already added.');
      return;
    }
    setStudentLookupBusy(true); setStudentError(null); setError(null);
    try {
      const tenantRes = await fetch('/api/pickup/onboarding/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, studentId: sid }),
      }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));

      let student = null;
      let alreadyRegistered = null;
      if (tenantRes.ok) {
        student = tenantRes.body.student;
        alreadyRegistered = tenantRes.body.alreadyRegistered || null;
      }

      // Hard-stop if a non-rejected pickup record already exists for this
      // student in our system. The server enforces the same constraint at
      // submit time (HTTP 409 + per-student lock), but blocking up-front
      // gives the parent a friendlier message.
      if (alreadyRegistered) {
        const fn = alreadyRegistered.formNumber ? ` (form #${alreadyRegistered.formNumber})` : '';
        const who = student?.name ? student.name : `Student ${sid}`;
        setStudentError(`${who} already has a pickup form${fn} — status: ${alreadyRegistered.status}. Contact the school office to change it.`);
        return;
      }

      if (!student) {
        if (!silent) setStudentError(`ID “${sid}” not found. Re-check the student card and try again.`);
        return;
      }

      setStudents((prev) => [...prev, student]);
      // Auto-include the new student in every chaperone's authorization list
      setChaperones((prev) => prev.map((c) => ({
        ...c,
        authorizedStudentIds: Array.from(new Set([...(c.authorizedStudentIds || []), student.id])),
      })));
      setStudentInputId('');
      setStudentError(null);
    } catch (e) {
      if (!silent) setStudentError(e.message || 'Lookup failed — please try again.');
    } finally { setStudentLookupBusy(false); }
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
      confirmed: false,
    }]);
  }
  function updateChaperone(idx, patch) {
    // Editing any field re-opens the card (clears confirmed)
    setChaperones((prev) => prev.map((c, i) =>
      i === idx ? { ...c, ...patch, confirmed: false } : c
    ));
  }
  function removeChaperone(idx) {
    setChaperones((prev) => prev.filter((_, i) => i !== idx));
  }
  function confirmChaperone(idx) {
    setError(null);
    const c = chaperones[idx];
    if (!c) return;
    // Mirror the server-side rules (submit.js sanitizeChaperone) so the
    // parent gets an immediate, specific error per field instead of being
    // told only at final submit. Name & phone min lengths match the API.
    const name = (c.name || '').trim();
    const phone = (c.phone || '').trim();
    if (!name) {
      setError(`Person #${idx + 1}: name is required.`);
      return;
    }
    if (name.length < 2) {
      setError(`Person #${idx + 1}: name must be at least 2 letters — please type the chaperone’s full name.`);
      return;
    }
    if (!phone) {
      setError(`Person #${idx + 1}: phone number is required.`);
      return;
    }
    // Strip spaces, dashes and parentheses for the digit count check so
    // a typical "+62 812-3456-7890" still passes.
    const phoneDigits = phone.replace(/[^0-9]/g, '');
    if (phoneDigits.length < 8) {
      setError(`Person #${idx + 1}: phone number looks too short (need at least 8 digits).`);
      return;
    }
    if (!c.relation || !String(c.relation).trim()) {
      setError(`Person #${idx + 1}: relationship is required.`);
      return;
    }
    if (c.authorizedStudentIds.length === 0) {
      setError(`Person #${idx + 1}: select at least one student they may pick up.`);
      return;
    }
    // Require at least one face photo up-front so the parent can't reach
    // the consent step only to be bounced back here. The server-side
    // sanitizer accepts 0 photos (admin can add later) but for the parent
    // self-service flow we make the photo mandatory.
    const faceCount = Array.isArray(c.facePaths) ? c.facePaths.length : 0;
    if (faceCount === 0) {
      setError(`Person #${idx + 1}: please capture at least one clear face photo before saving this person.`);
      return;
    }
    setChaperones((prev) => prev.map((x, i) =>
      i === idx ? { ...x, confirmed: true } : x
    ));
  }
  function reopenChaperone(idx) {
    setChaperones((prev) => prev.map((x, i) =>
      i === idx ? { ...x, confirmed: false } : x
    ));
  }
  function toggleChaperoneStudent(idx, sid) {
    setChaperones((prev) => prev.map((c, i) => {
      if (i !== idx) return c;
      const has = c.authorizedStudentIds.includes(sid);
      return {
        ...c,
        confirmed: false,
        authorizedStudentIds: has
          ? c.authorizedStudentIds.filter((x) => x !== sid)
          : [...c.authorizedStudentIds, sid],
      };
    }));
  }

  async function submit(e) {
    if (e && e.preventDefault) e.preventDefault();
    const err = validateBeforeSubmit();
    if (err) { setError(err); return; }
    setError(null);
    setConflict(null);
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
      if (r.status === 409 && j.error === 'student-already-registered') {
        setConflict(j);
        setShowPreview(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (!r.ok) throw new Error(j.message || j.error || 'submission failed');
      setShowPreview(false);
      setDone({ recordId: j.recordId, formNumber: j.formNumber, at: new Date().toISOString() });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  // Shared guards for both Preview and final Submit so the modal can never
  // open with invalid data and the user sees the same error in both flows.
  function validateBeforeSubmit() {
    if (chaperones.length > 5) return 'Maximum 5 authorized people.';
    if (!guardianName.trim()) return 'Your full name is required.';
    if (signature.trim().toLowerCase() !== guardianName.trim().toLowerCase()) {
      return 'Type your full name exactly as the signature.';
    }
    if (students.length === 0) return 'Add at least one student.';
    if (chaperones.length === 0) return 'Add at least one chaperone.';
    const unsaved = chaperones.findIndex((c) => !c.confirmed);
    if (unsaved !== -1) {
      return `Please tap "Save this person" on Person #${unsaved + 1} before submitting.`;
    }
    for (const c of chaperones) {
      if (!c.name.trim() || c.name.trim().length < 2) return 'Every chaperone needs a full name (at least 2 letters).';
      if (!c.phone.trim()) return `Phone number missing for ${c.name || 'a chaperone'}.`;
      if (c.authorizedStudentIds.length === 0) return `${c.name} must be authorized for at least one student.`;
      // Mandatory at the parent-form layer — see confirmChaperone() for the
      // same gate. Even though the API tolerates zero photos, we never
      // want a parent-submitted form without one because the office would
      // have to chase them again.
      const faceCount = Array.isArray(c.facePaths) ? c.facePaths.length : 0;
      if (faceCount === 0) return `${c.name || 'A chaperone'} needs at least one face photo before submitting.`;
    }
    return null;
  }

  function openPreview() {
    setError(null);
    const err = validateBeforeSubmit();
    if (err) { setError(err); return; }
    setShowPreview(true);
  }

  // Step indicator state
  const stepDone = {
    1: !!(guardianName.trim() && guardianEmail.trim() && guardianPhone.trim()),
    2: students.length > 0,
    3: chaperones.length > 0 && chaperones.every((c) => c.confirmed && c.name.trim() && c.phone.trim() && c.authorizedStudentIds.length > 0),
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

        {/* ───── Phase 3: Welcome modal ───── */}
        {tokenOk && !welcomeAcked && !done && (
          <div role="dialog" aria-modal="true" style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}>
            <div style={{
              background: '#fff', borderRadius: 16, maxWidth: 520, width: '100%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              padding: 28, fontFamily: FONT_STACK,
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: `${BRAND.orange}22`, color: BRAND.orange,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 28, fontWeight: 700, marginBottom: 14,
              }}>!</div>
              <h2 style={{ margin: 0, fontSize: 20, color: BRAND.text }}>
                Before you start — please read
              </h2>
              <div style={{ marginTop: 12, color: BRAND.textMuted, fontSize: 14, lineHeight: 1.65 }}>
                <p style={{ margin: '0 0 10px' }}>
                  This pickup-authorization form can be submitted for <strong>multiple students</strong>.
                  After submission you cannot edit it through this link.
                </p>
                <p style={{ margin: 0 }}>
                  For any changes — adding or removing a chaperone, replacing a photo,
                  or correcting details — please visit the{' '}
                  <strong style={{ color: BRAND.navy }}>ACOP office on the 3rd floor</strong>{' '}
                  or email{' '}
                  <a href="mailto:inquiries.simprug@binus.edu"
                    style={{ color: BRAND.navy, fontWeight: 700, textDecoration: 'underline' }}>
                    inquiries.simprug@binus.edu
                  </a>.
                </p>
              </div>
              <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" style={btn({ padding: '12px 24px' })}
                  onClick={() => {
                    try {
                      const key = `pog-welcome-acked-${(token || '').slice(0, 24)}`;
                      sessionStorage.setItem(key, '1');
                    } catch {}
                    setWelcomeAcked(true);
                  }}>
                  I understand, continue
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ───── Preview-before-submit modal ─────
            Shows a read-only summary of everything the parent has filled
            in. Submitting from here is the same code path as the form's
            Submit button (no second validate needed — openPreview already
            ran the guards). */}
        {showPreview && (
          <div role="dialog" aria-modal="true" style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15,23,42,0.65)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: 16, overflowY: 'auto',
          }}
          onClick={() => !submitting && setShowPreview(false)}>
            <div onClick={(e) => e.stopPropagation()} style={{
              background: '#fff', borderRadius: 16, maxWidth: 720, width: '100%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
              padding: 0, fontFamily: FONT_STACK, marginTop: 24, marginBottom: 24,
              overflow: 'hidden',
            }}>
              {/* Header */}
              <div style={{
                background: `linear-gradient(135deg, ${BRAND.navy} 0%, ${BRAND.navyLight} 100%)`,
                color: '#fff', padding: '20px 24px',
              }}>
                <div style={{ fontSize: 12, opacity: 0.85, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 700 }}>
                  Review before submitting
                </div>
                <h2 style={{ margin: '4px 0 0', fontSize: 20 }}>
                  Pickup Authorization — Preview
                </h2>
                <div style={{ fontSize: 12.5, opacity: 0.9, marginTop: 4 }}>
                  Please double-check the details below. Once you submit, this form cannot be edited through this link.
                </div>
              </div>

              {/* Body */}
              <div style={{ padding: '20px 24px', maxHeight: '65vh', overflowY: 'auto' }}>
                {/* Guardian */}
                <div style={{ marginBottom: 22 }}>
                  <div style={previewSectionTitle}>Parent / Guardian</div>
                  <div style={previewKvGrid}>
                    {previewKv('Full name', guardianName)}
                    {previewKv('Email', guardianEmail)}
                    {previewKv('Phone', guardianPhone)}
                  </div>
                </div>

                {/* Students */}
                <div style={{ marginBottom: 22 }}>
                  <div style={previewSectionTitle}>
                    Students ({students.length})
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {students.map((s) => (
                      <div key={s.id} style={previewItemBox}>
                        <div style={{ fontWeight: 700, color: BRAND.text, fontSize: 14 }}>
                          {s.name || '—'}
                        </div>
                        <div style={{ color: BRAND.textSubtle, fontSize: 12.5, marginTop: 2 }}>
                          Binusian ID {s.id}
                          {s.grade && <> · Grade {s.grade}</>}
                          {s.homeroom && <> · {s.homeroom}</>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Chaperones */}
                <div style={{ marginBottom: 22 }}>
                  <div style={previewSectionTitle}>
                    Authorized pickup people ({chaperones.length})
                  </div>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {chaperones.map((c, i) => {
                      const authNames = c.authorizedStudentIds
                        .map((sid) => (students.find((s) => s.id === sid) || {}).name || sid)
                        .filter(Boolean);
                      const relLabel = (RELATIONS.find((r) => r.v === c.relation) || {}).l || c.relation || '—';
                      return (
                        <div key={c.tempId} style={previewItemBox}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontWeight: 700, color: BRAND.text, fontSize: 14 }}>
                                {i + 1}. {c.name || '—'}
                              </div>
                              <div style={{ color: BRAND.textSubtle, fontSize: 12.5, marginTop: 2 }}>
                                {relLabel} · {c.phone || 'no phone'}
                                {c.email && <> · {c.email}</>}
                                {c.idNumber && <> · ID {c.idNumber}</>}
                              </div>
                              <div style={{ color: BRAND.textMuted, fontSize: 12.5, marginTop: 6 }}>
                                <strong style={{ color: BRAND.text }}>Authorized for:</strong>{' '}
                                {authNames.length ? authNames.join(', ') : '—'}
                              </div>
                              <div style={{ color: BRAND.textSubtle, fontSize: 12, marginTop: 4 }}>
                                {c.facePaths.length > 0
                                  ? `📷 ${c.facePaths.length} face photo${c.facePaths.length === 1 ? '' : 's'} attached`
                                  : '📷 No photos yet — ACOP can capture at the office'}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Signature */}
                <div style={{ marginBottom: 6 }}>
                  <div style={previewSectionTitle}>Consent signature</div>
                  <div style={{
                    ...previewItemBox,
                    fontFamily: '"Brush Script MT", "Lucida Handwriting", cursive',
                    fontSize: 22, color: BRAND.navy, padding: '14px 16px',
                  }}>
                    {signature || '—'}
                  </div>
                  <div style={{ color: BRAND.textSubtle, fontSize: 11.5, marginTop: 6 }}>
                    By submitting, you confirm the information above is accurate and you authorize these adults to pick up the listed children.
                  </div>
                </div>

                {error && (
                  <div style={{
                    marginTop: 14, padding: '10px 14px',
                    background: BRAND.dangerBg, color: BRAND.danger,
                    fontSize: 13.5, borderRadius: 8,
                    border: `1px solid ${BRAND.danger}33`,
                  }}>{error}</div>
                )}
              </div>

              {/* Footer */}
              <div style={{
                padding: '14px 24px', borderTop: `1px solid ${BRAND.border}`,
                background: BRAND.surfaceAlt,
                display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
              }}>
                <button type="button"
                  style={btnSecondary({ padding: '12px 18px', fontSize: 14 })}
                  disabled={submitting}
                  onClick={() => setShowPreview(false)}>
                  ← Back to edit
                </button>
                <button type="button"
                  style={btn({ padding: '12px 22px', fontSize: 14, background: BRAND.success })}
                  disabled={submitting}
                  onClick={() => submit()}>
                  {submitting ? 'Submitting…' : '✓ Confirm & submit'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ───── Phase 3: Dedupe conflict modal ───── */}
        {conflict && (
          <div role="dialog" aria-modal="true" style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}>
            <div style={{
              background: '#fff', borderRadius: 16, maxWidth: 540, width: '100%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              padding: 28, fontFamily: FONT_STACK,
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: BRAND.dangerBg, color: BRAND.danger,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 28, fontWeight: 700, marginBottom: 14,
              }}>!</div>
              <h2 style={{ margin: 0, fontSize: 20, color: BRAND.danger }}>
                Already registered
              </h2>
              <div style={{ marginTop: 12, color: BRAND.textMuted, fontSize: 14, lineHeight: 1.65 }}>
                <p style={{ margin: '0 0 12px' }}>{conflict.message}</p>
                {Array.isArray(conflict.conflicts) && conflict.conflicts.length > 0 && (
                  <div style={{
                    background: BRAND.surfaceAlt, border: `1px solid ${BRAND.border}`,
                    borderRadius: 8, padding: 12, marginBottom: 12,
                  }}>
                    {conflict.conflicts.map((c, i) => (
                      <div key={i} style={{ fontSize: 13, marginBottom: i < conflict.conflicts.length - 1 ? 8 : 0 }}>
                        <div style={{ fontWeight: 700, color: BRAND.text }}>{c.studentName}</div>
                        <div style={{ color: BRAND.textSubtle, fontSize: 12, marginTop: 2 }}>
                          Binusian ID {c.studentId}
                          {c.formNumber && (
                            <> · Existing form{' '}
                              <code style={{
                                background: '#fff', padding: '1px 6px', borderRadius: 4,
                                fontWeight: 700, color: BRAND.navy,
                              }}>{c.formNumber}</code>
                            </>
                          )}
                          {c.status && <> · {c.status}</>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p style={{ margin: 0, fontSize: 13.5 }}>
                  For any changes please visit the{' '}
                  <strong style={{ color: BRAND.navy }}>ACOP office on the 3rd floor</strong>{' '}
                  or email{' '}
                  <a href="mailto:inquiries.simprug@binus.edu"
                    style={{ color: BRAND.navy, fontWeight: 700, textDecoration: 'underline' }}>
                    inquiries.simprug@binus.edu
                  </a>.
                </p>
              </div>
              <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" style={btn({ padding: '12px 24px' })}
                  onClick={() => setConflict(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

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
                Pickup System · Authorized Pickup Registration
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

              {done.formNumber && (
                <div style={{
                  margin: '16px 0', padding: '14px 18px',
                  background: '#fff', border: `2px solid ${BRAND.navy}`,
                  borderRadius: 10, display: 'inline-block',
                }}>
                  <div style={{ fontSize: 11, color: BRAND.textMuted, fontWeight: 700,
                    letterSpacing: 1, textTransform: 'uppercase' }}>
                    Form Number
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: BRAND.navy,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    letterSpacing: 1, marginTop: 4 }}>
                    {done.formNumber}
                  </div>
                </div>
              )}

              {/* Save / print receipt — placed RIGHT under the form number
                  so it's the first thing parents see and act on, before
                  the long disclaimer text. Pure client-side blob so it
                  works even with weak signal at the gate later. */}
              <div style={{
                margin: '6px 0 18px',
                background: '#fff',
                border: `1.5px solid ${BRAND.success}`,
                borderRadius: 12, padding: 14,
                display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
              }}>
                <div style={{
                  fontSize: 13, fontWeight: 700, color: BRAND.success,
                  marginRight: 'auto',
                }}>
                  Save your form for later →
                </div>
                <button type="button"
                  style={btn({ padding: '10px 18px', fontSize: 13.5, background: BRAND.navy })}
                  onClick={() => downloadReceipt({
                    formNumber: done.formNumber,
                    submittedAt: done.at,
                    guardianName, guardianEmail, guardianPhone,
                    students, chaperones, signature,
                  })}>
                  Download receipt
                </button>
                <button type="button"
                  style={btnSecondary({ padding: '10px 18px', fontSize: 13.5 })}
                  onClick={() => printReceipt({
                    formNumber: done.formNumber,
                    submittedAt: done.at,
                    guardianName, guardianEmail, guardianPhone,
                    students, chaperones, signature,
                  })}>
                  Print / Save as PDF
                </button>
                {done.formNumber && (
                  <button type="button"
                    style={btnGhost({ padding: '10px 18px', fontSize: 13.5 })}
                    onClick={async () => {
                      try {
                        if (navigator.clipboard) {
                          await navigator.clipboard.writeText(done.formNumber);
                        } else {
                          // Fallback for older browsers
                          const ta = document.createElement('textarea');
                          ta.value = done.formNumber;
                          document.body.appendChild(ta);
                          ta.select(); document.execCommand('copy');
                          ta.remove();
                        }
                      } catch {}
                    }}>
                    Copy form number
                  </button>
                )}
              </div>

              <p style={{ color: '#166534', fontSize: 14, lineHeight: 1.6 }}>
                Please save the form number above for your reference. The school
                office will review your submission. Once approved, each authorized
                adult will be activated at the gate. A confirmation will be sent to{' '}
                <strong>{guardianEmail}</strong>.
              </p>
              <p style={{ color: '#166534', fontSize: 13, lineHeight: 1.6, marginBottom: 0 }}>
                <strong>Need to make changes?</strong> Please visit the{' '}
                <strong>ACOP office on the 3rd floor</strong> or email{' '}
                <a href="mailto:inquiries.simprug@binus.edu"
                  style={{ color: '#166534', fontWeight: 700, textDecoration: 'underline' }}>
                  inquiries.simprug@binus.edu
                </a>. This form can only be submitted once per student.
              </p>

              {inviteInfo?.windowCloseAt && (
                <p style={{
                  color: '#166534', fontSize: 12, marginTop: 14, marginBottom: 0,
                  paddingTop: 12, borderTop: '1px dashed #86EFAC',
                }}>
                  <span style={{ opacity: 0.75 }}>Submission window closes</span>{' '}
                  <strong>
                    {new Date(inviteInfo.windowCloseAt).toLocaleString('en-GB', {
                      day: '2-digit', month: 'long', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </strong>
                </p>
              )}
            </div>
          )}

          {!loading && tokenOk && !done && (
            <>
              {/* ── Submission window banner (only when admin has set dates) ── */}
              <WindowBanner info={inviteInfo} />

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

              <form onSubmit={(e) => { e.preventDefault(); openPreview(); }}>
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
                    'Type the Binusian ID. We’ll auto-fill the name and class.')}

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
                          padding: '12px 16px',
                          background: BRAND.surfaceAlt,
                          borderRadius: 8,
                          border: `1px solid ${BRAND.border}`,
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          gap: 12,
                        }}>
                          <div>
                            <div style={{ fontWeight: 600, color: BRAND.text }}>
                              {s.name || '—'}
                            </div>
                            <div style={{ fontSize: 12, color: BRAND.textSubtle, marginTop: 2 }}>
                              Binusian ID {s.id}{s.homeroom ? ` · ${s.homeroom}` : ''}
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

                  <div style={{
                    padding: 14, border: `1px solid ${BRAND.border}`,
                    borderRadius: 10, background: BRAND.surfaceAlt,
                  }}>
                    <label style={label()}>Binusian ID *</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input style={{
                          ...input(),
                          flex: 1,
                          ...(studentError ? { borderColor: BRAND.danger } : {}),
                        }}
                        placeholder="e.g. 2270005673"
                        value={studentInputId}
                        onChange={(e) => { setStudentInputId(e.target.value); if (studentError) setStudentError(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStudent(); } }} />
                      <button type="button" style={btn()}
                        onClick={() => addStudent()} disabled={studentLookupBusy || !studentInputId.trim()}>
                        {studentLookupBusy ? 'Looking up…' : 'Look up'}
                      </button>
                    </div>

                    {/* Inline lookup error — sits right under the input
                        so the parent doesn't have to scroll. */}
                    {studentError && (
                      <div role="alert" style={{
                        marginTop: 8, padding: '8px 12px',
                        background: BRAND.dangerBg, color: BRAND.danger,
                        fontSize: 13, lineHeight: 1.45, borderRadius: 6,
                        border: `1px solid ${BRAND.danger}33`,
                      }}>{studentError}</div>
                    )}
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
                      border: `1px solid ${c.confirmed ? BRAND.success : BRAND.border}`,
                      borderRadius: 12,
                      padding: 18, marginBottom: 14,
                      background: c.confirmed ? BRAND.successBg : BRAND.surfaceAlt,
                      transition: 'background 0.15s ease, border-color 0.15s ease',
                    }}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center', marginBottom: c.confirmed ? 0 : 14,
                      }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                          <span style={{
                            width: 28, height: 28, borderRadius: '50%',
                            background: c.confirmed ? BRAND.success : BRAND.orange, color: '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontWeight: 700, fontSize: 13,
                          }}>{c.confirmed ? '✓' : idx + 1}</span>
                          <div>
                            <strong style={{ color: BRAND.text, fontSize: 15 }}>
                              {c.name || `Person #${idx + 1}`}
                            </strong>
                            {c.confirmed && (
                              <div style={{ color: BRAND.textSubtle, fontSize: 12, marginTop: 2 }}>
                                {c.relation || 'pickup'} · {c.phone}
                                {c.authorizedStudentIds.length > 0 && (
                                  <> · authorized for {c.authorizedStudentIds.length} student{c.authorizedStudentIds.length === 1 ? '' : 's'}</>
                                )}
                                {c.facePaths.length > 0 && (
                                  <> · {c.facePaths.length} photo{c.facePaths.length === 1 ? '' : 's'}</>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {c.confirmed && (
                            <button type="button" style={btnSecondary({ padding: '6px 12px', fontSize: 13 })}
                              onClick={() => reopenChaperone(idx)}>Edit</button>
                          )}
                          <button type="button" style={btnDanger({ padding: '6px 12px', fontSize: 13 })}
                            onClick={() => removeChaperone(idx)}>Remove</button>
                        </div>
                      </div>

                      {!c.confirmed && (
                        <>
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
                          <select style={input()}
                            value={RELATIONS.some((r) => r.v === c.relation) ? c.relation : '__custom__'}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === '__custom__') {
                                updateChaperone(idx, { relation: '' });
                              } else {
                                updateChaperone(idx, { relation: v });
                              }
                            }}>
                            {RELATIONS.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
                            <option value="__custom__">Other (type custom…)</option>
                          </select>
                          {!RELATIONS.some((r) => r.v === c.relation) && (
                            <input style={{ ...input(), marginTop: 8 }}
                              placeholder="Type relationship (e.g. uncle, aunt, godparent)"
                              value={c.relation}
                              onChange={(e) => updateChaperone(idx, { relation: e.target.value })} />
                          )}
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
                        <label style={label()}>
                          Face photos <span style={{ color: BRAND.danger, fontWeight: 600 }}>*</span>{' '}
                          <span style={{ fontWeight: 400, color: BRAND.textSubtle }}>
                            (at least 1 clear photo — used by the gate camera to recognise this person)
                          </span>
                        </label>
                        <ChaperoneFaceCapture
                          tempId={c.tempId}
                          token={token}
                          onPhotos={(paths) => updateChaperone(idx, { facePaths: paths })}
                          disabled={submitting}
                        />
                      </div>

                      {/* Save this person — locks the card so the parent
                          gets a clear "this one is done" moment before
                          adding another or signing. */}
                      <div style={{
                        marginTop: 18, paddingTop: 14,
                        borderTop: `1px dashed ${BRAND.border}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: 10, flexWrap: 'wrap',
                      }}>
                        <span style={{ color: BRAND.textSubtle, fontSize: 12.5 }}>
                          Done filling in this person? Save them so you can add another or sign.
                        </span>
                        <button type="button"
                          style={btn({ padding: '10px 20px', fontSize: 14, background: BRAND.success })}
                          onClick={() => confirmChaperone(idx)}>
                          ✓ Save this person
                        </button>
                      </div>
                        </>
                      )}
                    </div>
                  ))}

                  <button type="button" style={btnSecondary()} onClick={addChaperone}
                    disabled={
                      students.length === 0 ||
                      chaperones.length >= 5 ||
                      chaperones.some((c) => !c.confirmed)
                    }
                    title={chaperones.some((c) => !c.confirmed)
                      ? 'Save the current person above before adding another'
                      : ''}>
                    {chaperones.length >= 5
                      ? 'Maximum 5 people'
                      : chaperones.some((c) => !c.confirmed)
                        ? 'Save current person above first'
                        : '+ Add another person (max 5)'}
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

                  <div style={{
                    marginTop: 20, display: 'flex', justifyContent: 'flex-end',
                    gap: 10, flexWrap: 'wrap',
                  }}>
                    {/* Single primary action — keeps the flow linear:
                        fill in everything → preview → confirm & submit.
                        The actual /submit POST happens only inside the
                        preview modal, so parents always get a chance to
                        review before anything leaves their phone. */}
                    <button type="submit" style={btn({ padding: '14px 30px', fontSize: 15 })}
                      disabled={submitting}>
                      Preview & submit →
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
            <span style={{ color: BRAND.orange, fontWeight: 600 }}> Pickup System</span>
          </p>
        </main>
      </div>
    </>
  );
}
