/**
 * /pickup/teacher — Phase 2 iPad teacher app.
 *
 * Auth model: device-token only (NO Firebase login). Token is bound on first
 * launch via a 6-char pairing code generated in the admin Release Groups page.
 *
 * UX:
 *   - Pairing screen if no token → "Enter code".
 *   - 2-card "now serving" panel (max 2 active events).
 *   - Held rail below — collapsed cards, tap to release/hold again.
 *   - Red unknown_chaperone events render as a BLOCKED banner with the same
 *     Hold / Release affordances. No security escalation.
 *
 * PWA: registers /teacher-sw.js and shows install prompt (carried from Phase 1).
 */
import Head from 'next/head';
import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 2500;
const TOKEN_KEY = 'pickup.tablet.deviceToken';
const BINUS_MAROON = '#8B1538';
const BINUS_GOLD = '#FCBF11';

function fmtTime(iso) {
  if (!iso) return '--';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return '--'; }
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

function Avatar({ src, name, size = 80, ring = '#334155' }) {
  const [imgErr, setImgErr] = useState(false);
  const initials = (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', overflow: 'hidden',
      border: `3px solid ${ring}`, background: '#1E293B',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: `0 0 18px ${ring}44`, flexShrink: 0,
    }}>
      {src && !imgErr ? (
        <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgErr(true)} />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.36), fontWeight: 800, color: '#94A3B8' }}>{initials}</span>
      )}
    </div>
  );
}

function StudentChip({ s }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: '#fff7ea', border: '1.5px solid #FFD86A',
      borderRadius: 12, padding: '6px 10px',
    }}>
      <Avatar src={s.photoUrl} name={s.name} size={36} ring="#FFD86A" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', lineHeight: 1.1 }}>{s.name}</div>
        <div style={{ fontSize: 11, color: '#6b7280' }}>{s.homeroom || ''}</div>
      </div>
    </div>
  );
}

function PairingScreen({ onPaired }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (c.length !== 6) { setErr('Code must be 6 characters'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/pickup/tablet/claim-by-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: c, userAgent: navigator.userAgent }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      localStorage.setItem(TOKEN_KEY, j.deviceToken);
      onPaired(j);
    } catch (e2) {
      setErr(e2.message);
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `linear-gradient(135deg, ${BINUS_MAROON} 0%, #5a0d24 100%)`,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <form onSubmit={submit} style={{
        background: '#fff', borderRadius: 24, padding: '40px 32px',
        width: 'min(92vw, 440px)', boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 14, color: BINUS_MAROON, fontWeight: 800, letterSpacing: 2, marginBottom: 8 }}>
          BINUS · PICKUP SYSTEM
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', margin: '0 0 4px' }}>Pair this iPad</h1>
        <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 24px' }}>
          Enter the 6-character pairing code from the admin dashboard.
        </p>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCD23"
          maxLength={6}
          style={{
            width: '100%', textAlign: 'center', fontSize: 32, letterSpacing: 8,
            padding: '16px 12px', fontWeight: 800, fontFamily: 'monospace',
            border: '2px solid #e2e8f0', borderRadius: 12,
            color: '#0f172a', background: '#f8fafc',
          }}
        />
        {err && <div style={{ marginTop: 12, color: '#dc2626', fontSize: 13 }}>{err}</div>}
        <button type="submit" disabled={busy}
          style={{
            marginTop: 20, width: '100%', padding: '14px',
            background: BINUS_MAROON, color: '#fff', border: 'none',
            borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: 'pointer',
            opacity: busy ? 0.6 : 1,
          }}>
          {busy ? 'Pairing…' : 'Pair Device'}
        </button>
      </form>
    </div>
  );
}

