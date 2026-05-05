import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { signOut as fbSignOut } from '../../lib/firebase-client';

const POLL_MS = 2000;
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

function StudentTile({ s }) {
  const [imgErr, setImgErr] = useState(false);
  const initials = (s.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: '#fff7ea', border: '1.5px solid #FFD86A',
      borderRadius: 14, padding: '7px 14px 7px 12px',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, background: '#22C55E' }} />
      <div style={{
        width: 50, height: 50, borderRadius: '50%', flexShrink: 0,
        background: '#fde68a', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '2.5px solid white', boxShadow: '0 2px 6px rgba(139,21,56,0.18)',
        color: '#8B1538', fontWeight: 800, fontSize: 16, marginLeft: 4,
      }}>
        {s.photoUrl && !imgErr
          ? <img src={s.photoUrl} alt={s.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgErr(true)} />
          : initials}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1a0710', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{s.name || '--'}</div>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>{s.homeroom || '--'}</div>
      </div>
    </div>
  );
}

function QueueRailCard({ ev, onPick }) {
  const c = normalizeCard(ev.cardState);
  const tone = STATE_THEME[c];
  const bandBg = c === 'green'
    ? 'linear-gradient(90deg, #15803d, #22c55e)'
    : c === 'red'
      ? 'linear-gradient(90deg, #991b1b, #ef4444)'
      : 'linear-gradient(90deg, #b45309, #fbbf24)';
  const bandColor = c === 'yellow' ? '#2a1500' : 'white';
  return (
    <button
      onClick={() => onPick(ev.id)}
      style={{
        width: 220,
        minWidth: 220,
        textAlign: 'left',
        borderRadius: 14,
        border: '2px solid #f1e7d7',
        background: '#fffaf2',
        padding: 0,
        cursor: 'pointer',
        overflow: 'hidden',
        boxShadow: '0 3px 12px rgba(0,0,0,0.12)',
        flexShrink: 0,
      }}
    >
      <div style={{ padding: '7px 12px', background: bandBg, color: bandColor, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>{tone.icon}</span>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ev.chaperone?.name || '--'}
        </span>
        <span style={{ fontSize: 10, opacity: 0.9, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{timeAgo(ev.recordedAt)}</span>
      </div>
      <div style={{ padding: '8px 12px', fontSize: 11, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
  const [captureErr, setCaptureErr] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recentActions, setRecentActions] = useState([]);

  const pollRef = useRef(null);
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
        if (ev.officerOverride) return false;
        if (ev.teacherRelease?.action === 'hold') return false; // goes to hold tray
        if (ev.teacherRelease) return false;
        const c = normalizeCard(ev.cardState);
        return c === 'green' || c === 'yellow' || c === 'red';
      })
      .sort(byUrgency);
  }, [feed.events]);

  const heldEvents = useMemo(() => {
    return (feed.events || [])
      .filter((ev) => ev.teacherRelease?.action === 'hold' && !ev.officerOverride)
      .sort((a, b) => new Date(b.recordedAt || 0) - new Date(a.recordedAt || 0));
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

  const spotlightCards = useMemo(() => {
    if (!pendingEvents.length) return [];
    const list = [...pendingEvents];
    if (activeEvent) {
      const idx = list.findIndex((ev) => ev.id === activeEvent.id);
      if (idx > 0) {
        const [picked] = list.splice(idx, 1);
        list.unshift(picked);
      }
    }
    return list.slice(0, 4);
  }, [pendingEvents, activeEvent]);

  const queueEvents = useMemo(() => {
    const spotlightIds = new Set(spotlightCards.map((ev) => ev.id));
    return pendingEvents.filter((ev) => !spotlightIds.has(ev.id)).slice(0, 12);
  }, [pendingEvents, spotlightCards]);

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
          open={false}
          event={activeEvent}
          onClose={() => {}}
          onConfirm={() => {}}
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
            <>
              <div
                style={{
                  borderRadius: 14,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'linear-gradient(170deg, rgba(15,23,42,0.9), rgba(2,6,23,0.82))',
                  padding: '10px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>Live Decision Desk</div>
                <div style={{ fontSize: 12, color: '#E2E8F0', fontWeight: 700 }}>{pendingEvents.length} pending</div>
                <div style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>Tap any card to focus and act</div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'stretch' }}>
                {spotlightCards.map((ev) => {
                  const cardState = normalizeCard(ev.cardState);
                  const cardTone = STATE_THEME[cardState] || STATE_THEME.yellow;
                  const isActive = ev.id === activeEvent?.id;
                  const students = ev.students || [];
                  const bandBg = cardState === 'green'
                    ? 'linear-gradient(90deg, #15803d, #22c55e)'
                    : cardState === 'red'
                      ? 'linear-gradient(90deg, #991b1b, #ef4444)'
                      : 'linear-gradient(90deg, #b45309, #fbbf24)';
                  const bandColor = cardState === 'yellow' ? '#2a1500' : 'white';

                  return (
                    <button
                      key={ev.id}
                      onClick={() => setActiveId(ev.id)}
                      style={{
                        textAlign: 'left',
                        borderRadius: 18,
                        border: `2.5px solid ${isActive ? cardTone.border : '#f1e7d7'}`,
                        background: '#fffaf2',
                        boxShadow: isActive
                          ? `0 8px 32px ${cardTone.border}55, 0 2px 0 ${cardTone.border}66`
                          : '0 4px 18px rgba(0,0,0,0.14)',
                        overflow: 'hidden',
                        padding: 0,
                        cursor: 'pointer',
                        transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
                      }}
                    >
                      {/* Colored band header — matches TV .pc-band */}
                      <div style={{
                        padding: '11px 16px',
                        background: bandBg,
                        color: bandColor,
                        display: 'flex', alignItems: 'center', gap: 10,
                        fontWeight: 800, letterSpacing: 1.2, fontSize: 13,
                      }}>
                        <span style={{ fontSize: 18 }}>{cardTone.icon}</span>
                        <span style={{ textTransform: 'uppercase', letterSpacing: 1.5 }}>{cardTone.label}</span>
                        <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 11, opacity: 0.9, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(ev.recordedAt)}</span>
                        {isActive && (
                          <span style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 99, padding: '2px 9px', fontSize: 10, fontWeight: 700, letterSpacing: 0.6 }}>FOCUSED</span>
                        )}
                      </div>

                      {/* Card body */}
                      <div style={{ padding: '14px 16px 12px' }}>
                        {/* Chaperone row — large photo like TV */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                          <div style={{
                            width: 96, height: 96, flexShrink: 0, borderRadius: 14,
                            overflow: 'hidden', border: `4px solid ${BINUS_GOLD}`,
                            background: '#f3e9d6', boxShadow: '0 4px 16px rgba(139,21,56,0.22)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {ev.chaperone?.photoUrl
                              ? <img src={ev.chaperone.photoUrl} alt={ev.chaperone?.name || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : <span style={{ fontSize: 44, color: 'rgba(139,21,56,0.3)', lineHeight: 1 }}>👤</span>}
                          </div>
                          <div style={{ minWidth: 0, flex: 1, paddingTop: 2 }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color: '#8B1538', lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ev.chaperone?.name || 'Unknown'}
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <span style={{
                                display: 'inline-block',
                                background: BINUS_GOLD, color: '#5D0E27',
                                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5,
                                padding: '3px 11px', borderRadius: 999,
                              }}>
                                {ev.chaperone?.relationship || ev.chaperone?.relation || 'Pickup'}
                              </span>
                            </div>
                            <div style={{ marginTop: 7, fontSize: 12, color: '#64748b', fontWeight: 600 }}>
                              {ev.gate || 'Main Gate'} · {fmtTime(ev.recordedAt)}
                            </div>
                          </div>
                        </div>

                        {/* Student tiles — matches TV .pc-student grid */}
                        {students.length > 0 && (
                          <div style={{ marginTop: 14 }}>
                            <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 }}>
                              Children ({students.length})
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
                              {students.slice(0, 4).map((s, idx) => (
                                <StudentTile key={`${ev.id}-${idx}`} s={s} />
                              ))}
                              {students.length > 4 && (
                                <div style={{
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  background: '#fef3c7', border: '1.5px solid #FFD86A', borderRadius: 14,
                                  padding: '10px 14px', color: '#5D0E27', fontWeight: 800, fontSize: 14,
                                }}>
                                  +{students.length - 4} more
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {students.length === 0 && (
                          <div style={{ marginTop: 14, padding: '12px 0', color: '#94a3b8', fontSize: 13, fontStyle: 'italic', textAlign: 'center' }}>
                            No authorised students
                          </div>
                        )}

                        {/* Action buttons */}
                        {cardState === 'green' && (
                          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            <button onClick={(e) => { e.stopPropagation(); setActiveId(ev.id); releaseAction(ev, 'release'); }} disabled={busyAction}
                              style={{ height: 48, borderRadius: 12, border: 'none', background: 'linear-gradient(90deg, #15803d, #22c55e)', color: 'white', fontWeight: 800, fontSize: 14, cursor: 'pointer', boxShadow: '0 3px 10px rgba(21,128,61,0.35)' }}>
                              ✓ Release
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setActiveId(ev.id); releaseAction(ev, 'hold'); }} disabled={busyAction}
                              style={{ height: 48, borderRadius: 12, border: '2px solid #FCBF11', background: '#fffdf0', color: '#5D0E27', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                              ⏸ Hold
                            </button>
                          </div>
                        )}

                        {cardState === 'yellow' && (
                          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            <button onClick={(e) => { e.stopPropagation(); setActiveId(ev.id); releaseAction(ev, 'release'); }} disabled={busyAction}
                              style={{ height: 48, borderRadius: 12, border: 'none', background: 'linear-gradient(90deg, #15803d, #22c55e)', color: 'white', fontWeight: 800, fontSize: 14, cursor: 'pointer', boxShadow: '0 3px 10px rgba(21,128,61,0.35)' }}>
                              ✓ Release
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setActiveId(ev.id); releaseAction(ev, 'hold'); }} disabled={busyAction}
                              style={{ height: 48, borderRadius: 12, border: '2px solid #FCBF11', background: '#fffdf0', color: '#5D0E27', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                              ⏸ Hold
                            </button>
                          </div>
                        )}

                        {cardState === 'red' && (
                          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            <button onClick={(e) => { e.stopPropagation(); setActiveId(ev.id); releaseAction(ev, 'escalate'); }} disabled={busyAction}
                              style={{ height: 48, borderRadius: 12, border: 'none', background: 'linear-gradient(90deg, #991b1b, #ef4444)', color: 'white', fontWeight: 800, fontSize: 12, cursor: 'pointer', boxShadow: '0 3px 10px rgba(153,27,27,0.45)' }}>
                              🚨 Escalate to Security
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setActiveId(ev.id); releaseAction(ev, 'hold'); }} disabled={busyAction}
                              style={{ height: 48, borderRadius: 12, border: '2px solid #FCBF11', background: '#fffdf0', color: '#5D0E27', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
                              ⏸ Hold
                            </button>
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {queueEvents.length > 0 && (
                <div style={{ borderRadius: 14, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)', padding: 10 }}>
                  <div style={{ color: '#94A3B8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                    Queue Lane
                  </div>
                  <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                    {queueEvents.map((ev) => (
                      <QueueRailCard key={ev.id} ev={ev} onPick={setActiveId} />
                    ))}
                  </div>
                </div>
              )}

              {/* ── Hold Tray ─────────────────────────────────────────── */}
              {heldEvents.length > 0 && (
                <div style={{
                  borderRadius: 16,
                  border: '2.5px solid #FCBF11',
                  background: '#fffdf0',
                  padding: '12px 14px',
                  boxShadow: '0 4px 18px rgba(252,191,17,0.18)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 16 }}>⏸</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#92400e', textTransform: 'uppercase', letterSpacing: 1.5 }}>On Hold ({heldEvents.length})</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: '#a16207' }}>Tap a card to review &amp; release</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                    {heldEvents.map((ev) => {
                      const cardState = normalizeCard(ev.cardState);
                      const bandBg = cardState === 'green'
                        ? 'linear-gradient(90deg, #15803d, #22c55e)'
                        : cardState === 'red'
                          ? 'linear-gradient(90deg, #991b1b, #ef4444)'
                          : 'linear-gradient(90deg, #b45309, #fbbf24)';
                      const bandColor = cardState === 'yellow' ? '#2a1500' : 'white';
                      const students = ev.students || [];
                      const isActive = ev.id === activeEvent?.id;
                      return (
                        <div key={ev.id} style={{
                          borderRadius: 14,
                          border: `2px solid ${isActive ? '#FCBF11' : 'rgba(252,191,17,0.4)'}`,
                          background: isActive ? '#fffbe6' : 'white',
                          overflow: 'hidden',
                          boxShadow: isActive ? '0 4px 16px rgba(252,191,17,0.4)' : '0 2px 8px rgba(0,0,0,0.08)',
                          transition: 'box-shadow 0.15s',
                        }}>
                          {/* Mini band */}
                          <div style={{ padding: '7px 12px', background: bandBg, color: bandColor, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 13 }}>{STATE_THEME[cardState]?.icon}</span>
                            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ev.chaperone?.name || '--'}
                            </span>
                            <span style={{ fontSize: 10, opacity: 0.85, flexShrink: 0 }}>{fmtTime(ev.recordedAt)}</span>
                          </div>
                          {/* Body */}
                          <div style={{ padding: '10px 12px' }}>
                            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                              {students.map((s) => s.name).filter(Boolean).join(', ') || 'No students'}
                            </div>
                            {/* Student photo row */}
                            {students.length > 0 && (
                              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                                {students.slice(0, 3).map((s, i) => {
                                  const initials = (s.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
                                  return (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#fff7ea', border: '1.5px solid #FFD86A', borderRadius: 20, padding: '3px 8px 3px 3px' }}>
                                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#fde68a', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#8B1538', fontWeight: 800, fontSize: 11 }}>
                                        {s.photoUrl
                                          ? <img src={s.photoUrl} alt={s.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                          : initials}
                                      </div>
                                      <span style={{ fontSize: 11, fontWeight: 600, color: '#1a0710' }}>{s.name?.split(' ')[0]}</span>
                                    </div>
                                  );
                                })}
                                {students.length > 3 && <span style={{ fontSize: 11, color: '#64748b', alignSelf: 'center' }}>+{students.length - 3}</span>}
                              </div>
                            )}
                            <button
                              onClick={() => { setActiveId(ev.id); releaseAction(ev, 'release'); }}
                              disabled={busyAction}
                              style={{
                                width: '100%', height: 40, borderRadius: 10,
                                border: 'none',
                                background: 'linear-gradient(90deg, #15803d, #22c55e)',
                                color: 'white', fontWeight: 800, fontSize: 13,
                                cursor: 'pointer', boxShadow: '0 3px 8px rgba(21,128,61,0.3)',
                              }}
                            >
                              ✓ Release
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {captureErr && (
                <div style={{ marginTop: 2, fontSize: 12, color: '#FCA5A5' }}>{captureErr}</div>
              )}
            </>
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
