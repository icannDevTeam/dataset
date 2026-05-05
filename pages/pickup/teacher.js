import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { signOut as fbSignOut } from '../../lib/firebase-client';

const POLL_MS = 2000;
const AUTO_RELEASE_MS = 3000;
const BINUS_MAROON = '#8B1538';
const BINUS_GOLD = '#FCBF11';

const STATE_THEME = {
  green: {
    border: '#22C55E',
    bg: 'rgba(34,197,94,0.08)',
    label: 'AUTHORIZED BY SYSTEM',
    icon: '✓',
  },
  yellow: {
    border: '#FCBF11',
    bg: 'rgba(252,191,17,0.08)',
    label: 'VERIFY IDENTITY',
    icon: '⚠',
  },
  red: {
    border: '#EF4444',
    bg: 'rgba(239,68,68,0.08)',
    label: 'BLOCKED - IDENTITY UNVERIFIED',
    icon: '✕',
  },
};

function fmtTime(iso) {
  if (!iso) return '--';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return '--';
  }
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function normalizeCard(cardState) {
  const c = String(cardState || 'yellow').toLowerCase();
  return c === 'green' || c === 'yellow' || c === 'red' ? c : 'yellow';
}

function eventPriority(ev) {
  const c = normalizeCard(ev.cardState);
  if (c === 'red') return 0;
  if (c === 'yellow') return 1;
  return 2;
}

function byUrgency(a, b) {
  const pa = eventPriority(a);
  const pb = eventPriority(b);
  if (pa !== pb) return pa - pb;
  return String(b.recordedAt || '').localeCompare(String(a.recordedAt || ''));
}

function Avatar({ src, name, size = 72, ring = '#334155' }) {
  const [imgErr, setImgErr] = useState(false);
  const initials = (name || '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        border: `3px solid ${ring}`,
        background: '#1E293B',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: `0 0 18px ${ring}44`,
        flexShrink: 0,
      }}
    >
      {src && !imgErr ? (
        <img
          src={src}
          alt={name || 'avatar'}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgErr(true)}
        />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.36), fontWeight: 800, color: '#94A3B8' }}>{initials}</span>
      )}
    </div>
  );
}

function StudentCard({ student, tone }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(255,255,255,0.04)',
        padding: '8px 10px',
      }}
    >
      <Avatar src={student.photoUrl} name={student.name} size={44} ring={tone.border} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {student.name || '--'}
        </div>
        <div style={{ fontSize: 11, color: BINUS_GOLD, fontWeight: 700, letterSpacing: 0.5 }}>
          {student.homeroom || student.class || '--'}
        </div>
      </div>
    </div>
  );
}