function Card({ ev, onAction, busy, exiting, big = true }) {
  const blocked = ev.blocked || ev.cardState === 'red';
  const ring = blocked ? '#EF4444' : ev.cardState === 'yellow' ? '#FCBF11' : '#22C55E';
  const label = blocked ? 'BLOCKED — NOT IN SYSTEM'
    : ev.cardState === 'yellow' ? 'VERIFY IDENTITY'
    : 'AUTHORIZED';
  const chap = ev.chaperone || {};

  // Animation: release → fade + slide right; hold → shrink + slide down toward held rail.
  let exitStyle = {};
  if (exiting === 'release') {
    exitStyle = { opacity: 0, transform: 'translateX(60px) scale(0.94)', pointerEvents: 'none' };
  } else if (exiting === 'hold') {
    exitStyle = { opacity: 0.35, transform: 'translateY(120px) scale(0.55)', pointerEvents: 'none' };
  }

  return (
    <div style={{
      background: '#fff', borderRadius: 20,
      border: `4px solid ${ring}`, boxShadow: `0 12px 40px ${ring}33`,
      padding: big ? 22 : 14,
      display: 'flex', flexDirection: 'column', gap: 14,
      transition: 'transform 380ms cubic-bezier(0.4, 0, 0.2, 1), opacity 380ms ease',
      transformOrigin: 'center top',
      ...exitStyle,
    }}>
      <div style={{
        display: 'inline-block', alignSelf: 'flex-start',
        background: ring, color: '#fff', fontWeight: 800, fontSize: 12,
        padding: '4px 12px', borderRadius: 999, letterSpacing: 1,
      }}>{label}</div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <Avatar src={chap.photoUrl} name={chap.name} size={big ? 96 : 64} ring={ring} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: big ? 24 : 18, fontWeight: 800, color: '#0f172a', lineHeight: 1.15 }}>
            {chap.name || 'Unknown'}
          </div>
          {chap.relation && <div style={{ fontSize: 13, color: '#64748b', marginTop: 2, textTransform: 'capitalize' }}>{chap.relation}</div>}
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
            {fmtTime(ev.scannedAt)} · {timeAgo(ev.scannedAt)}
          </div>
        </div>
      </div>

      {!blocked && ev.students?.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, fontWeight: 600 }}>PICKING UP</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ev.students.map((s, i) => <StudentChip key={i} s={s} />)}
          </div>
        </div>
      )}
      {blocked && (
        <div style={{
          padding: 12, background: '#fef2f2', borderRadius: 10, border: '1px solid #fecaca',
          fontSize: 13, color: '#991b1b',
        }}>
          This person is not enrolled in the system. Check ID before releasing or hold for officer review.
        </div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="button"
          onClick={() => onAction(ev, 'hold')}
          disabled={busy[ev.id] || !!exiting}
          style={{
            flex: 1, padding: '16px', background: '#f59e0b', color: '#fff',
            border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 800,
            cursor: busy[ev.id] || exiting ? 'not-allowed' : 'pointer',
            opacity: busy[ev.id] || exiting ? 0.6 : 1,
            touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
            boxShadow: '0 4px 12px rgba(245,158,11,0.35)',
            transition: 'transform 120ms ease, box-shadow 120ms ease',
          }}
          onTouchStart={(e) => { e.currentTarget.style.transform = 'scale(0.96)'; }}
          onTouchEnd={(e) => { e.currentTarget.style.transform = ''; }}
        >
          Hold
        </button>
        <button
          type="button"
          onClick={() => onAction(ev, 'release')}
          disabled={busy[ev.id] || !!exiting}
          style={{
            flex: 1, padding: '16px', background: '#16a34a', color: '#fff',
            border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 800,
            cursor: busy[ev.id] || exiting ? 'not-allowed' : 'pointer',
            opacity: busy[ev.id] || exiting ? 0.6 : 1,
            touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
            boxShadow: '0 4px 12px rgba(22,163,74,0.4)',
            transition: 'transform 120ms ease, box-shadow 120ms ease',
          }}
          onTouchStart={(e) => { e.currentTarget.style.transform = 'scale(0.96)'; }}
          onTouchEnd={(e) => { e.currentTarget.style.transform = ''; }}
        >
          Release
        </button>
      </div>
    </div>
  );
}

