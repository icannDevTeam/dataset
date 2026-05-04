/**
 * /pickup/gate  — Gate-side verification display
 *
 * Placed on the screen RIGHT AT THE GATE. The Hikvision terminal
 * authenticates the parent/nanny and fires an event. This screen
 * shows the result so the security officer standing beside it can
 * visually confirm the right person is picking up the right child.
 *
 * NO interaction needed — purely a display. Hikvision controls the
 * door relay. Security is eyes-only.
 *
 * URL params:
 *   ?token=<PICKUP_TV_TOKEN>   legacy token (optional if paired)
 *   ?gate=<gate name>          optional, filter to one gate
 *   ?tenant=<tenant id>        optional override
 *
 * Auth: same device-token pairing as /pickup/tv
 *
 * Lifecycle:
 *   IDLE  → waiting for the next scan (shown when no events OR last
 *            event is older than ACTIVE_WINDOW_MS)
 *   ACTIVE → Hikvision fires an event; within ACTIVE_WINDOW_MS this
 *             screen shows chaperone + child info prominently
 *   FADING → last 8 seconds of ACTIVE_WINDOW, opacity transitions to IDLE
 */

import Head from 'next/head';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/router';

const POLL_MS         = 4_000;
const ACTIVE_WINDOW_MS = 45_000;   // show event for 45 seconds
const FADE_START_MS   = 37_000;    // start fading 8s before expiry

// ─── Helpers ─────────────────────────────────────────────────────────────────
function elapsed(iso) {
  if (!iso) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 5)  return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ─── Decision colours ────────────────────────────────────────────────────────
const DECISION = {
  ok:                   { label: 'AUTHORISED',       color: '#22C55E', bg: '#052E16', border: '#16A34A', icon: '✓' },
  approved:             { label: 'AUTHORISED',       color: '#22C55E', bg: '#052E16', border: '#16A34A', icon: '✓' },
  suspended:            { label: 'SUSPENDED',        color: '#EF4444', bg: '#1F0707', border: '#DC2626', icon: '✕' },
  unknown_chaperone:    { label: 'UNKNOWN PERSON',   color: '#EF4444', bg: '#1F0707', border: '#DC2626', icon: '✕' },
  reenroll_overdue:     { label: 'RE-ENROLL NEEDED', color: '#F59E0B', bg: '#1C0F00', border: '#D97706', icon: '⚠' },
  flagged:              { label: 'NEEDS OFFICER',    color: '#F59E0B', bg: '#1C0F00', border: '#D97706', icon: '⚠' },
  officer_override:     { label: 'OFFICER APPROVED', color: '#22C55E', bg: '#052E16', border: '#16A34A', icon: '✓' },
};
const DEFAULT_DECISION = { label: 'VERIFIED',  color: '#22C55E', bg: '#052E16', border: '#16A34A', icon: '✓' };

function decisionTheme(d) {
  return DECISION[d] || DEFAULT_DECISION;
}

// ─── Avatar ──────────────────────────────────────────────────────────────────
function Avatar({ src, name, size = 200, ring }) {
  const [err, setErr] = useState(false);
  const initials = (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
      border: `4px solid ${ring || '#334155'}`,
      background: '#1E293B',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: ring ? `0 0 32px ${ring}55` : 'none',
    }}>
      {src && !err
        ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setErr(true)} />
        : <span style={{ fontSize: size * 0.36, fontWeight: 800, color: '#94A3B8', letterSpacing: '-1px' }}>{initials}</span>
      }
    </div>
  );
}

