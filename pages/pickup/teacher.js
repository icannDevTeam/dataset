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
          BINUS · PICKUPGUARD
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

function Card({ ev, onAction, busy, big = true }) {
  const blocked = ev.blocked || ev.cardState === 'red';
  const ring = blocked ? '#EF4444' : ev.cardState === 'yellow' ? '#FCBF11' : '#22C55E';
  const label = blocked ? 'BLOCKED — NOT IN SYSTEM'
    : ev.cardState === 'yellow' ? 'VERIFY IDENTITY'
    : 'AUTHORIZED';
  const chap = ev.chaperone || {};

  return (
    <div style={{
      background: '#fff', borderRadius: 20,
      border: `4px solid ${ring}`, boxShadow: `0 12px 40px ${ring}33`,
      padding: big ? 22 : 14,
      display: 'flex', flexDirection: 'column', gap: 14,
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
        <button onClick={() => onAction(ev, 'hold')} disabled={busy[ev.id]}
          style={{
            flex: 1, padding: '14px', background: '#f59e0b', color: '#fff',
            border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 800, cursor: 'pointer',
            opacity: busy[ev.id] ? 0.6 : 1,
          }}>
          Hold
        </button>
        <button onClick={() => onAction(ev, 'release')} disabled={busy[ev.id]}
          style={{
            flex: 1, padding: '14px', background: '#16a34a', color: '#fff',
            border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 800, cursor: 'pointer',
            opacity: busy[ev.id] ? 0.6 : 1,
          }}>
          Release
        </button>
      </div>
    </div>
  );
}

function HeldRow({ ev, onAction, busy }) {
  const blocked = ev.blocked || ev.cardState === 'red';
  const ring = blocked ? '#EF4444' : ev.cardState === 'yellow' ? '#FCBF11' : '#22C55E';
  const chap = ev.chaperone || {};
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: '#1e293b', border: `1.5px solid ${ring}66`,
      borderRadius: 12, padding: '10px 14px',
    }}>
      <Avatar src={chap.photoUrl} name={chap.name} size={44} ring={ring} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {chap.name || 'Unknown'}
          {blocked && <span style={{ marginLeft: 8, fontSize: 10, color: '#fca5a5', fontWeight: 800 }}>BLOCKED</span>}
        </div>
        <div style={{ color: '#94a3b8', fontSize: 12 }}>
          {fmtTime(ev.scannedAt)} · {timeAgo(ev.scannedAt)} · {ev.students?.map((s) => s.name).join(', ') || '—'}
        </div>
      </div>
      <button onClick={() => onAction(ev, 'release')} disabled={busy[ev.id]}
        style={{
          padding: '8px 14px', background: '#16a34a', color: '#fff',
          border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
          opacity: busy[ev.id] ? 0.6 : 1,
        }}>
        Release
      </button>
    </div>
  );
}

export default function TeacherTabletPage() {
  const [token, setToken] = useState(null);
  const [identity, setIdentity] = useState(null);   // whoami payload
  const [feed, setFeed] = useState({ active: [], held: [] });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});
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
      const r = await fetch(`/api/pickup/tablet/feed?max=2`, {
        headers: { 'x-tablet-device-token': token },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setFeed({ active: j.active || [], held: j.held || [] });
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
    setBusy((b) => ({ ...b, [ev.id]: true }));
    try {
      const r = await fetch(`/api/pickup/tablet/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tablet-device-token': token },
        body: JSON.stringify({ eventId: ev.eventId || ev.id, action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      pollFeed();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy((b) => ({ ...b, [ev.id]: false }));
    }
  };

  const installPwa = async () => {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice.catch(() => {});
    setShowInstall(false);
  };

  const unpair = () => {
    if (!confirm('Unpair this iPad? You will need a new code from the admin.')) return;
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setIdentity(null);
    setFeed({ active: [], held: [] });
  };

  if (!token) {
    return (
      <>
        <Head>
          <title>Pair · BINUS PickupGuard</title>
          <link rel="manifest" href="/teacher-manifest.webmanifest" />
          <meta name="theme-color" content={BINUS_MAROON} />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
        <title>{identity?.releaseGroupName || 'Teacher'} · BINUS PickupGuard</title>
        <link rel="manifest" href="/teacher-manifest.webmanifest" />
        <meta name="theme-color" content={BINUS_MAROON} />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <div style={{
        minHeight: '100vh', background: '#0f172a',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#e2e8f0',
      }}>
        {/* Header */}
        <div style={{
          background: BINUS_MAROON, padding: '14px 22px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: `3px solid ${BINUS_GOLD}`,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: BINUS_GOLD, letterSpacing: 2 }}>BINUS · PICKUPGUARD</div>
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
        <div style={{ padding: '22px', maxWidth: 1200, margin: '0 auto' }}>
          {feed.active.length === 0 ? (
            <div style={{
              padding: '40px 20px', textAlign: 'center',
              border: '2px dashed #334155', borderRadius: 16, color: '#64748b',
            }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>👋</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>No active pickups</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>New scans on your terminals will appear here.</div>
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: feed.active.length === 1 ? '1fr' : 'repeat(auto-fit, minmax(360px, 1fr))',
              gap: 18,
            }}>
              {feed.active.map((ev) => (
                <Card key={ev.id} ev={ev} onAction={onAction} busy={busy} big />
              ))}
            </div>
          )}

          {/* Held rail */}
          {feed.held.length > 0 && (
            <div style={{ marginTop: 30 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
                color: '#cbd5e1', fontSize: 14, fontWeight: 700, letterSpacing: 1,
              }}>
                <span>ON HOLD</span>
                <span style={{ background: '#f59e0b', color: '#fff', borderRadius: 999, padding: '2px 10px', fontSize: 11 }}>
                  {feed.held.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {feed.held.map((ev) => (
                  <HeldRow key={ev.id} ev={ev} onAction={onAction} busy={busy} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