function HeldCard({ ev, onAction, busy, exiting }) {
  const blocked = ev.blocked || ev.cardState === 'red';
  const ring = blocked ? '#EF4444' : ev.cardState === 'yellow' ? '#FCBF11' : '#22C55E';
  const label = blocked ? 'BLOCKED' : ev.cardState === 'yellow' ? 'VERIFY' : 'AUTHORIZED';
  const chap = ev.chaperone || {};

  // Releasing from held: fade + slide right.
  const exitStyle = exiting === 'release'
    ? { opacity: 0, transform: 'translateX(60px) scale(0.92)', pointerEvents: 'none' }
    : {};

  return (
    <div style={{
      background: '#fff', borderRadius: 16,
      border: `3px solid ${ring}`,
      boxShadow: `0 6px 20px ${ring}22, 0 2px 6px rgba(0,0,0,0.15)`,
      padding: 14,
      display: 'flex', flexDirection: 'column', gap: 10,
      transition: 'transform 380ms cubic-bezier(0.4, 0, 0.2, 1), opacity 380ms ease',
      animation: 'pickupHeldIn 360ms cubic-bezier(0.4, 0, 0.2, 1)',
      ...exitStyle,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{
          background: ring, color: '#fff', fontWeight: 800, fontSize: 10,
          padding: '3px 9px', borderRadius: 999, letterSpacing: 1,
        }}>{label}</span>
        <span style={{
          background: '#fff7ea', color: '#92400e', fontWeight: 700, fontSize: 10,
          padding: '3px 9px', borderRadius: 999, letterSpacing: 0.5,
          border: '1px solid #fde68a',
        }}>HELD</span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Avatar src={chap.photoUrl} name={chap.name} size={56} ring={ring} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 16, fontWeight: 800, color: '#0f172a', lineHeight: 1.15,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {chap.name || 'Unknown'}
          </div>
          {chap.relation && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 1, textTransform: 'capitalize' }}>
              {chap.relation}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
            Held since {fmtTime(ev.scannedAt)} · {timeAgo(ev.scannedAt)}
          </div>
        </div>
      </div>

      {!blocked && ev.students?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ev.students.map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: '#fff7ea', border: '1px solid #FFD86A',
              borderRadius: 10, padding: '4px 8px',
              fontSize: 11, fontWeight: 700, color: '#1f2937',
            }}>
              <Avatar src={s.photoUrl} name={s.name} size={22} ring="#FFD86A" />
              <span style={{ whiteSpace: 'nowrap' }}>{s.name}</span>
              {s.homeroom && <span style={{ color: '#92400e', fontWeight: 600 }}>· {s.homeroom}</span>}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => onAction(ev, 'release')}
        disabled={busy[ev.id] || !!exiting}
        style={{
          marginTop: 2, padding: '11px', background: '#16a34a', color: '#fff',
          border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 800,
          cursor: busy[ev.id] || exiting ? 'not-allowed' : 'pointer',
          opacity: busy[ev.id] || exiting ? 0.6 : 1,
          touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
          boxShadow: '0 3px 10px rgba(22,163,74,0.4)',
          transition: 'transform 120ms ease',
        }}
        onTouchStart={(e) => { e.currentTarget.style.transform = 'scale(0.96)'; }}
        onTouchEnd={(e) => { e.currentTarget.style.transform = ''; }}
      >
        Release
      </button>
    </div>
  );
}

function HeldRow({ ev, onAction, busy, exiting }) {
  // Back-compat shim — delegates to HeldCard.
  return <HeldCard ev={ev} onAction={onAction} busy={busy} exiting={exiting} />;
}