function QueueItem({ ev, active, onPick }) {
  const c = normalizeCard(ev.cardState);
  const tone = STATE_THEME[c];
  return (
    <button
      onClick={() => onPick(ev.id)}
      style={{
        width: '100%',
        textAlign: 'left',
        borderRadius: 12,
        border: `1px solid ${active ? tone.border : 'rgba(255,255,255,0.1)'}`,
        background: active ? `${tone.bg}` : 'rgba(255,255,255,0.03)',
        padding: '10px 12px',
        color: '#E2E8F0',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: tone.border, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {ev.chaperone?.name || '--'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>{timeAgo(ev.recordedAt)}</span>
      </div>
      <div style={{ marginTop: 5, fontSize: 11, color: '#94A3B8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {(ev.students || []).map((s) => s.name).filter(Boolean).join(', ') || ev.gate || '--'}
      </div>
    </button>
  );
}

function CaptureModal({ open, event, onClose, onConfirm, busy, error }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [captured, setCaptured] = useState(null);
  const [cameraErr, setCameraErr] = useState('');

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    setCameraErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (e) {
      setCameraErr(e.message || 'Camera unavailable');
    }
  }, []);

  useEffect(() => {
    if (!open) {
      stopCamera();
      setCaptured(null);
      setCameraErr('');
      return;
    }
    startCamera();
    return () => stopCamera();
  }, [open, startCamera, stopCamera]);

  const capture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    const data = canvas.toDataURL('image/jpeg', 0.85);
    setCaptured(data);
  };

  const retake = async () => {
    setCaptured(null);
    stopCamera();
    await startCamera();
  };

  if (!open || !event) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(2,6,23,0.88)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: 'min(840px, 100%)',
          borderRadius: 16,
          border: '1px solid rgba(239,68,68,0.45)',
          background: '#0f172a',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#FCA5A5', letterSpacing: 0.6 }}>RED CARD CAPTURE REQUIRED</div>
            <div style={{ fontSize: 12, color: '#94A3B8' }}>{event.chaperone?.name || '--'} · {fmtTime(event.recordedAt)}</div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#94A3B8', fontSize: 22, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 14 }}>
          {!captured ? (
            <>
              <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', background: '#020617' }}>
                <video ref={videoRef} playsInline muted style={{ width: '100%', maxHeight: 460, objectFit: 'cover' }} />
              </div>
              {cameraErr && <div style={{ marginTop: 10, fontSize: 12, color: '#FCA5A5' }}>{cameraErr}</div>}
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
                <button
                  onClick={capture}
                  disabled={!!cameraErr || busy}
                  style={{
                    width: 88,
                    height: 88,
                    borderRadius: '50%',
                    border: '4px solid #fff',
                    background: '#ef4444',
                    cursor: 'pointer',
                    boxShadow: '0 0 18px rgba(239,68,68,0.5)',
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)' }}>
                <img src={captured} alt="capture" style={{ width: '100%', maxHeight: 460, objectFit: 'cover' }} />
              </div>
              {(error || cameraErr) && <div style={{ marginTop: 10, fontSize: 12, color: '#FCA5A5' }}>{error || cameraErr}</div>}
              <div style={{ marginTop: 12, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={retake} disabled={busy}
                  style={{
                    border: '1px solid rgba(255,255,255,0.2)',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#E2E8F0',
                    borderRadius: 10,
                    padding: '11px 14px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Retake
                </button>
                <button onClick={() => onConfirm(captured)} disabled={busy}
                  style={{
                    border: '1px solid rgba(239,68,68,0.45)',
                    background: busy ? 'rgba(239,68,68,0.2)' : '#ef4444',
                    color: '#fff',
                    borderRadius: 10,
                    padding: '11px 14px',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  {busy ? 'Submitting...' : 'Confirm Release'}
                </button>
              </div>
            </>
          )}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      </div>
    </div>
  );
}

function HistoryDrawer({ open, items, onClose }) {
  return (
    <>
      {open && (
        <div
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.5)', zIndex: 61 }}
        />
      )}
      <div
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          width: 'min(360px, 92vw)',
          background: '#0f172a',
          borderRight: '1px solid rgba(255,255,255,0.1)',
          transform: open ? 'translateX(0)' : 'translateX(-105%)',
          transition: 'transform 0.2s ease-out',
          zIndex: 70,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: 14, borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center' }}>
          <div>
            <div style={{ color: '#fff', fontWeight: 800, fontSize: 15 }}>Recent Actions</div>
            <div style={{ color: '#94A3B8', fontSize: 11 }}>Latest {items.length} events</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#94A3B8', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: 10, overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && (
            <div style={{ color: '#64748B', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>No actions yet.</div>
          )}
          {items.map((it, idx) => {
            const tone = it.flagged ? '#ef4444' : it.action === 'hold' ? '#f59e0b' : '#22c55e';
            return (
              <div key={`${it.eventId}-${idx}`}
                style={{
                  borderRadius: 12,
                  border: `1px solid ${tone}55`,
                  background: `${tone}12`,
                  padding: 10,
                  marginBottom: 8,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: tone }} />
                  <span style={{ color: '#E2E8F0', fontWeight: 700, fontSize: 13 }}>{it.chaperone || '--'}</span>
                  <span style={{ marginLeft: 'auto', color: '#94A3B8', fontSize: 11 }}>{fmtTime(it.at)}</span>
                </div>
                <div style={{ color: '#94A3B8', fontSize: 11, marginTop: 4 }}>{it.students || '--'}</div>
                <div style={{ color: tone, fontSize: 11, marginTop: 4, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {it.flagged ? 'Released (Flagged)' : it.action}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

export default function TeacherPickup() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [feed, setFeed] = useState({ events: [], classScopes: [], displayName: '', role: '' });
  const [online, setOnline] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [err, setErr] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [busyAction, setBusyAction] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureErr, setCaptureErr] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recentActions, setRecentActions] = useState([]);
  const [autoReleaseCountdown, setAutoReleaseCountdown] = useState(AUTO_RELEASE_MS / 1000);

  const pollRef = useRef(null);
  const autoTimerRef = useRef(null);
  const autoTickRef = useRef(null);
  const autoReleasedRef = useRef(new Set());
  const touchStartXRef = useRef(null);

  useEffect(() => { setMounted(true); }, []);

  const fetchFeed = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/teacher/feed', { credentials: 'include', cache: 'no-store' });
      if (r.status === 401) { router.replace('/login'); return; }
      if (r.status === 403) {
        setErr('Access denied. Check teacher permissions/class scopes.');
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Feed error');
      setFeed(j);
      setOnline(true);
      setLastUpdated(new Date());
      setErr(null);
    } catch (e) {
      setOnline(false);
      setErr(e.message || 'Network error');
    }
  }, [router]);

  useEffect(() => {
    if (!mounted) return;
    fetchFeed();
    pollRef.current = setInterval(fetchFeed, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [mounted, fetchFeed]);

  const pendingEvents = useMemo(() => {
    return (feed.events || [])
      .filter((ev) => {
        if (ev.teacherRelease || ev.officerOverride) return false;
        const c = normalizeCard(ev.cardState);
        return c === 'green' || c === 'yellow' || c === 'red';
      })
      .sort(byUrgency);
  }, [feed.events]);

  const releasedTodayCount = useMemo(() => {
    return (feed.events || []).filter((ev) => {
      const c = normalizeCard(ev.cardState);
      if (c === 'green') return true;
      return ev.teacherRelease?.action === 'release' || !!ev.officerOverride;
    }).length;
  }, [feed.events]);

  const activeEvent = useMemo(() => {
    if (!pendingEvents.length) return null;
    const selected = pendingEvents.find((ev) => ev.id === activeId);
    return selected || pendingEvents[0];
  }, [pendingEvents, activeId]);

  useEffect(() => {
    if (activeEvent && activeEvent.id !== activeId) {
      setActiveId(activeEvent.id);
    }
  }, [activeEvent, activeId]);

  const pushHistory = useCallback((ev, action, flagged) => {
    const students = (ev.students || []).map((s) => s.name).filter(Boolean).join(', ');
    setRecentActions((prev) => [
      {
        eventId: ev.id,
        chaperone: ev.chaperone?.name || '--',
        students,
        at: new Date().toISOString(),
        action,
        flagged: !!flagged,
      },
      ...prev,
    ].slice(0, 20));
  }, []);

  const releaseAction = useCallback(async (ev, action, captureStoragePath = null) => {
    if (!ev || busyAction) return false;
    setBusyAction(true);
    setCaptureErr('');
    try {
      const r = await fetch('/api/pickup/teacher/release', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: ev.id,
          action,
          captureStoragePath,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      pushHistory(ev, action, !!j.flagged);
      await fetchFeed();
      return true;
    } catch (e) {
      setCaptureErr(e.message || 'Failed action');
      return false;
    } finally {
      setBusyAction(false);
    }
  }, [busyAction, fetchFeed, pushHistory]);

  const onHold = useCallback(async () => {
    if (!activeEvent) return;
    await releaseAction(activeEvent, 'hold');
  }, [activeEvent, releaseAction]);

  const onReleaseYellow = useCallback(async () => {
    if (!activeEvent) return;
    await releaseAction(activeEvent, 'release');
  }, [activeEvent, releaseAction]);

  const onConfirmCapture = useCallback(async (imageData) => {
    if (!activeEvent) return;
    setBusyAction(true);
    setCaptureErr('');
    try {
      const up = await fetch('/api/pickup/teacher/upload-capture', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: activeEvent.id, imageData }),
      });
      const uj = await up.json();
      if (!up.ok) throw new Error(uj.error || 'Capture upload failed');

      const ok = await releaseAction(activeEvent, 'release', uj.storagePath);
      if (ok) {
        setCaptureOpen(false);
      }
    } catch (e) {
      setCaptureErr(e.message || 'Capture flow failed');
      setBusyAction(false);
    }
  }, [activeEvent, releaseAction]);

  useEffect(() => {
    if (!activeEvent) return;
    const c = normalizeCard(activeEvent.cardState);
    if (c !== 'green') {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
      if (autoTickRef.current) clearInterval(autoTickRef.current);
      setAutoReleaseCountdown(AUTO_RELEASE_MS / 1000);
      return;
    }
    if (busyAction) return;
    if (autoReleasedRef.current.has(activeEvent.id)) return;

    setAutoReleaseCountdown(AUTO_RELEASE_MS / 1000);
    autoTickRef.current = setInterval(() => {
      setAutoReleaseCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);

    autoTimerRef.current = setTimeout(async () => {
      autoReleasedRef.current.add(activeEvent.id);
      await releaseAction(activeEvent, 'release');
    }, AUTO_RELEASE_MS);

    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
      if (autoTickRef.current) clearInterval(autoTickRef.current);
    };
  }, [activeEvent, busyAction, releaseAction]);

  useEffect(() => {
    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
      if (autoTickRef.current) clearInterval(autoTickRef.current);
    };
  }, []);

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/session', { method: 'DELETE', credentials: 'include' });
      await fbSignOut();
    } catch {}
    router.replace('/login');
  };

  const onTouchStart = (e) => {
    touchStartXRef.current = e.touches?.[0]?.clientX ?? null;
  };

  const onTouchEnd = (e) => {
    const startX = touchStartXRef.current;
    const endX = e.changedTouches?.[0]?.clientX;
    if (startX == null || endX == null) return;
    const delta = endX - startX;
    if (!historyOpen && startX < 28 && delta > 70) {
      setHistoryOpen(true);
    } else if (historyOpen && delta < -70) {
      setHistoryOpen(false);
    }
  };

  if (!mounted) return null;

  const activeCardState = activeEvent ? normalizeCard(activeEvent.cardState) : 'yellow';
  const tone = STATE_THEME[activeCardState] || STATE_THEME.yellow;

  return (
    <>
      <Head>
        <title>Teacher Device · Pickup Release</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <meta name="theme-color" content={BINUS_MAROON} />
      </Head>

      <div
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          minHeight: '100dvh',
          background: 'linear-gradient(165deg, #070B14 0%, #0B1120 55%, #0A0F1C 100%)',
          color: '#fff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <HistoryDrawer open={historyOpen} items={recentActions} onClose={() => setHistoryOpen(false)} />

        <CaptureModal
          open={captureOpen}
          event={activeEvent}
          onClose={() => setCaptureOpen(false)}
          onConfirm={onConfirmCapture}
          busy={busyAction}
          error={captureErr}
        />

        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 50,
            background: 'rgba(10,10,20,0.92)',
            backdropFilter: 'blur(16px)',
            borderBottom: `2px solid ${BINUS_MAROON}`,
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <button
            onClick={() => setHistoryOpen(true)}
            style={{
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.06)',
              color: '#E2E8F0',
              borderRadius: 10,
              padding: '6px 10px',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            History
          </button>

          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {feed.displayName || 'Teacher'} · Release Desk
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
              {(feed.classScopes || []).map((c) => (
                <span key={c} style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.8,
                  borderRadius: 99,
                  border: `1px solid ${BINUS_GOLD}55`,
                  background: `${BINUS_GOLD}22`,
                  color: BINUS_GOLD,
                  padding: '2px 7px',
                }}>{c}</span>
              ))}
            </div>
          </div>

          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: online ? '#22C55E' : '#EF4444', boxShadow: online ? '0 0 8px #22C55E' : '0 0 8px #EF4444' }} />
              <span style={{ fontSize: 11, color: '#94A3B8' }}>{pendingEvents.length} pending</span>
            </div>
            <div style={{ fontSize: 11, color: '#FDE68A', marginTop: 3, fontWeight: 700 }}>{releasedTodayCount} released today</div>
          </div>

          <button
            onClick={handleSignOut}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#94A3B8',
              fontSize: 22,
              cursor: 'pointer',
              lineHeight: 1,
            }}
            title="Sign out"
          >
            ⏻
          </button>
        </div>

        {err && (
          <div style={{ margin: '12px 14px 0', padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.12)', color: '#FCA5A5', fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ padding: 14, display: 'grid', gap: 12 }}>
          {!activeEvent ? (
            <div style={{ border: '1px solid rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.1)', borderRadius: 16, padding: 22, textAlign: 'center' }}>
              <div style={{ fontSize: 44, marginBottom: 8 }}>✓</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#DCFCE7' }}>All clear</div>
              <div style={{ marginTop: 6, fontSize: 13, color: '#86EFAC' }}>No pending pickup events in your classes.</div>
            </div>
          ) : (
            <div
              style={{
                borderRadius: 16,
                border: `2px solid ${tone.border}`,
                background: tone.bg,
                boxShadow: `0 0 22px ${tone.border}22`,
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '11px 12px',
                background: `${tone.border}22`,
                borderBottom: `1px solid ${tone.border}66`,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}>
                <div style={{ width: 26, height: 26, borderRadius: 99, border: `2px solid ${tone.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, color: tone.border }}>
                  {tone.icon}
                </div>
                <div style={{ fontSize: 12, fontWeight: 800, color: tone.border, letterSpacing: 0.8, textTransform: 'uppercase' }}>{tone.label}</div>
                <div style={{ marginLeft: 'auto', fontSize: 11, color: '#CBD5E1' }}>
                  {fmtTime(activeEvent.recordedAt)} · {timeAgo(activeEvent.recordedAt)} · {activeEvent.gate || '--'}
                </div>
              </div>

              <div style={{ padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar src={activeEvent.chaperone?.photoUrl} name={activeEvent.chaperone?.name} size={72} ring={tone.border} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>Chaperone</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {activeEvent.chaperone?.name || '--'}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                  {(activeEvent.students || []).map((s, idx) => (
                    <StudentCard key={idx} student={s} tone={tone} />
                  ))}
                </div>

                {activeCardState === 'green' && (
                  <div style={{ marginTop: 12, borderRadius: 12, border: '1px solid rgba(34,197,94,0.45)', background: 'rgba(34,197,94,0.14)', padding: '10px 12px', color: '#BBF7D0', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>Auto-releasing in {autoReleaseCountdown}s...</span>
                    <button onClick={onHold} disabled={busyAction}
                      style={{ border: '1px solid rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.18)', color: '#FDE68A', borderRadius: 10, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Hold
                    </button>
                  </div>
                )}

                {activeCardState === 'yellow' && (
                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <button onClick={onReleaseYellow} disabled={busyAction}
                      style={{ height: 62, borderRadius: 12, border: '1px solid rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.2)', color: '#DCFCE7', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
                      {busyAction ? 'Working...' : 'Release'}
                    </button>
                    <button onClick={onHold} disabled={busyAction}
                      style={{ height: 62, borderRadius: 12, border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.2)', color: '#FDE68A', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
                      Hold
                    </button>
                  </div>
                )}

                {activeCardState === 'red' && (
                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <button onClick={() => { setCaptureErr(''); setCaptureOpen(true); }} disabled={busyAction}
                      style={{ height: 62, borderRadius: 12, border: '1px solid rgba(239,68,68,0.55)', background: 'rgba(239,68,68,0.24)', color: '#FECACA', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                      Capture & Release
                    </button>
                    <button onClick={onHold} disabled={busyAction}
                      style={{ height: 62, borderRadius: 12, border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.2)', color: '#FDE68A', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
                      Hold
                    </button>
                  </div>
                )}

                {captureErr && (
                  <div style={{ marginTop: 10, fontSize: 12, color: '#FCA5A5' }}>{captureErr}</div>
                )}
              </div>
            </div>
          )}

          {pendingEvents.length > 1 && (
            <div style={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)', padding: 10 }}>
              <div style={{ color: '#94A3B8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                Queue
              </div>
              <div style={{ display: 'grid', gap: 7 }}>
                {pendingEvents
                  .filter((ev) => ev.id !== activeEvent?.id)
                  .slice(0, 8)
                  .map((ev) => (
                    <QueueItem key={ev.id} ev={ev} active={ev.id === activeEvent?.id} onPick={setActiveId} />
                  ))}
              </div>
            </div>
          )}

          {lastUpdated && (
            <div style={{ textAlign: 'center', color: '#475569', fontSize: 11, paddingBottom: 12 }}>
              Last updated {fmtTime(lastUpdated.toISOString())}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