// ─── Idle Screen ─────────────────────────────────────────────────────────────
function IdleScreen({ gateName, gateStatus, tick }) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const gateOpen = gateStatus?.open !== false;
  const isManual = !!gateStatus?.manualOverride;

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: 'linear-gradient(145deg, #0A0A14 0%, #0D1117 60%, #0A0F1A 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      color: 'white', fontFamily: 'system-ui, -apple-system, sans-serif',
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Subtle grid */}
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.03,
        backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />

      {/* Logo area */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 48 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 18, overflow: 'hidden',
          background: '#8B1538', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: 36 }}>🏫</span>
        </div>
        <div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.5px', color: '#FCBF11' }}>BINUS School</div>
          <div style={{ fontSize: 15, color: '#64748B', fontWeight: 500 }}>Pickup Gate Verification</div>
        </div>
      </div>

      {/* Pulsing ready indicator */}
      <div style={{
        width: 180, height: 180, borderRadius: '50%',
        border: `6px solid ${gateOpen ? '#16A34A' : '#DC2626'}`,
        background: gateOpen ? 'rgba(22,163,74,0.07)' : 'rgba(220,38,38,0.07)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 40,
        animation: 'pulse 3s ease-in-out infinite',
        boxShadow: gateOpen ? '0 0 64px rgba(22,163,74,0.2)' : '0 0 64px rgba(220,38,38,0.2)',
      }}>
        <span style={{ fontSize: 70 }}>{gateOpen ? '🚪' : '🔒'}</span>
      </div>

      {/* Status */}
      <div style={{ fontSize: 22, color: '#94A3B8', fontWeight: 600, letterSpacing: 4, textTransform: 'uppercase', marginBottom: 10 }}>
        {gateOpen ? 'Ready for scan' : 'Gate closed'}
      </div>
      {isManual && (
        <div style={{ fontSize: 13, color: '#F59E0B', fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 10 }}>
          Manual override active
        </div>
      )}
      {gateStatus?.configured && gateStatus?.opensAt && gateOpen && (
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 4 }}>
          Open window: {gateStatus.opensAt} – {gateStatus.closesAt}
        </div>
      )}

      {/* Clock */}
      <div style={{ position: 'absolute', bottom: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 56, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: -2, color: '#E2E8F0' }}>
          {timeStr}
        </div>
        <div style={{ fontSize: 16, color: '#475569', fontWeight: 500, marginTop: 4 }}>{dateStr}</div>
        {gateName && (
          <div style={{ marginTop: 8, fontSize: 13, color: '#334155', fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase' }}>
            {gateName}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.06); opacity: 0.85; }
        }
      `}</style>
    </div>
  );
}

// ─── Active Verification Screen ───────────────────────────────────────────────
function ActiveScreen({ event, fadeRatio, gateName }) {
  const theme = decisionTheme(event.decision);
  const chap  = event.chaperone || {};
  const students = event.students || [];
  const isApproved = ['ok', 'approved', 'officer_override'].includes(event.decision);

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: `linear-gradient(145deg, #080B10 0%, ${theme.bg} 100%)`,
      display: 'flex', flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: 'white', overflow: 'hidden',
      opacity: 1 - fadeRatio * 0.6,
      transition: 'opacity 1s',
      position: 'relative',
    }}>
      {/* Top status bar */}
      <div style={{
        background: theme.bg,
        borderBottom: `3px solid ${theme.border}`,
        padding: '20px 48px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          {/* Giant icon */}
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: theme.color + '22',
            border: `3px solid ${theme.color}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 32, fontWeight: 900, color: theme.color,
            flexShrink: 0,
            boxShadow: `0 0 32px ${theme.color}44`,
            animation: isApproved ? 'glow 2s ease-in-out infinite' : 'none',
          }}>
            {theme.icon}
          </div>
          <div>
            <div style={{ fontSize: 42, fontWeight: 900, letterSpacing: 4, color: theme.color, lineHeight: 1 }}>
              {theme.label}
            </div>
            <div style={{ fontSize: 16, color: '#64748B', marginTop: 4, fontWeight: 500 }}>
              Scanned {elapsed(event.scannedAt || event.recordedAt)} · {fmtTime(event.scannedAt || event.recordedAt)}
              {event.deviceName && <> · {event.deviceName}</>}
              {gateName && <> · Gate: {gateName}</>}
            </div>
          </div>
        </div>

        {/* BINUS logo */}
        <div style={{ textAlign: 'right', opacity: 0.6 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#FCBF11' }}>BINUS School</div>
          <div style={{ fontSize: 12, color: '#475569' }}>Pickup Gate</div>
        </div>
      </div>

      {/* Main content: chaperone + students */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'stretch',
        padding: '32px 48px', gap: 48, minHeight: 0,
      }}>

        {/* ── Left: Chaperone ── */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: 'rgba(255,255,255,0.03)', borderRadius: 24,
          border: `1px solid ${theme.border}44`,
          padding: '32px 24px', gap: 20,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 3, color: '#475569', textTransform: 'uppercase' }}>
            Chaperone Presenting
          </div>
          <Avatar src={chap.photoUrl} name={chap.name} size={220} ring={theme.color} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.1, color: '#F1F5F9' }}>
              {chap.name || 'Unknown'}
            </div>
            {chap.relationship && (
              <div style={{ fontSize: 18, color: '#94A3B8', fontWeight: 500, marginTop: 6 }}>
                {chap.relationship}
              </div>
            )}
            {chap.phone && (
              <div style={{ fontSize: 15, color: '#475569', fontWeight: 500, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                {chap.phone}
              </div>
            )}
          </div>

          {/* Scan capture if available */}
          {event.capturePath && (
            <div style={{ marginTop: 'auto', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#334155', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
                Face Capture
              </div>
              <img src={event.capturePath} alt="face capture"
                style={{ width: 110, height: 110, objectFit: 'cover', borderRadius: 12,
                  border: `2px solid ${theme.border}66` }} />
            </div>
          )}
        </div>

        {/* ── Divider ── */}
        <div style={{
          width: 3, borderRadius: 2,
          background: `linear-gradient(to bottom, transparent, ${theme.border}88, transparent)`,
          flexShrink: 0, alignSelf: 'stretch',
        }} />

        {/* ── Right: Students ── */}
        <div style={{
          flex: 1.4, display: 'flex', flexDirection: 'column',
          background: 'rgba(255,255,255,0.03)', borderRadius: 24,
          border: `1px solid rgba(255,255,255,0.05)`,
          padding: '32px 24px', gap: 20,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 3, color: '#475569', textTransform: 'uppercase' }}>
            {students.length === 1 ? 'Child for Pickup' : `Children for Pickup (${students.length})`}
          </div>

          {students.length === 0 && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#334155', fontSize: 18 }}>
              No student data
            </div>
          )}

          <div style={{
            display: 'flex', flexDirection: students.length > 2 ? 'row' : 'column',
            flexWrap: 'wrap', gap: 20, flex: 1, alignContent: 'flex-start',
          }}>
            {students.map((s, i) => (
              <StudentCard key={i} student={s} large={students.length === 1} theme={theme} />
            ))}
          </div>
        </div>
      </div>

      {/* Bottom bar — hold timer */}
      <HoldTimer event={event} theme={theme} />

      <style>{`
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 32px ${theme.color}44; }
          50% { box-shadow: 0 0 56px ${theme.color}88; }
        }
        @keyframes countdown {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
      `}</style>
    </div>
  );
}

function StudentCard({ student, large, theme }) {
  const avatarSize = large ? 200 : 120;
  return (
    <div style={{
      display: 'flex', gap: large ? 24 : 16, alignItems: 'center',
      background: 'rgba(255,255,255,0.04)', borderRadius: 16,
      border: '1px solid rgba(255,255,255,0.06)',
      padding: large ? '20px 24px' : '14px 18px',
      flex: large ? '1 1 100%' : '0 1 calc(50% - 10px)',
    }}>
      <Avatar src={student.photoUrl} name={student.name} size={avatarSize} ring={theme.border} />
      <div>
        <div style={{ fontSize: large ? 32 : 22, fontWeight: 800, color: '#F1F5F9', lineHeight: 1.1 }}>
          {student.name || 'Unknown'}
        </div>
        {student.homeroom && (
          <div style={{
            marginTop: 6, display: 'inline-block',
            background: '#8B153822', border: '1px solid #8B153866',
            color: '#FCBF11', borderRadius: 8,
            padding: '3px 12px', fontSize: large ? 18 : 13, fontWeight: 700, letterSpacing: 1,
          }}>
            Class {student.homeroom}
          </div>
        )}
        {student.binusId && (
          <div style={{ fontSize: 13, color: '#475569', marginTop: 5, fontVariantNumeric: 'tabular-nums' }}>
            ID: {student.binusId}
          </div>
        )}
      </div>
    </div>
  );
}

function HoldTimer({ event, theme }) {
  const [pct, setPct] = useState(100);
  const scannedAt = event.scannedAt || event.recordedAt;

  useEffect(() => {
    const update = () => {
      const age = Date.now() - new Date(scannedAt).getTime();
      const remaining = Math.max(0, ACTIVE_WINDOW_MS - age);
      setPct((remaining / ACTIVE_WINDOW_MS) * 100);
    };
    update();
    const t = setInterval(update, 250);
    return () => clearInterval(t);
  }, [scannedAt]);

  return (
    <div style={{ flexShrink: 0, padding: '0 48px 28px' }}>
      <div style={{ height: 5, background: '#1E293B', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 99,
          background: `linear-gradient(90deg, ${theme.color}99, ${theme.color})`,
          width: `${pct}%`, transition: 'width 0.25s linear',
        }} />
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: '#334155', fontWeight: 500, textAlign: 'right' }}>
        Display clears in {Math.max(0, Math.round((ACTIVE_WINDOW_MS - (Date.now() - new Date(scannedAt).getTime())) / 1000))}s
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function GatePage() {
  const router = useRouter();
  const { token, gate, tenant, profile: profileId } = router.query;

  // Device token (same pairing system as /pickup/tv)
  const LS_TOKEN = 'pggd_device_token';
  const [deviceToken, setDeviceToken] = useState(null);
  const [bootChecked, setBootChecked] = useState(false);
  const [bootError, setBootError]   = useState(null);

  const [feed, setFeed] = useState(null);
  const [tick, setTick] = useState(0);
  const timerRef = useRef(null);

  // ── Boot: verify stored device token ──────────────────────────────────────
  useEffect(() => {
    if (!router.isReady) return;
    if (token) { setBootChecked(true); return; }
    const stored = typeof localStorage !== 'undefined' && localStorage.getItem(LS_TOKEN);
    if (!stored) { setBootChecked(true); return; }
    fetch('/api/pickup/tv/whoami', { headers: { 'x-tv-device-token': stored } })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setDeviceToken(stored);
        else { localStorage.removeItem(LS_TOKEN); setBootError(j.error || 'token rejected'); }
      })
      .catch(() => {})
      .finally(() => setBootChecked(true));
  }, [router.isReady, token]);

  // ── Feed polling ──────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    if (!token && !deviceToken) return;
    const params = new URLSearchParams({ limit: '3' });
    if (token) params.set('token', String(token));
    if (gate) params.set('gate', String(gate));
    if (tenant) params.set('tenant', String(tenant));
    if (profileId) params.set('profile', String(profileId));

    try {
      const r = await fetch(`/api/pickup/tv/feed?${params.toString()}`, {
        headers: deviceToken ? { 'x-tv-device-token': deviceToken } : {},
      });
      if (r.status === 401) { setBootError('Device token revoked — rescan QR to re-pair.'); setDeviceToken(null); return; }
      if (!r.ok) return;
      const j = await r.json();
      if (j.ok) setFeed(j);
    } catch {}
  }, [router.isReady, token, deviceToken, gate, tenant, profileId]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // ── Tick for elapsed timer ─────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Determine what to show ─────────────────────────────────────────────────
  const latest = feed?.events?.[0] || null;
  const age = latest ? Date.now() - new Date(latest.scannedAt || latest.recordedAt).getTime() : Infinity;
  const isActive = age < ACTIVE_WINDOW_MS;
  const fadeRatio = age > FADE_START_MS ? Math.min(1, (age - FADE_START_MS) / (ACTIVE_WINDOW_MS - FADE_START_MS)) : 0;

  const gateName = gate || feed?.profile?.name || null;

  // ── No auth yet ────────────────────────────────────────────────────────────
  if (!bootChecked) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#080B10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#334155', fontSize: 18, fontFamily: 'system-ui' }}>Initialising…</div>
      </div>
    );
  }

  if (!token && !deviceToken) {
    return <GatePairScreen onPaired={(t) => { setDeviceToken(t); typeof localStorage !== 'undefined' && localStorage.setItem(LS_TOKEN, t); }} />;
  }

  if (isActive && latest) {
    return (
      <>
        <Head><title>Gate Verification · BINUSFace</title></Head>
        <ActiveScreen event={latest} fadeRatio={fadeRatio} gateName={gateName} />
      </>
    );
  }

  return (
    <>
      <Head><title>Gate Verification · BINUSFace</title></Head>
      <IdleScreen gateName={gateName} gateStatus={feed?.gateStatus} tick={tick} />
    </>
  );
}

// ─── First-boot pair screen ────────────────────────────────────────────────
function GatePairScreen({ onPaired }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [pairing, setPairing] = useState(null);  // { deviceId, qrUrl, code }
  const pollRef = useRef(null);

  // Start a pairing session (generate QR)
  async function startPair() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/pickup/tv/start-pair', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceType: 'gate' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setPairing({ deviceId: j.deviceId, qrUrl: j.qrUrl, code: j.code });
      pollRef.current = setInterval(async () => {
        const pr = await fetch(`/api/pickup/tv/poll-pair?deviceId=${encodeURIComponent(j.deviceId)}`);
        const pj = await pr.json();
        if (pj.token) { clearInterval(pollRef.current); onPaired(pj.token); }
      }, 3000);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  // Legacy code-based claim
  async function claimByCode(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/pickup/tv/claim-by-code', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      onPaired(j.deviceToken);
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  useEffect(() => () => clearInterval(pollRef.current), []);

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#0A0A14', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif', color: 'white',
    }}>
      <div style={{ maxWidth: 480, padding: 48, background: '#111827', borderRadius: 24, border: '1px solid #1E293B', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🚪</div>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 8px' }}>Gate Verification Display</h1>
        <p style={{ color: '#64748B', fontSize: 14, margin: '0 0 32px', lineHeight: 1.6 }}>
          This screen needs to be paired to a kiosk profile.<br />
          Enter a setup code from the Admin panel, or scan the pairing QR.
        </p>

        {pairing ? (
          <div>
            {pairing.qrUrl && (
              <img src={pairing.qrUrl} alt="pair QR"
                style={{ width: 200, height: 200, borderRadius: 12, margin: '0 auto 16px' }} />
            )}
            <div style={{ fontSize: 13, color: '#475569' }}>
              Or admin code: <span style={{ color: '#FCBF11', fontFamily: 'monospace', fontSize: 18, fontWeight: 700 }}>{pairing.code}</span>
            </div>
            <div style={{ fontSize: 12, color: '#334155', marginTop: 8 }}>Waiting for admin to approve…</div>
          </div>
        ) : (
          <>
            <button onClick={startPair} disabled={busy} style={{
              width: '100%', padding: '14px 0', borderRadius: 12,
              background: '#8B1538', border: '1px solid #A91D47',
              color: 'white', fontWeight: 700, fontSize: 16, cursor: 'pointer',
              marginBottom: 20, opacity: busy ? 0.6 : 1,
            }}>
              {busy ? 'Generating…' : 'Generate Pairing QR'}
            </button>
            <div style={{ fontSize: 13, color: '#334155', marginBottom: 12 }}>or enter a 6-digit setup code</div>
            <form onSubmit={claimByCode} style={{ display: 'flex', gap: 8 }}>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={6} placeholder="CODE"
                style={{
                  flex: 1, padding: '12px 16px', borderRadius: 10, border: '1px solid #1E293B',
                  background: '#0D1117', color: 'white', fontSize: 22,
                  fontFamily: 'monospace', letterSpacing: 4, textAlign: 'center',
                }} />
              <button type="submit" disabled={busy || code.length < 6} style={{
                padding: '12px 20px', borderRadius: 10, background: '#16A34A', border: 'none',
                color: 'white', fontWeight: 700, fontSize: 16, cursor: 'pointer',
                opacity: (busy || code.length < 6) ? 0.5 : 1,
              }}>
                {busy ? '…' : 'Pair'}
              </button>
            </form>
          </>
        )}

        {err && <div style={{ marginTop: 16, color: '#EF4444', fontSize: 14 }}>{err}</div>}
      </div>
    </div>
  );
}