function StandbyHero({ identity, todayReleased, heldCount, lastEventAt }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const wibTime = (() => {
    const wib = new Date(now.getTime() + (now.getTimezoneOffset() + 7 * 60) * 60 * 1000);
    const hh = String(wib.getHours()).padStart(2, '0');
    const mm = String(wib.getMinutes()).padStart(2, '0');
    const ss = String(wib.getSeconds()).padStart(2, '0');
    return { hh, mm, ss };
  })();
  const wibDate = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const terminals = identity?.terminalIds?.length || 0;
  const lastSeenAgo = lastEventAt ? timeAgo(lastEventAt) : null;

  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      borderRadius: 28, padding: '48px 40px',
      background: 'radial-gradient(120% 120% at 0% 0%, rgba(252,191,17,0.10), transparent 55%), radial-gradient(120% 120% at 100% 100%, rgba(139,21,56,0.30), transparent 55%), linear-gradient(180deg, #0f172a 0%, #0b1224 100%)',
      border: '1px solid rgba(148,163,184,0.12)',
      boxShadow: '0 30px 80px -30px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)',
      minHeight: 460,
    }}>
      {/* ambient blobs */}
      <div aria-hidden style={{
        position: 'absolute', top: '-30%', left: '-20%', width: 420, height: 420,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(252,191,17,0.18) 0%, transparent 70%)',
        animation: 'pgFloatA 14s ease-in-out infinite',
      }} />
      <div aria-hidden style={{
        position: 'absolute', bottom: '-30%', right: '-20%', width: 520, height: 520,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(139,21,56,0.35) 0%, transparent 70%)',
        animation: 'pgFloatB 18s ease-in-out infinite',
      }} />

      <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 40, alignItems: 'center' }}>
        {/* LEFT: identity + clock */}
        <div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            padding: '6px 14px', borderRadius: 999,
            background: 'rgba(252,191,17,0.12)', border: '1px solid rgba(252,191,17,0.35)',
            color: BINUS_GOLD, fontSize: 11, fontWeight: 800, letterSpacing: 2,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', background: '#22c55e',
              boxShadow: '0 0 0 0 rgba(34,197,94,0.7)', animation: 'pgPulseDot 1.8s ease-out infinite',
            }} />
            LIVE · LISTENING
          </div>

          <div style={{ marginTop: 18, fontSize: 13, color: '#94a3b8', letterSpacing: 1.5, fontWeight: 700 }}>
            RELEASE GROUP
          </div>
          <div style={{ fontSize: 38, fontWeight: 900, color: '#f8fafc', lineHeight: 1.05, marginTop: 4, letterSpacing: -0.5 }}>
            {identity?.releaseGroupName || '—'}
          </div>
          {identity?.gradeLabel && (
            <div style={{
              display: 'inline-block', marginTop: 10,
              padding: '4px 12px', borderRadius: 8,
              background: BINUS_MAROON, color: '#fff', fontWeight: 800, fontSize: 13, letterSpacing: 1,
            }}>{identity.gradeLabel}</div>
          )}

          <div style={{
            marginTop: 32, display: 'flex', alignItems: 'baseline', gap: 4,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: '#f1f5f9',
          }}>
            <span style={{ fontSize: 64, fontWeight: 700, letterSpacing: -2 }}>{wibTime.hh}</span>
            <span style={{ fontSize: 64, fontWeight: 200, color: '#475569', animation: 'pgBlink 1s steps(2,end) infinite' }}>:</span>
            <span style={{ fontSize: 64, fontWeight: 700, letterSpacing: -2 }}>{wibTime.mm}</span>
            <span style={{ fontSize: 28, fontWeight: 400, color: '#64748b', marginLeft: 6 }}>{wibTime.ss}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: BINUS_GOLD, marginLeft: 10, letterSpacing: 1 }}>WIB</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 13, color: '#94a3b8' }}>{wibDate}</div>
        </div>

        {/* RIGHT: standby visualizer + stats */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
          <div style={{
            position: 'relative', width: 220, height: 220,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {[0, 1, 2].map((i) => (
              <div key={i} aria-hidden style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                border: `2px solid ${BINUS_GOLD}`, opacity: 0,
                animation: `pgRipple 3.2s cubic-bezier(0.22,1,0.36,1) ${i * 1.06}s infinite`,
              }} />
            ))}
            <div style={{
              width: 110, height: 110, borderRadius: '50%',
              background: `radial-gradient(circle at 30% 30%, ${BINUS_GOLD}, #c89308)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: `0 20px 50px -10px ${BINUS_GOLD}88, inset 0 -8px 20px rgba(0,0,0,0.25)`,
            }}>
              <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke={BINUS_MAROON} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3.5" />
                <path d="M12 2 L12 5 M12 19 L12 22 M2 12 L5 12 M19 12 L22 12 M4.93 4.93 L7.05 7.05 M16.95 16.95 L19.07 19.07 M4.93 19.07 L7.05 16.95 M16.95 7.05 L19.07 4.93" />
              </svg>
            </div>
          </div>
          <div style={{ textAlign: 'center', color: '#cbd5e1' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Awaiting next pickup</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
              {lastSeenAgo ? `Last activity ${lastSeenAgo}` : 'Standing by for terminal scans'}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, width: '100%' }}>
            <Stat label="TERMINALS" value={terminals} accent={BINUS_GOLD} />
            <Stat label="RELEASED TODAY" value={todayReleased ?? 0} accent="#22c55e" />
            <Stat label="ON HOLD" value={heldCount ?? 0} accent="#f59e0b" />
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes pgPulseDot {
          0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.7); }
          70%  { box-shadow: 0 0 0 14px rgba(34,197,94,0); }
          100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
        }
        @keyframes pgBlink { 0%,49%{opacity:1} 50%,100%{opacity:0.25} }
        @keyframes pgRipple {
          0%   { transform: scale(0.55); opacity: 0.55; }
          80%  { opacity: 0.05; }
          100% { transform: scale(1.05); opacity: 0; }
        }
        @keyframes pgFloatA {
          0%,100% { transform: translate(0,0); }
          50%     { transform: translate(40px,30px); }
        }
        @keyframes pgFloatB {
          0%,100% { transform: translate(0,0); }
          50%     { transform: translate(-40px,-30px); }
        }
      `}</style>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{
      padding: '14px 12px', borderRadius: 14,
      background: 'rgba(15,23,42,0.55)', border: `1px solid rgba(148,163,184,0.15)`,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: accent, lineHeight: 1, fontFamily: 'ui-monospace, monospace' }}>{value}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: 1.2, marginTop: 6 }}>{label}</div>
    </div>
  );
}

export default function TeacherTabletPage() {
  const [token, setToken] = useState(null);
  const [identity, setIdentity] = useState(null);   // whoami payload
  const [feed, setFeed] = useState({ active: [], held: [], todayReleased: 0 });
  const [lastEventAt, setLastEventAt] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});
  const [exiting, setExiting] = useState({}); // id → 'release' | 'hold'
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const [showInstall, setShowInstall] = useState(false);
  const pollRef = useRef(null);

  // Load token from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) setToken(t);
  }, []);

  // PWA: register service worker + install prompt
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/teacher-sw.js', { scope: '/pickup/teacher' }).catch(() => {});
    const onBip = (e) => { e.preventDefault(); setInstallPromptEvent(e); setShowInstall(true); };
    const onInstalled = () => { setShowInstall(false); setInstallPromptEvent(null); };
    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);

    // iOS Safari never fires beforeinstallprompt. Detect iOS + non-standalone
    // and show our own "Install" affordance that opens an instruction sheet.
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (isIOS && !isStandalone) setShowInstall(true);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // whoami: validate token, get release group + terminals
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/pickup/tablet/whoami`, {
          headers: { 'x-tablet-device-token': token },
        });
        const j = await r.json();
        if (!r.ok) {
          if (r.status === 401) {
            localStorage.removeItem(TOKEN_KEY);
            if (!cancelled) setToken(null);
          }
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        if (!cancelled) { setIdentity(j); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Poll feed
  const pollFeed = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`/api/pickup/tablet/feed?max=2&t=${Date.now()}`, {
        headers: { 'x-tablet-device-token': token },
        cache: 'no-store',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setFeed({ active: j.active || [], held: j.held || [], todayReleased: j.todayReleased || 0 });
      // Track most recent activity timestamp for the standby hero
      const latest = [...(j.active || []), ...(j.held || [])]
        .map((e) => e.scannedAt || e.recordedAt)
        .filter(Boolean)
        .sort()
        .pop();
      if (latest) setLastEventAt(latest);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, [token]);

  useEffect(() => {
    if (!token || !identity) return;
    pollFeed();
    pollRef.current = setInterval(pollFeed, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [token, identity, pollFeed]);

  const onAction = async (ev, action) => {
    const id = ev.id;
    if (busy[id] || exiting[id]) return;
    setBusy((b) => ({ ...b, [id]: true }));
    setExiting((e) => ({ ...e, [id]: action })); // kick off CSS transition immediately
    const ANIM_MS = 380;
    const animDone = new Promise((r) => setTimeout(r, ANIM_MS));
    try {
      const r = await fetch(`/api/pickup/tablet/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tablet-device-token': token },
        body: JSON.stringify({ eventId: ev.eventId || ev.id, action }),
        cache: 'no-store',
      });
      const j = await r.json();
      // 404 = the event no longer exists (already resolved on another iPad,
      // or stale state from a cached feed). Don't alert — just refresh.
      if (r.status === 404) {
        await animDone;
        await pollFeed();
        return;
      }
      if (!r.ok) throw new Error(j.error || 'failed');
      await animDone; // let the card finish its exit animation
      await pollFeed(); // server now reflects new status; rerender drops/relocates the card
    } catch (e) {
      // rollback animation so user sees the card return + the error
      setExiting((m) => { const n = { ...m }; delete n[id]; return n; });
      alert(e.message);
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[id]; return n; });
      // clear exiting after a tick so the freshly-fetched feed renders normally
      setTimeout(() => {
        setExiting((m) => { const n = { ...m }; delete n[id]; return n; });
      }, 50);
    }
  };

  const [showIosHint, setShowIosHint] = useState(false);

  const installPwa = async () => {
    // Native (Chrome / Edge / Android) path: real beforeinstallprompt event.
    if (installPromptEvent) {
      installPromptEvent.prompt();
      await installPromptEvent.userChoice.catch(() => {});
      setShowInstall(false);
      return;
    }
    // iOS: no programmatic install \u2014 show a how-to sheet.
    setShowIosHint(true);
  };

  const unpair = () => {
    if (!confirm('Unpair this iPad? You will need a new code from the admin.')) return;
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setIdentity(null);
    setFeed({ active: [], held: [], todayReleased: 0 });
  };

  if (!token) {
    return (
      <>
        <Head>
          <title>Pair · BINUS Pickup System</title>
          <link rel="manifest" href="/teacher-manifest.webmanifest" />
          <meta name="theme-color" content={BINUS_MAROON} />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
          <meta name="apple-mobile-web-app-title" content="Teacher Pickup" />
        </Head>
        <PairingScreen onPaired={(payload) => {
          setToken(payload.deviceToken);
          setIdentity({
            releaseGroupId: payload.releaseGroupId,
            releaseGroupName: payload.releaseGroupName,
            gradeLabel: payload.gradeLabel,
            terminalIds: payload.terminalIds || [],
          });
        }} />
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{identity?.releaseGroupName || 'Teacher'} · BINUS Pickup System</title>
        <link rel="manifest" href="/teacher-manifest.webmanifest" />
        <meta name="theme-color" content={BINUS_MAROON} />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Teacher Pickup" />
      </Head>
      <div style={{
        minHeight: '100vh', background: '#0f172a',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#e2e8f0',
      }}>
        <style>{`
          @keyframes pickupHeldIn {
            from { opacity: 0; transform: translateY(-12px) scale(0.96); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
          button:active { filter: brightness(0.95); }
        `}</style>
        <div style={{
          background: BINUS_MAROON, padding: '14px 22px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: `3px solid ${BINUS_GOLD}`,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: BINUS_GOLD, letterSpacing: 2 }}>BINUS · PICKUP SYSTEM</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', marginTop: 2 }}>
              {identity?.releaseGroupName || '—'}
              {identity?.gradeLabel && <span style={{ fontSize: 13, color: '#fcd34d', marginLeft: 10 }}>{identity.gradeLabel}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {showInstall && (
              <button onClick={installPwa}
                style={{ padding: '6px 12px', background: BINUS_GOLD, color: BINUS_MAROON, border: 'none', borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
                Install
              </button>
            )}
            <button onClick={unpair}
              style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 8, fontSize: 12, cursor: 'pointer' }}>
              Unpair
            </button>
          </div>
        </div>

        {err && (
          <div style={{ background: '#7f1d1d', color: '#fecaca', padding: '8px 22px', fontSize: 13 }}>
            {err}
          </div>
        )}

        {/* Active panel: max 2 cards */}
        <div style={{ padding: '22px', maxWidth: 1400, margin: '0 auto' }}>
          {(() => {
            const activeTwo = (feed.active || []).slice(0, 2);
            if (activeTwo.length === 0) {
              return (
                <StandbyHero
                  identity={identity}
                  todayReleased={feed.todayReleased}
                  heldCount={feed.held.length}
                  lastEventAt={lastEventAt}
                />
              );
            }
            return (
              <div style={{
                display: 'grid',
                gridTemplateColumns: activeTwo.length === 1 ? '1fr' : 'repeat(2, minmax(0, 1fr))',
                gap: 18,
              }}>
                {activeTwo.map((ev) => (
                  <Card key={ev.id} ev={ev} onAction={onAction} busy={busy} exiting={exiting[ev.id]} big />
                ))}
              </div>
            );
          })()}

          {/* Divider + Held rail */}
          {feed.held.length > 0 && (
            <div style={{ marginTop: 36 }}>
              {/* Divider line with inline label */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18,
              }}>
                <div style={{
                  flex: 1, height: 1,
                  background: 'linear-gradient(to right, transparent, rgba(245,158,11,0.5), rgba(245,158,11,0.5))',
                }} />
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 16px', borderRadius: 999,
                  background: 'rgba(245,158,11,0.12)',
                  border: '1px solid rgba(245,158,11,0.4)',
                  color: '#fbbf24', fontSize: 12, fontWeight: 800, letterSpacing: 2,
                  whiteSpace: 'nowrap',
                }}>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                    background: '#f59e0b', boxShadow: '0 0 10px #f59e0b',
                  }} />
                  ON HOLD
                  <span style={{
                    background: '#f59e0b', color: '#1f1300',
                    borderRadius: 999, padding: '1px 9px', fontSize: 11, fontWeight: 900,
                  }}>{feed.held.length}</span>
                </div>
                <div style={{
                  flex: 1, height: 1,
                  background: 'linear-gradient(to left, transparent, rgba(245,158,11,0.5), rgba(245,158,11,0.5))',
                }} />
              </div>

              {/* Held cards: smaller, grid (3-up at wide widths, 2-up tablet, 1-up phone) */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 14,
              }}>
                {feed.held.map((ev) => (
                  <HeldCard key={ev.id} ev={ev} onAction={onAction} busy={busy} exiting={exiting[ev.id]} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {showIosHint && (
        <div
          onClick={() => setShowIosHint(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', color: '#0f172a', borderRadius: 18,
              maxWidth: 460, width: '100%', padding: '26px 24px',
              boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 800, color: BINUS_MAROON, letterSpacing: 2 }}>
              INSTALL ON THIS iPAD
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>
              Add Teacher Pickup to Home Screen
            </div>
            <ol style={{ paddingLeft: 22, marginTop: 16, fontSize: 15, lineHeight: 1.55, color: '#334155' }}>
              <li>Tap the <strong>Share</strong> icon in Safari&rsquo;s toolbar
                <span style={{ marginLeft: 6, fontSize: 18 }} aria-hidden>⬆️</span>
              </li>
              <li>Scroll and tap <strong>&ldquo;Add to Home Screen&rdquo;</strong></li>
              <li>Tap <strong>Add</strong> in the top-right corner</li>
              <li>Open <strong>Teacher Pickup</strong> from the Home Screen &mdash; it will run full-screen</li>
            </ol>
            <div style={{
              marginTop: 16, padding: 12, background: '#fff7ea',
              border: '1px solid #FFD86A', borderRadius: 10,
              fontSize: 13, color: '#7c4a03',
            }}>
              You must use <strong>Safari</strong> (not Chrome) to install on iPad.
            </div>
            <button
              type="button"
              onClick={() => setShowIosHint(false)}
              style={{
                marginTop: 20, width: '100%', padding: '14px',
                background: BINUS_MAROON, color: '#fff', border: 'none',
                borderRadius: 12, fontSize: 16, fontWeight: 800, cursor: 'pointer',
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
