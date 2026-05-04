/**
 * /pickup/tv  — FireTV / kiosk pickup-verification display
 *
 * URL params:
 *   ?token=<PICKUP_TV_TOKEN>     required (matches API)
 *   ?gate=<gate name>            optional, filter to one gate
 *   ?tenant=<tenant id>          optional override
 *
 * Brand: BINUS maroon (#8B1538), gold (#FCBF11), white. Designed for
 * 1920×1080 living-room TVs with overscan-safe padding. Polls
 * /api/pickup/tv/feed every 2s.
 */
import Head from 'next/head';
import { useEffect, useState, useRef, useMemo } from 'react';
import { useRouter } from 'next/router';

// ─── BINUS Spirit Values (mirrors mobile-attendance HomePage) ─────
const SPIRIT_VALUES = [
  { short: 'S', word: 'Striving',     desc: 'for excellence' },
  { short: 'P', word: 'Perseverance', desc: 'in every challenge' },
  { short: 'I', word: 'Integrity',    desc: 'in every action' },
  { short: 'R', word: 'Respect',      desc: 'for all' },
  { short: 'I', word: 'Innovation',   desc: 'for the future' },
  { short: 'T', word: 'Teamwork',     desc: 'to achieve together' },
];

const STATE_THEME = {
  green:  { ring: '#22C55E', label: 'AUTHORISED',   tone: 'success', icon: '✓' },
  yellow: { ring: '#FCBF11', label: 'CHECK GATE',   tone: 'warn',    icon: '⚠' },
  red:    { ring: '#EF4444', label: 'NOT ALLOWED',  tone: 'danger',  icon: '✕' },
};

const DECISION_LABEL = {
  ok:                    'Authorised pickup',
  suspended:             'Chaperone suspended',
  unknown_chaperone:     'Unknown chaperone',
  reenroll_overdue:      'Re-enrollment overdue',
};

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return '—'; }
}

function computeGateTimer(clock, gateStatus) {
  if (!clock || !gateStatus?.configured || !gateStatus?.opensAt || !gateStatus?.closesAt) return null;
  try {
    const [oh, om] = gateStatus.opensAt.split(':').map((x) => parseInt(x, 10));
    const [ch, cm] = gateStatus.closesAt.split(':').map((x) => parseInt(x, 10));

    // Schedule is defined in Asia/Jakarta local time (WIB, UTC+7).
    const wibNow = new Date(clock.getTime() + 7 * 60 * 60 * 1000);
    const y = wibNow.getUTCFullYear();
    const m = wibNow.getUTCMonth();
    const d = wibNow.getUTCDate();

    let wibOpen = new Date(Date.UTC(y, m, d, oh, om, 0));
    let wibClose = new Date(Date.UTC(y, m, d, ch, cm, 0));

    // Overnight window support (e.g. 22:00 -> 05:00)
    if (wibClose.getTime() <= wibOpen.getTime()) {
      wibClose.setUTCDate(wibClose.getUTCDate() + 1);
    }

    let label = 'Pick-up opens in';
    let target = wibOpen;
    let tone = 'closed';

    if (wibNow.getTime() < wibOpen.getTime()) {
      // Before opening today -> count down to open.
      label = 'Pick-up opens in';
      target = wibOpen;
      tone = 'closed';
    } else if (wibNow.getTime() < wibClose.getTime()) {
      // Inside active window -> count down to close.
      label = 'Window closes in';
      target = wibClose;
      tone = 'open';
    } else {
      // Past close -> next opening is tomorrow.
      label = 'Pick-up opens in';
      wibOpen = new Date(Date.UTC(y, m, d, oh, om, 0));
      wibOpen.setUTCDate(wibOpen.getUTCDate() + 1);
      target = wibOpen;
      tone = 'closed';
    }

    const totalSec = Math.max(0, Math.floor((target.getTime() - wibNow.getTime()) / 1000));
    const h = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const value = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    return { label, value, tone };
  } catch {
    return null;
  }
}

export default function PickupTV() {
  const router = useRouter();
  const { token, gate, tenant, profile: profileId } = router.query;
  const [mounted, setMounted] = useState(false);
  const [feed, setFeed] = useState({ events: [], now: null, profile: null });
  const [err, setErr] = useState(null);
  const [clock, setClock] = useState(null);
  const [online, setOnline] = useState(true);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const lastEventIdRef = useRef(null);

  // ─── Device session (per-TV pairing token) ─────────────────────────────────
  // localStorage key — TV remembers this across reboots; admin can revoke server-side.
  const LS_TOKEN = 'pgtv_device_token';
  const [deviceToken, setDeviceToken] = useState(null);
  const [bootChecked, setBootChecked] = useState(false);   // finished initial whoami probe
  const [bootError, setBootError] = useState(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // On first mount, hydrate token from localStorage and verify with server
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!router.isReady) return;
    // Legacy compat — explicit ?token= URL still works (skip device flow)
    if (token) { setBootChecked(true); return; }
    const stored = window.localStorage.getItem(LS_TOKEN);
    if (!stored) { setBootChecked(true); return; }
    (async () => {
      try {
        const r = await fetch('/api/pickup/tv/whoami', {
          headers: { 'x-tv-device-token': stored },
        });
        const j = await r.json();
        if (!r.ok) {
          // Token rejected — clear and fall back to entry screen
          window.localStorage.removeItem(LS_TOKEN);
          setBootError(j.error || 'token rejected');
        } else {
          setDeviceToken(stored);
        }
      } catch (e) {
        setBootError(e.message);
      } finally {
        setBootChecked(true);
      }
    })();
  }, [router.isReady, token]);

  // Persist token after a successful claim/pair
  const adoptDeviceToken = (tok) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(LS_TOKEN, tok);
    setDeviceToken(tok);
  };
  const forgetDevice = () => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(LS_TOKEN);
    setDeviceToken(null);
  };

  // Poll feed every 2s
  useEffect(() => {
    if (!router.isReady) return;
    if (!token && !deviceToken) return;   // wait for auth source
    let cancelled = false;
    const tick = async () => {
      try {
        const params = new URLSearchParams();
        if (token) params.set('token', String(token));
        if (gate) params.set('gate', String(gate));
        if (tenant) params.set('tenant', String(tenant));
        if (profileId) params.set('profile', String(profileId));
        const r = await fetch(`/api/pickup/tv/feed?${params.toString()}`, {
          cache: 'no-store',
          headers: deviceToken ? { 'x-tv-device-token': deviceToken } : {},
        });
        const j = await r.json();
        if (cancelled) return;
        if (r.status === 401 && deviceToken) {
          // device was revoked / re-paired — drop token and bounce to entry screen
          forgetDevice();
          setBootError(j.error || 'device revoked');
          return;
        }
        if (!r.ok) throw new Error(j.error || j.message || 'feed error');
        if (j?.now) {
          const serverTs = new Date(j.now).getTime();
          if (!Number.isNaN(serverTs)) {
            setServerOffsetMs(serverTs - Date.now());
          }
        }
        setFeed(j);
        setOnline(true);
        setErr(null);
      } catch (e) {
        if (!cancelled) { setOnline(false); setErr(e.message); }
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [router.isReady, token, deviceToken, gate, tenant, profileId]);

  // Clock tick — initialise on client only to avoid SSR hydration mismatch
  useEffect(() => {
    const syncClock = () => setClock(new Date(Date.now() + serverOffsetMs));
    syncClock();
    const t = setInterval(syncClock, 1000);
    return () => clearInterval(t);
  }, [serverOffsetMs]);

  // Try to enter fullscreen on first explicit keyboard gesture (F or Enter).
  // We deliberately do NOT bind to `click` — clicking the Next.js dev error
  // overlay close button counts as a user gesture and would silently jump the
  // page to fullscreen, which looks like the browser is closing.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'f' && e.key !== 'F' && e.key !== 'Enter') return;
      if (document.fullscreenElement) return;
      try { document.documentElement.requestFullscreen?.(); } catch {}
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const profile = feed.profile || null;
  // Default wall = 1 featured + 3 supporting cards. Profile can override (max 8).
  const maxCards = profile?.maxCards || 4;
  const showQueue = profile ? profile.showQueue !== false : true;
  const beepEnabled = profile ? profile.beepEnabled !== false : true;

  // Beep on a brand-new event (best-effort)
  useEffect(() => {
    if (!beepEnabled) return;
    const top = feed.events?.[0];
    if (!top) return;
    if (lastEventIdRef.current === null) { lastEventIdRef.current = top.id; return; }
    if (top.id !== lastEventIdRef.current) {
      lastEventIdRef.current = top.id;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        const freq = top.cardState === 'red' ? 280 : top.cardState === 'yellow' ? 520 : 880;
        o.frequency.value = freq; o.type = 'sine';
        g.gain.value = 0.07;
        o.start(); o.stop(ctx.currentTime + 0.18);
      } catch {}
    }
  }, [feed.events, beepEnabled]);

  const events = feed.events || [];
  const wallSize = Math.min(maxCards, 8); // CSS grid templates only defined up to count-8
  const baseWall = events.slice(0, wallSize);
  // Queue holds the next 12 most recent events (room for fast-arriving streams).
  const queue = showQueue ? events.slice(wallSize, wallSize + 12) : [];
  const gateStatus = feed.gateStatus || null;
  const gateClosed = !!(gateStatus && gateStatus.configured && !gateStatus.open);
  const gateTimer = useMemo(() => computeGateTimer(clock, gateStatus), [clock, gateStatus]);

  const todayCount = useMemo(() => events.length, [events]);
  const okCount    = useMemo(() => events.filter((e) => e.cardState === 'green').length, [events]);

  // ─── #7 Per-gate stats (last 30 min, derived from feed) ────────────
  const gateStats = useMemo(() => {
    const out = new Map();
    for (const e of events) {
      const k = e.gate || e.deviceName || 'Unknown';
      const cur = out.get(k) || { gate: k, total: 0, ok: 0, warn: 0, deny: 0 };
      cur.total++;
      if (e.cardState === 'green') cur.ok++;
      else if (e.cardState === 'yellow') cur.warn++;
      else if (e.cardState === 'red') cur.deny++;
      out.set(k, cur);
    }
    return Array.from(out.values()).sort((a, b) => b.total - a.total).slice(0, 4);
  }, [events]);

  // ─── #1 Auto-rotate featured card every 8s through the wall ────────
  // When a new scan arrives it inserts at slot 0 of baseWall.  Instead of
  // immediately jumping focus to slot 0, we shift the index by +1 so the
  // currently-featured card stays on screen for its remaining time.  The new
  // event will be reached naturally on the next rotation cycle.
  // rotateGen is bumped on each new arrival to restart the 8s timer, giving
  // the current card a fresh full slot rather than an interrupted one.
  const [featuredIdx, setFeaturedIdx] = useState(0);
  const [rotateGen, setRotateGen] = useState(0);
  const topEventId = baseWall[0]?.id;
  const lastTopRef = useRef(null);
  useEffect(() => {
    if (topEventId && topEventId !== lastTopRef.current) {
      lastTopRef.current = topEventId;
      // Keep the currently-featured card stable after the new event shifts
      // every existing card one position to the right in baseWall.
      setFeaturedIdx((i) => i + 1);
      // Restart the 8s countdown so the current card keeps its full slot.
      setRotateGen((g) => g + 1);
    }
  }, [topEventId]);
  useEffect(() => {
    if (baseWall.length <= 1) return;
    const t = setInterval(() => {
      setFeaturedIdx((i) => (i + 1) % baseWall.length);
    }, 12000);
    return () => clearInterval(t);
  }, [baseWall.length, rotateGen]);

  // Reorder so the rotated event is in the featured slot.
  const wall = useMemo(() => {
    if (!baseWall.length) return baseWall;
    const idx = featuredIdx % baseWall.length;
    if (idx === 0) return baseWall;
    return [baseWall[idx], ...baseWall.filter((_, i) => i !== idx)];
  }, [baseWall, featuredIdx]);

  // ─── #3 "Just arrived" toast on new RED/YELLOW (auto-dismiss) ──────
  const [toastEv, setToastEv] = useState(null);
  const lastFlaggedIdRef = useRef(null);
  useEffect(() => {
    const top = events[0];
    if (!top) return;
    if (top.cardState === 'green') return;
    if (top.id === lastFlaggedIdRef.current) return;
    lastFlaggedIdRef.current = top.id;
    setToastEv(top);
    const t = setTimeout(() => setToastEv(null), 5000);
    return () => clearTimeout(t);
  }, [events]);

  // ─── #8 Idle screensaver after 10 min with no new events ───────────
  const SCREENSAVER_AFTER_MS = 10 * 60 * 1000;
  const [screensaverOn, setScreensaverOn] = useState(false);
  const lastEventAtRef = useRef(Date.now() + serverOffsetMs);
  useEffect(() => {
    if (events[0]) lastEventAtRef.current = Date.now() + serverOffsetMs;
  }, [events, serverOffsetMs]);
  useEffect(() => {
    const t = setInterval(() => {
      const idle = (Date.now() + serverOffsetMs) - lastEventAtRef.current;
      setScreensaverOn(idle > SCREENSAVER_AFTER_MS && !gateClosed);
    }, 5000);
    return () => clearInterval(t);
  }, [gateClosed, serverOffsetMs]);
  // Wake screensaver if a new event arrives
  useEffect(() => {
    if (events[0]) setScreensaverOn(false);
  }, [events]);

  if (!mounted || !router.isReady) {
    return <FullCenter><div className="text-white opacity-60 text-xl">Loading…</div></FullCenter>;
  }

  // No legacy URL token AND no device token yet → show the entry/pair screen.
  if (!token && !deviceToken) {
    if (!bootChecked) {
      return <FullCenter><div className="text-white opacity-60 text-xl">Loading…</div></FullCenter>;
    }
    return (
      <TvEntryScreen
        bootError={bootError}
        onAdopt={(tok) => adoptDeviceToken(tok)}
      />
    );
  }

  return (
    <>
      <Head>
        <title>BINUS PickupGuard · TV Display</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className="tv-root">
        {/* ─── Header ─── */}
        <header className="tv-header">
          <div className="tv-header-left">
            <div className="tv-logo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/binus-logo.jpg" alt="BINUS" />
            </div>
            <div className="tv-brand-block">
              <div className="tv-brand">BINUS School Simprug</div>
              <div className="tv-sub">
                {profile?.name
                  ? <>PickupGuard · <span style={{color:'var(--binus-gold)'}}>{profile.name}</span></>
                  : <>PickupGuard · Verification Display{gate ? ` · ${gate}` : ''}</>}
              </div>
            </div>
          </div>
          <div className="tv-header-right">
            <div className="tv-stat"><span>{okCount}</span><label>Verified · last 30 min</label></div>
            <div className="tv-stat"><span>{todayCount}</span><label>Total events</label></div>
            {gateTimer ? (
              <div className={`tv-gate-timer ${gateTimer.tone}`}>
                <div className="gtt-label">{gateTimer.label}</div>
                <div className="gtt-value">{gateTimer.value}</div>
              </div>
            ) : gateStatus?.configured === false ? (
              <div className="tv-gate-timer neutral">
                <div className="gtt-label">Schedule</div>
                <div className="gtt-value">Always open</div>
              </div>
            ) : null}
            <div className="tv-clock">
              <div className="tv-time">{clock ? clock.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--'}</div>
              <div className="tv-date">{clock ? clock.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' }) : ''}</div>
            </div>
            <div className={`tv-dot ${online ? 'on' : 'off'}`} title={online ? 'Live' : 'Reconnecting'} />
          </div>
        </header>

        {/* ─── Main ─── */}
        <main className={`tv-main ${showQueue && !gateClosed ? '' : 'no-queue'}`}>
          {/* Card wall (up to 5) */}
          <section className="tv-wall">
            {gateClosed ? (
              <GateClosed profile={profile} gateStatus={gateStatus} clock={clock} />
            ) : wall.length === 0 ? (
              <IdleSplash />
            ) : (
              <div className={`wall-grid count-${wall.length}`}>
                {wall.map((e, i) => (
                  <PickupCard key={e.id} ev={e} featured={i === 0} serverOffsetMs={serverOffsetMs} />
                ))}
              </div>
            )}
          </section>

          {/* Queue */}
          {!gateClosed && (
            <aside className="tv-queue">
              <div className="tv-queue-title">
                <span>Queue</span>
                <small>{queue.length} waiting</small>
              </div>
              <div className="tv-queue-list">
                {queue.length === 0 ? (
                  <div className="tv-empty">No earlier events</div>
                ) : queue.map((e) => <QueueRow key={e.id} ev={e} />)}
              </div>
            </aside>
          )}
        </main>

        {/* ─── Spirit Ticker ─── */}
        <SpiritTicker gateStats={gateStats} />

        {/* #3 — full-width banner for newly-arrived flagged events */}
        {toastEv && <JustArrivedToast ev={toastEv} onClose={() => setToastEv(null)} />}

        {/* #8 — idle screensaver after 10 min of no events */}
        {screensaverOn && <Screensaver clock={clock} profile={profile} />}

        {err && (
          <div className="tv-err">
            <span>⚠</span> Reconnecting to server… ({err})
          </div>
        )}
      </div>

      <style jsx global>{`
        :root {
          --binus-maroon: #8B1538;
          --binus-maroon-deep: #5D0E27;
          --binus-gold: #FCBF11;
          --binus-gold-soft: #FFD86A;
          --binus-white: #FFFFFF;
          --ink: #1a0710;
        }
        html, body, #__next { margin: 0; padding: 0; height: 100%; background: #0d0509; overflow: hidden; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--ink); }
        code { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }

        .tv-root {
          height: 100vh;
          width: 100vw;
          display: grid;
          grid-template-rows: clamp(72px, 8vh, 100px) 1fr clamp(48px, 6vh, 68px);
          background:
            radial-gradient(ellipse at top right, rgba(252,191,17,0.12), transparent 60%),
            radial-gradient(ellipse at bottom left, rgba(139,21,56,0.40), transparent 60%),
            linear-gradient(135deg, #2a0a18 0%, #5D0E27 50%, #2a0a18 100%);
          padding: clamp(12px, 2vh, 28px) clamp(16px, 2.5vw, 36px) 0;
          gap: clamp(10px, 1.5vh, 18px);
          overflow: hidden;
        }

        /* Header */
        .tv-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(252,191,17,0.18);
          border-radius: 16px;
          padding: 12px 24px;
          backdrop-filter: blur(8px);
          color: var(--binus-white);
        }
        .tv-header-left { display: flex; align-items: center; gap: clamp(10px, 1.2vw, 18px); min-width: 0; flex: 1; }
        .tv-logo {
          width: clamp(40px, 5vh, 64px); height: clamp(40px, 5vh, 64px);
          background: white; border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          padding: 4px; box-shadow: 0 4px 24px rgba(252,191,17,0.25);
          flex-shrink: 0;
        }
        .tv-logo img { width: 100%; height: 100%; object-fit: contain; border-radius: 8px; }
        .tv-brand-block { min-width: 0; overflow: hidden; }
        .tv-brand { font-size: clamp(15px, 1.6vw, 22px); font-weight: 800; letter-spacing: 0.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tv-sub { font-size: clamp(9px, 0.9vw, 13px); opacity: 0.7; letter-spacing: 0.6px; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tv-header-right { display: flex; align-items: center; gap: clamp(12px, 1.6vw, 24px); flex-shrink: 0; }
        .tv-stat { text-align: right; line-height: 1; }
        .tv-stat span { font-size: clamp(18px, 2vw, 28px); font-weight: 800; color: var(--binus-gold); }
        .tv-stat label { display: block; font-size: clamp(8px, 0.7vw, 10px); text-transform: uppercase; letter-spacing: 1.2px; opacity: 0.55; margin-top: 4px; white-space: nowrap; }
        .tv-gate-timer {
          text-align: right;
          line-height: 1.05;
          padding: 8px 12px;
          border-radius: 10px;
          border: 1px solid rgba(252,191,17,0.25);
          background: rgba(0,0,0,0.22);
          min-width: 185px;
        }
        .tv-gate-timer .gtt-label {
          font-size: clamp(8px, 0.75vw, 10px);
          text-transform: uppercase;
          letter-spacing: 1.1px;
          opacity: 0.78;
          white-space: nowrap;
        }
        .tv-gate-timer .gtt-value {
          margin-top: 4px;
          font-size: clamp(15px, 1.45vw, 22px);
          font-weight: 800;
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          color: #FCBF11;
          white-space: nowrap;
        }
        .tv-gate-timer.open {
          border-color: rgba(34,197,94,0.4);
          background: rgba(21,128,61,0.22);
        }
        .tv-gate-timer.open .gtt-value { color: #86EFAC; }
        .tv-gate-timer.closed {
          border-color: rgba(252,191,17,0.45);
          background: rgba(252,191,17,0.12);
        }
        .tv-gate-timer.neutral {
          border-color: rgba(148,163,184,0.32);
          background: rgba(30,41,59,0.35);
        }
        .tv-gate-timer.neutral .gtt-value {
          font-family: inherit;
          color: #e2e8f0;
          font-size: clamp(12px, 1.1vw, 14px);
          font-weight: 700;
        }
        .tv-clock { text-align: right; line-height: 1.05; padding-left: clamp(10px, 1.2vw, 18px); border-left: 1px solid rgba(252,191,17,0.25); }
        .tv-time { font-size: clamp(22px, 2.6vw, 36px); font-weight: 700; font-variant-numeric: tabular-nums; color: white; }
        .tv-date { font-size: clamp(9px, 0.9vw, 12px); opacity: 0.65; text-transform: uppercase; letter-spacing: 1px; white-space: nowrap; }
        @media (max-width: 900px) { .tv-stat, .tv-gate-timer { display: none; } }
        .tv-dot {
          width: 14px; height: 14px; border-radius: 50%;
          background: #22C55E; box-shadow: 0 0 16px #22C55E;
          animation: pulse 1.6s ease-in-out infinite;
        }
        .tv-dot.off { background: #EF4444; box-shadow: 0 0 16px #EF4444; }

        /* Main grid */
        .tv-main {
          display: grid;
          grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
          gap: clamp(10px, 1.2vw, 18px);
          min-height: 0;
          min-width: 0;
        }
        .tv-main.no-queue { grid-template-columns: minmax(0, 1fr); }
        @media (max-width: 1100px) {
          .tv-main { grid-template-columns: minmax(0, 1fr); }
          .tv-queue { display: none; }
        }

        /* Card wall (5 simultaneous pickup cards) */
        .tv-wall {
          background: rgba(255,255,255,0.96);
          border-radius: 24px;
          box-shadow: 0 24px 80px rgba(0,0,0,0.45);
          padding: 18px;
          overflow: hidden;
          position: relative;
        }
        .wall-grid {
          display: grid;
          gap: 14px;
          height: 100%;
        }
        /* Adaptive layout: more cards = denser grid. Featured (newest) is bigger. */
        .wall-grid.count-1 { grid-template-columns: 1fr; grid-template-rows: 1fr; }
        .wall-grid.count-2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
        .wall-grid.count-3 {
          grid-template-columns: 1.4fr 1fr;
          grid-template-rows: 1fr 1fr;
        }
        .wall-grid.count-3 > :nth-child(1) { grid-row: span 2; }
        /* Featured big card on the left, 4 supporting cards in a 2x2 grid on the right. */
        .wall-grid.count-4 {
          grid-template-columns: 1.4fr 1fr 1fr;
          grid-template-rows: 1fr 1fr;
        }
        .wall-grid.count-4 > :nth-child(1) { grid-row: span 2; }
        .wall-grid.count-5 {
          grid-template-columns: 1.3fr 1fr 1fr;
          grid-template-rows: 1fr 1fr;
        }
        .wall-grid.count-5 > :nth-child(1) { grid-row: span 2; }
        .wall-grid.count-6 {
          grid-template-columns: 1fr 1fr 1fr;
          grid-template-rows: 1fr 1fr;
        }
        .wall-grid.count-7,
        .wall-grid.count-8 {
          grid-template-columns: 1.3fr 1fr 1fr 1fr;
          grid-template-rows: 1fr 1fr;
        }
        .wall-grid.count-7 > :nth-child(1),
        .wall-grid.count-8 > :nth-child(1) { grid-row: span 2; }

        .pcard {
          background: #fffaf2;
          border-radius: 18px;
          overflow: hidden;
          display: flex; flex-direction: column;
          border: 2px solid #f1e7d7;
          position: relative;
          min-height: 0; min-width: 0;
          animation: cardIn 0.35s ease-out;
          container-type: inline-size;
        }
        .pcard.featured { border-width: 3px; box-shadow: 0 12px 40px rgba(139,21,56,0.18); }
        .pcard .pc-band {
          padding: 10px 16px;
          display: flex; align-items: center; gap: 10px;
          color: white; font-weight: 800; letter-spacing: 1.2px;
          font-size: 13px;
        }
        .pcard.featured .pc-band { font-size: 16px; padding: 12px 20px; }
        .pc-band.success { background: linear-gradient(90deg, #15803d, #22c55e); }
        .pc-band.warn    { background: linear-gradient(90deg, #b45309, #fbbf24); color: #2a1500; }
        .pc-band.danger  { background: linear-gradient(90deg, #991b1b, #ef4444); }
        .pc-band .pcb-icon { font-size: 18px; }
        .pc-band .pcb-time { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.9; font-size: 12px; }
        .pcard.featured .pc-band .pcb-time { font-size: 14px; }

        .pc-body {
          flex: 1;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: clamp(8px, 2cqw, 16px);
          padding: clamp(8px, 2cqw, 16px);
          min-height: 0; min-width: 0;
        }
        .pcard.featured .pc-body {
          gap: clamp(12px, 2cqw, 22px);
          padding: clamp(14px, 2cqw, 24px);
          grid-template-columns: 1fr;
          grid-template-rows: auto 1fr auto;
        }
        .pc-top { display: contents; }
        .pcard.featured .pc-top {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: clamp(14px, 2.5cqw, 24px);
          align-items: start;
        }
        .pc-children-block {
          display: flex; flex-direction: column;
          min-width: 0; min-height: 0;
          background: linear-gradient(180deg, rgba(252,191,17,0.08), rgba(252,191,17,0));
          border-top: 1px dashed rgba(139,21,56,0.18);
          padding-top: clamp(10px, 1.5cqw, 16px);
          margin-top: clamp(4px, 1cqw, 10px);
        }
        .pc-students-grid {
          display: grid;
          gap: clamp(14px, 2.2cqw, 20px);
          align-content: start;
        }
        /* Count-aware layouts so the children section always feels intentional,
           regardless of how many kids the chaperone is picking up. */
        .pc-students-grid.kids-1 {
          grid-template-columns: minmax(0, 1fr);
          justify-items: center;
        }
        .pc-students-grid.kids-1 .pc-student-tile {
          max-width: clamp(420px, 60cqw, 640px);
          padding: clamp(20px, 2.4cqw, 28px) clamp(28px, 3cqw, 36px);
        }
        .pc-students-grid.kids-1 .pc-tile-photo,
        .pc-students-grid.kids-1 .pc-tile-fb {
          width: clamp(110px, 12cqw, 160px);
          height: clamp(110px, 12cqw, 160px);
        }
        .pc-students-grid.kids-1 .pc-tile-name {
          font-size: clamp(24px, 3cqw, 34px);
        }
        .pc-students-grid.kids-2 {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .pc-students-grid.kids-3 {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .pc-students-grid.kids-4 {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        /* 5 or more — let auto-fill take over for any wider chaperone */
        .pc-students-grid.kids-many {
          grid-template-columns: repeat(auto-fill, minmax(clamp(240px, 28cqw, 340px), 1fr));
        }
        @container (max-width: 600px) {
          .pc-students-grid.kids-3,
          .pc-students-grid.kids-4 {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .pc-students-grid.kids-2 {
            grid-template-columns: minmax(0, 1fr);
          }
        }
        .pc-student-tile {
          position: relative;
          display: flex; align-items: center;
          gap: clamp(14px, 1.8cqw, 22px);
          background: linear-gradient(160deg, #ffffff 0%, #fff7ea 100%);
          border: 2px solid var(--binus-gold-soft);
          border-radius: 22px;
          padding: clamp(14px, 1.8cqw, 20px) clamp(20px, 2.4cqw, 28px) clamp(14px, 1.8cqw, 20px) clamp(14px, 1.8cqw, 18px);
          min-width: 0;
          box-shadow: 0 6px 18px rgba(139,21,56,0.12);
          overflow: hidden;
        }
        .pc-student-tile::before {
          content: "";
          position: absolute; inset: 0 auto 0 0;
          width: 6px; background: #22C55E;
        }
        .pc-tile-photo, .pc-tile-fb {
          width: clamp(80px, 9cqw, 120px);
          height: clamp(80px, 9cqw, 120px);
          border-radius: 50%;
          object-fit: cover;
          background: #fde68a;
          flex-shrink: 0;
          border: 4px solid white;
          box-shadow: 0 4px 14px rgba(139,21,56,0.25);
          display: flex; align-items: center; justify-content: center;
          color: var(--binus-maroon); font-weight: 800;
          font-size: clamp(28px, 3.6cqw, 40px);
        }
        .pc-tile-info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; }
        .pc-tile-name {
          font-size: clamp(20px, 2.6cqw, 28px);
          font-weight: 800; color: var(--ink); line-height: 1.15;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pc-tile-class {
          font-size: clamp(13px, 1.5cqw, 16px);
          color: #64748b;
          letter-spacing: 1.4px; text-transform: uppercase; font-weight: 700;
        }
        .pc-tile-check {
          display: inline-flex; align-items: center; gap: 7px;
          margin-top: 4px;
          background: rgba(34,197,94,0.14);
          border: 1.5px solid rgba(34,197,94,0.55);
          color: #15803d;
          font-size: clamp(11px, 1.25cqw, 13px);
          font-weight: 800; letter-spacing: 0.9px; text-transform: uppercase;
          padding: 4px 12px 4px 5px;
          border-radius: 999px;
          width: fit-content;
        }
        .pc-tile-check .pc-tile-check-ico {
          width: clamp(18px, 2cqw, 22px); height: clamp(18px, 2cqw, 22px);
          background: #22C55E; color: white; border-radius: 50%;
          display: inline-flex; align-items: center; justify-content: center;
          font-size: clamp(11px, 1.3cqw, 14px); font-weight: 900;
          box-shadow: 0 0 0 2px rgba(34,197,94,0.25);
        }
        .pc-tile-more {
          display: flex; align-items: center; justify-content: center;
          background: #fef3c7; color: var(--binus-maroon-deep);
          font-weight: 800; font-size: clamp(18px, 2cqw, 24px);
          border-radius: 22px;
          padding: clamp(16px, 2cqw, 22px);
          border: 2px dashed var(--binus-gold-soft);
          min-height: clamp(110px, 11cqw, 150px);
        }

        /* Big animated success seal under children */
        .pc-success-seal {
          margin-top: clamp(14px, 2cqw, 22px);
          display: flex; flex-direction: column; align-items: center;
          gap: clamp(6px, 0.8cqw, 12px);
          padding: clamp(10px, 1.4cqw, 18px);
        }
        .pc-seal-ring {
          position: relative;
          width: clamp(70px, 9cqw, 110px);
          height: clamp(70px, 9cqw, 110px);
          border-radius: 50%;
          background: radial-gradient(circle at 30% 30%, #4ade80, #16a34a 70%);
          display: flex; align-items: center; justify-content: center;
          color: white; font-size: clamp(36px, 4.5cqw, 56px); font-weight: 900;
          box-shadow:
            0 0 0 6px rgba(34,197,94,0.18),
            0 0 0 14px rgba(34,197,94,0.08),
            0 12px 30px rgba(22,163,74,0.35);
          animation: sealPop 0.55s cubic-bezier(.18,.89,.32,1.4) both, sealPulse 2.4s ease-in-out 0.6s infinite;
        }
        .pc-seal-ring::after {
          content: "";
          position: absolute; inset: -6px;
          border-radius: 50%;
          border: 3px solid rgba(34,197,94,0.4);
          animation: sealRipple 2.4s ease-out 0.6s infinite;
        }
        .pc-seal-text {
          font-size: clamp(13px, 1.6cqw, 18px);
          font-weight: 800; letter-spacing: 2px; text-transform: uppercase;
          color: #15803d;
        }
        .pc-seal-sub {
          font-size: clamp(11px, 1.2cqw, 14px);
          color: #64748b; letter-spacing: 0.6px;
        }
        @keyframes sealPop {
          0%   { transform: scale(0.4); opacity: 0; }
          70%  { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1); }
        }
        @keyframes sealPulse {
          0%, 100% { box-shadow: 0 0 0 6px rgba(34,197,94,0.18), 0 0 0 14px rgba(34,197,94,0.08), 0 12px 30px rgba(22,163,74,0.35); }
          50%      { box-shadow: 0 0 0 10px rgba(34,197,94,0.22), 0 0 0 22px rgba(34,197,94,0.05), 0 12px 36px rgba(22,163,74,0.45); }
        }
        @keyframes sealRipple {
          0%   { transform: scale(1);   opacity: 0.55; }
          100% { transform: scale(1.55); opacity: 0; }
        }

        .pc-photo {
          width: clamp(70px, 22cqw, 130px); height: clamp(70px, 22cqw, 130px);
          border-radius: 14px; overflow: hidden;
          background: #f3e9d6;
          border: 4px solid var(--binus-gold);
          position: relative;
          flex-shrink: 0;
        }
        .pcard.featured .pc-photo { width: clamp(120px, 26cqw, 220px); height: clamp(120px, 26cqw, 220px); border-width: 5px; border-radius: 18px; }
        .pc-photo img { width: 100%; height: 100%; object-fit: cover; }
        .pc-photo .pc-fallback {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          font-size: 60px; color: rgba(139,21,56,0.4);
        }
        .pcard.featured .pc-photo .pc-fallback { font-size: 100px; }
        .pc-photo .pc-live {
          position: absolute; top: 6px; left: 6px;
          background: rgba(0,0,0,0.7); color: white;
          font-size: 9px; font-weight: 700; padding: 3px 8px;
          border-radius: 999px; letter-spacing: 1px;
        }

        .pc-info { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
        .pc-name {
          font-size: clamp(14px, 4cqw, 22px); font-weight: 800; line-height: 1.05;
          color: var(--binus-maroon); letter-spacing: -0.3px;
          overflow: hidden; text-overflow: ellipsis;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          word-break: break-word;
        }
        .pcard.featured .pc-name { font-size: clamp(22px, 5cqw, 38px); }
        .pc-rel {
          margin-top: 6px;
          align-self: flex-start;
          font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px;
          background: var(--binus-gold); color: var(--binus-maroon-deep);
          padding: 3px 10px; border-radius: 999px;
        }
        .pcard.featured .pc-rel { font-size: 13px; padding: 5px 14px; }
        .pc-meta { font-size: 11px; color: #64748b; margin-top: 6px; letter-spacing: 0.4px; }
        .pcard.featured .pc-meta { font-size: 13px; }

        .pc-students-label {
          font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px;
          color: #94a3b8; font-weight: 700; margin: 10px 0 6px;
        }
        .pcard.featured .pc-students-label { font-size: 11px; margin: 14px 0 8px; }
        .pc-students { display: flex; flex-wrap: wrap; gap: 8px; }
        .pc-student {
          display: flex; align-items: center; gap: 10px;
          background: #fff7ea; border: 1.5px solid var(--binus-gold-soft);
          border-radius: 14px; padding: 6px 14px 6px 6px;
        }
        .pcard.featured .pc-student { gap: 14px; padding: 8px 18px 8px 8px; border-radius: 16px; }
        .pc-student-photo,
        .pc-student-fb {
          width: clamp(34px, 8cqw, 56px); height: clamp(34px, 8cqw, 56px); border-radius: 50%; object-fit: cover;
          background: #fde68a; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
          color: var(--binus-maroon); font-weight: 800; font-size: clamp(13px, 2.8cqw, 20px);
          border: 2.5px solid white;
          box-shadow: 0 2px 6px rgba(139,21,56,0.18);
        }
        .pcard.featured .pc-student-photo,
        .pcard.featured .pc-student-fb { width: clamp(50px, 9cqw, 76px); height: clamp(50px, 9cqw, 76px); font-size: clamp(18px, 3cqw, 26px); border-width: 3px; }
        .pc-student .pcs-name {
          font-size: clamp(11px, 2.6cqw, 15px); font-weight: 700; color: var(--ink); line-height: 1.15;
          max-width: clamp(80px, 22cqw, 170px);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .pcard.featured .pc-student .pcs-name { font-size: clamp(14px, 2.8cqw, 19px); max-width: clamp(140px, 22cqw, 220px); }
        .pc-student .pcs-class { font-size: 11px; color: #64748b; letter-spacing: 0.8px; text-transform: uppercase; font-weight: 700; }
        .pcard.featured .pc-student .pcs-class { font-size: 13px; }
        .pc-students .pc-more {
          background: #fef3c7; color: var(--binus-maroon-deep);
          font-weight: 800; font-size: 12px;
          padding: 4px 10px; border-radius: 10px;
          display: flex; align-items: center;
        }
        .pc-no-students { color: #94a3b8; font-size: 11px; font-style: italic; }

        .pc-footer {
          margin-top: auto;
          font-size: 10px; color: #94a3b8;
          padding-top: 8px; border-top: 1px solid #f1e7d7;
          display: flex; justify-content: space-between; gap: 8px;
          overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
        }
        .pcard.featured .pc-footer { font-size: 12px; padding-top: 12px; }

        /* Idle splash (no events) */
        .tv-idle { display:flex;align-items:center;justify-content:center;flex-direction:column;flex:1;text-align:center;color:#5D0E27; }
        .tv-idle h2 { font-size: 64px; font-weight: 800; margin: 12px 0 8px; }
        .tv-idle p { font-size: 18px; color: #94a3b8; margin: 0; }
        .tv-idle .ico { font-size: 96px; opacity: 0.55; }

        /* Gate-closed splash */
        .tv-gate-closed {
          flex: 1;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          text-align: center;
          gap: clamp(16px, 2.4vh, 28px);
          padding: clamp(24px, 4vw, 64px);
          background:
            radial-gradient(circle at 50% 20%, rgba(252,191,17,0.10), transparent 60%),
            linear-gradient(180deg, rgba(93,14,39,0.55), rgba(20,8,16,0.85));
          border: 1px solid rgba(252,191,17,0.18);
          border-radius: 28px;
          color: #fef3c7;
          animation: gcFadeIn 0.6s ease-out both;
        }
        .tv-gate-closed .gc-badge {
          display: inline-flex; align-items: center; gap: 12px;
          padding: 10px 22px;
          background: rgba(252,191,17,0.14);
          border: 1px solid rgba(252,191,17,0.45);
          border-radius: 999px;
          color: #FCBF11;
          font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
          font-size: clamp(14px, 1.4vw, 20px);
          animation: gcPulse 2.6s ease-in-out infinite;
        }
        .tv-gate-closed .gc-badge i { font-size: 1.3em; }
        .tv-gate-closed .gc-title {
          font-size: clamp(36px, 5.6vw, 76px);
          font-weight: 800;
          line-height: 1.05;
          margin: 0;
          color: #fff;
          text-shadow: 0 4px 18px rgba(0,0,0,0.5);
        }
        .tv-gate-closed .gc-sub {
          margin: 0; max-width: 720px;
          font-size: clamp(15px, 1.4vw, 22px);
          color: #cbd5e1; line-height: 1.45;
        }
        .tv-gate-closed .gc-window {
          display: inline-flex; align-items: stretch;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(252,191,17,0.28);
          border-radius: 18px;
          padding: clamp(14px, 1.6vw, 22px) clamp(20px, 2.6vw, 36px);
          gap: clamp(20px, 2.6vw, 40px);
          margin-top: 4px;
        }
        .tv-gate-closed .gc-row { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .tv-gate-closed .gc-row label {
          font-size: clamp(11px, 0.9vw, 14px);
          letter-spacing: 0.18em; text-transform: uppercase;
          color: #94a3b8; font-weight: 600;
        }
        .tv-gate-closed .gc-time {
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          font-size: clamp(28px, 3.6vw, 56px);
          font-weight: 700;
          color: #FCBF11;
          line-height: 1;
        }
        .tv-gate-closed .gc-divider {
          width: 1px; background: rgba(252,191,17,0.25);
        }
        .tv-gate-closed .gc-countdown {
          margin: 0;
          font-size: clamp(14px, 1.2vw, 18px);
          color: #fef3c7;
          opacity: 0.85;
        }
        .tv-gate-closed .gc-countdown b {
          color: #FCBF11; font-weight: 700;
          font-family: 'JetBrains Mono', ui-monospace, monospace;
        }
        @keyframes gcFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes gcPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(252,191,17,0.35); }
          50%      { box-shadow: 0 0 0 12px rgba(252,191,17,0); }
        }

        /* Queue */
        .tv-queue {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(252,191,17,0.18);
          border-radius: 24px; padding: 18px;
          display: flex; flex-direction: column; min-height: 0;
        }
        .tv-queue-title {
          display: flex; align-items: baseline; justify-content: space-between;
          color: var(--binus-gold); font-weight: 800;
          font-size: 18px; letter-spacing: 2px; text-transform: uppercase;
          padding: 0 6px 12px; border-bottom: 1px solid rgba(252,191,17,0.18);
        }
        .tv-queue-title small { font-size: 11px; opacity: 0.55; letter-spacing: 1.2px; }
        .tv-queue-list { flex: 1; overflow: hidden; padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
        .tv-empty { text-align: center; padding: 40px 0; color: rgba(255,255,255,0.4); font-size: 14px; }

        .qr {
          display: grid; grid-template-columns: 56px 1fr auto;
          gap: 12px; align-items: center;
          background: rgba(255,255,255,0.05); border-radius: 14px;
          padding: 10px 14px;
          border-left: 4px solid #475569;
        }
        .qr.qg { border-left-color: #22C55E; }
        .qr.qy { border-left-color: #FCBF11; }
        .qr.qd { border-left-color: #EF4444; }
        .qr-photo { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; background: #2a0e1d; }
        .qr-meta { color: white; min-width: 0; }
        .qr-name { font-weight: 700; font-size: 16px; line-height: 1.1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .qr-sub { font-size: 11px; opacity: 0.65; margin-top: 3px; letter-spacing: 0.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .qr-time { color: var(--binus-gold-soft); font-size: 13px; font-variant-numeric: tabular-nums; font-weight: 700; }
        .qr-students {
          grid-column: 1 / -1;
          display: flex; gap: 4px; padding-top: 6px; margin-top: 4px;
          border-top: 1px dashed rgba(252,191,17,0.18);
        }
        .qr-stud-photo,
        .qr-stud-fb {
          width: 30px; height: 30px; border-radius: 50%; object-fit: cover;
          background: #5D0E27; border: 2px solid var(--binus-gold);
          display: flex; align-items: center; justify-content: center;
          color: var(--binus-gold); font-weight: 800; font-size: 12px;
          flex-shrink: 0;
        }
        .qr-stud-more {
          height: 30px; min-width: 30px; padding: 0 8px;
          border-radius: 999px; background: rgba(252,191,17,0.18);
          color: var(--binus-gold); font-weight: 800; font-size: 11px;
          display: flex; align-items: center; justify-content: center;
        }

        /* Spirit ticker */
        .ticker {
          background: linear-gradient(90deg, var(--binus-maroon-deep), var(--binus-maroon));
          border-top: 2px solid var(--binus-gold);
          height: 64px;
          margin: 0 -36px;
          display: flex; align-items: center;
          overflow: hidden;
          position: relative;
        }
        .ticker-label {
          flex-shrink: 0;
          background: var(--binus-gold);
          color: var(--binus-maroon-deep);
          font-weight: 800; letter-spacing: 3px; font-size: 14px;
          padding: 12px 24px; height: 100%;
          display: flex; align-items: center; gap: 8px;
          clip-path: polygon(0 0, 100% 0, calc(100% - 18px) 100%, 0 100%);
          padding-right: 36px;
        }
        .ticker-track {
          flex: 1; overflow: hidden; height: 100%;
          mask-image: linear-gradient(90deg, transparent 0%, black 4%, black 96%, transparent 100%);
        }
        .ticker-scroll {
          display: flex; width: max-content; height: 100%;
          align-items: center;
          animation: ticker 36s linear infinite;
        }
        .ticker-item {
          display: flex; align-items: baseline; gap: 12px;
          padding: 0 32px; white-space: nowrap; flex-shrink: 0;
          color: white;
        }
        .ti-letter { font-size: 28px; font-weight: 900; color: var(--binus-gold); }
        .ti-word { font-size: 22px; font-weight: 700; }
        .ti-desc { font-size: 16px; opacity: 0.65; font-style: italic; }
        .ti-dot { color: var(--binus-gold); opacity: 0.4; font-size: 22px; }

        @keyframes ticker {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.6; transform: scale(0.9); }
        }
        @keyframes cardIn {
          from { opacity: 0; transform: translateY(10px) scale(0.98); }
          to   { opacity: 1; transform: none; }
        }

        .tv-err {
          position: fixed; bottom: 78px; left: 50%; transform: translateX(-50%);
          background: rgba(239,68,68,0.92); color: white;
          padding: 8px 18px; border-radius: 999px;
          font-size: 13px; font-weight: 600;
          display: flex; align-items: center; gap: 8px;
          box-shadow: 0 8px 24px rgba(239,68,68,0.4);
        }

        /* ─── #2 Hold-timer ring around featured photo ──────────────── */
        .pc-photo-wrap {
          position: relative;
          display: inline-block;
          flex-shrink: 0;
          padding: 10px;
          margin: -10px;
        }
        .pc-hold-ring {
          position: absolute; inset: 0;
          width: 100%; height: 100%;
          transform: rotate(-90deg);
          pointer-events: none;
          z-index: 2;
        }
        .pc-ring-bg {
          fill: none;
          stroke: rgba(139,21,56,0.08);
          stroke-width: 5;
        }
        .pc-ring-fg {
          fill: none;
          stroke-width: 5;
          stroke-linecap: round;
          transition: stroke-dashoffset 250ms linear, stroke 300ms ease;
          filter: drop-shadow(0 0 6px rgba(0,0,0,0.18));
        }
        .pcb-hold {
          margin-left: 10px;
          background: rgba(0,0,0,0.18);
          padding: 3px 10px; border-radius: 999px;
          font-size: 11px; letter-spacing: 0.8px;
          font-variant-numeric: tabular-nums;
        }
        .pcard.featured .pcb-hold { font-size: 13px; padding: 4px 12px; }
        .pcb-override {
          margin-left: 8px;
          background: rgba(255,255,255,0.95);
          color: #15803d;
          padding: 3px 10px; border-radius: 999px;
          font-size: 11px; font-weight: 800; letter-spacing: 0.8px;
          border: 1px solid rgba(34,197,94,0.4);
        }
        .pcard.featured .pcb-override { font-size: 13px; padding: 4px 12px; }

        /* ─── #16 Officer override code bar ─────────────────────────── */
        .pc-override-bar {
          display: flex; align-items: center;
          gap: clamp(10px, 1.4cqw, 18px);
          padding: clamp(8px, 1cqw, 14px) clamp(12px, 1.6cqw, 22px);
          background: rgba(0,0,0,0.06);
          border-bottom: 1px dashed rgba(0,0,0,0.12);
        }
        .pc-override-bar.tone-warn   { background: rgba(251,191,36,0.10); }
        .pc-override-bar.tone-danger { background: rgba(239,68,68,0.08); }
        .oc-label {
          font-size: clamp(10px, 1.05cqw, 13px);
          letter-spacing: 1.5px; text-transform: uppercase;
          font-weight: 700; opacity: 0.65;
        }
        .oc-code {
          font-size: clamp(22px, 2.6cqw, 36px);
          font-weight: 900; font-variant-numeric: tabular-nums;
          letter-spacing: clamp(4px, 0.6cqw, 8px);
          color: var(--binus-maroon-deep);
          background: white;
          padding: 4px 14px;
          border-radius: 10px;
          border: 1.5px solid rgba(139,21,56,0.18);
          box-shadow: 0 2px 8px rgba(139,21,56,0.10);
        }
        .oc-hint {
          margin-left: auto;
          font-size: clamp(10px, 1cqw, 12px);
          opacity: 0.55;
          font-style: italic;
        }

        /* ─── #3 Just-arrived flagged toast ─────────────────────────── */
        .tv-toast {
          position: fixed;
          top: 18px; left: 50%;
          transform: translateX(-50%);
          width: min(900px, 92vw);
          z-index: 50;
          display: flex; align-items: center; gap: 18px;
          padding: 16px 22px;
          border-radius: 18px;
          box-shadow: 0 18px 60px rgba(0,0,0,0.45);
          color: white;
          cursor: pointer;
          animation: toastIn 0.45s cubic-bezier(.18,.89,.32,1.4);
        }
        .tv-toast.red    { background: linear-gradient(90deg, #991b1b, #ef4444); }
        .tv-toast.yellow { background: linear-gradient(90deg, #b45309, #fbbf24); color: #2a1500; }
        .tt-icon {
          width: 56px; height: 56px;
          border-radius: 50%;
          background: rgba(255,255,255,0.18);
          display: flex; align-items: center; justify-content: center;
          font-size: 32px; font-weight: 900;
          flex-shrink: 0;
        }
        .tv-toast.yellow .tt-icon { background: rgba(0,0,0,0.12); }
        .tt-text { flex: 1; min-width: 0; }
        .tt-head {
          font-size: 22px; font-weight: 900; letter-spacing: 1.2px;
          text-transform: uppercase;
        }
        .tt-sub {
          margin-top: 4px;
          font-size: 14px; opacity: 0.9; font-weight: 500;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .tt-close {
          width: 36px; height: 36px;
          border-radius: 50%;
          background: rgba(255,255,255,0.18);
          display: flex; align-items: center; justify-content: center;
          font-size: 22px; font-weight: 800;
          flex-shrink: 0;
        }
        .tv-toast.yellow .tt-close { background: rgba(0,0,0,0.12); }
        @keyframes toastIn {
          from { transform: translate(-50%, -120%); opacity: 0; }
          to   { transform: translate(-50%, 0);     opacity: 1; }
        }

        /* ─── #7 Per-gate stats inside the spirit ticker ────────────── */
        .ticker-stats {
          display: flex; align-items: center;
          gap: clamp(8px, 1.2vw, 18px);
          padding: 0 clamp(10px, 1.4vw, 18px);
          border-right: 1px solid rgba(252,191,17,0.25);
          color: white;
        }
        .ts-gate {
          display: flex; align-items: center; gap: 8px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(252,191,17,0.18);
          border-radius: 999px;
          padding: 4px 12px;
          font-size: clamp(10px, 0.9vw, 13px);
          white-space: nowrap;
        }
        .ts-gate-name {
          font-weight: 700; opacity: 0.85; max-width: 14ch;
          overflow: hidden; text-overflow: ellipsis;
        }
        .ts-gate-counts { display: flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; font-weight: 800; }
        .ts-ok   { color: #4ade80; }
        .ts-warn { color: #fbbf24; }
        .ts-deny { color: #f87171; }
        @media (max-width: 1100px) {
          .ticker-stats { display: none; }
        }

        /* ─── #8 Idle screensaver overlay ───────────────────────────── */
        .tv-screensaver {
          position: fixed; inset: 0;
          z-index: 100;
          background: #1a0710;
          color: white;
          display: flex; align-items: center; justify-content: center;
          animation: ssFade 0.8s ease-out;
        }
        .ss-bg {
          position: absolute; inset: 0;
          background:
            radial-gradient(ellipse at 30% 40%, rgba(252,191,17,0.16), transparent 55%),
            radial-gradient(ellipse at 70% 70%, rgba(139,21,56,0.7), transparent 55%),
            linear-gradient(135deg, #2a0a18 0%, #5D0E27 60%, #2a0a18 100%);
        }
        .ss-content {
          position: relative;
          text-align: center;
          display: flex; flex-direction: column; align-items: center;
          gap: 10px;
          animation: ssDrift 30s ease-in-out infinite alternate;
        }
        .ss-logo { width: 110px; height: 110px; border-radius: 22px; background: white; padding: 8px; box-shadow: 0 8px 40px rgba(252,191,17,0.35); }
        .ss-title { font-size: clamp(28px, 3.4vw, 44px); font-weight: 800; margin-top: 14px; letter-spacing: 0.5px; }
        .ss-sub { font-size: clamp(14px, 1.3vw, 18px); opacity: 0.7; letter-spacing: 1.4px; text-transform: uppercase; }
        .ss-clock {
          font-size: clamp(80px, 12vw, 180px);
          font-weight: 800; font-variant-numeric: tabular-nums;
          line-height: 1; margin-top: 24px;
          color: var(--binus-gold);
          text-shadow: 0 8px 40px rgba(252,191,17,0.35);
        }
        .ss-date { font-size: clamp(18px, 1.6vw, 24px); opacity: 0.85; margin-top: 4px; }
        .ss-gate { margin-top: 18px; font-size: clamp(13px, 1.1vw, 16px); padding: 6px 18px; border: 1px solid rgba(252,191,17,0.4); border-radius: 999px; opacity: 0.85; }
        .ss-hint { margin-top: 36px; font-size: 12px; opacity: 0.5; letter-spacing: 1.5px; text-transform: uppercase; }
        @keyframes ssFade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes ssDrift {
          0%   { transform: translate(-2vw, -1vh); }
          100% { transform: translate(2vw, 1vh); }
        }
      `}</style>
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────
function FullCenter({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#5D0E27', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </div>
  );
}

/**
 * First-boot screen for a TV that has no device token yet.
 *
 * Two paths:
 *   A) Type a short kiosk code (set per profile in the admin) → instant claim.
 *   B) Press "Pair this TV" → server allocates a 6-char code displayed full-screen,
 *      admin types it in the dashboard, TV polls until paired.
 */
function TvEntryScreen({ bootError, onAdopt }) {
  const [mode, setMode] = useState('idle');         // 'idle' | 'pairing'
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(bootError || null);
  const [pairing, setPairing] = useState(null);     // { deviceId, pairingCode }
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submitCode = async (e) => {
    e?.preventDefault?.();
    const cleaned = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cleaned) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/pickup/tv/claim-by-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kioskCode: cleaned, userAgent: navigator.userAgent }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'invalid code');
      onAdopt(j.deviceToken);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const startPairing = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/pickup/tv/start-pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userAgent: navigator.userAgent }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'pair start failed');
      setPairing({ deviceId: j.deviceId, pairingCode: j.pairingCode });
      setMode('pairing');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  // Poll while in pairing mode
  useEffect(() => {
    if (mode !== 'pairing' || !pairing?.deviceId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/pickup/tv/poll-pair?deviceId=${encodeURIComponent(pairing.deviceId)}`);
        const j = await r.json();
        if (cancelled) return;
        if (j.status === 'paired' && j.deviceToken) onAdopt(j.deviceToken);
        if (j.status === 'revoked') { setErr('Pairing was revoked'); setMode('idle'); }
        if (j.status === 'expired') { setErr('Pairing code expired — please try again'); setMode('idle'); setPairing(null); }
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(t); };
  }, [mode, pairing, onAdopt]);

  // ─── Pairing screen ─── big code, polling
  if (mode === 'pairing' && pairing) {
    const display = `${pairing.pairingCode.slice(0, 3)}-${pairing.pairingCode.slice(3)}`;
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #5D0E27 0%, #8B1538 100%)', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5vw' }}>
        <img src="/binus-logo.jpg" alt="BINUS" style={{ width: 90, height: 90, borderRadius: 16, background: '#fff', padding: 6, marginBottom: 32 }} />
        <h1 style={{ fontSize: '3.2rem', fontWeight: 800, margin: 0, letterSpacing: '-0.02em' }}>Pair this TV</h1>
        <p style={{ opacity: 0.75, fontSize: '1.4rem', margin: '12px 0 48px' }}>
          On the admin dashboard → <b>PickupGuard Admin → TV Kiosks → Pair a TV</b>, enter:
        </p>
        <div style={{ background: 'rgba(0,0,0,0.35)', border: '4px solid #FCBF11', borderRadius: 28, padding: '40px 80px', marginBottom: 48 }}>
          <div style={{ fontSize: '8rem', fontWeight: 900, fontFamily: 'ui-monospace, monospace', letterSpacing: '0.06em', color: '#FCBF11', lineHeight: 1 }}>{display}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: '1.1rem', opacity: 0.8 }}>
          <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#FCBF11', animation: 'pgPulse 1.4s ease-in-out infinite' }} />
          Waiting for pairing…
        </div>
        <button onClick={() => { setMode('idle'); setPairing(null); }}
          style={{ marginTop: 56, background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 10, padding: '10px 24px', fontSize: '0.95rem', cursor: 'pointer' }}>
          ← Back
        </button>
        <style jsx global>{`
          @keyframes pgPulse { 0%,100% { opacity: 0.4; transform: scale(1); } 50% { opacity: 1; transform: scale(1.3); } }
        `}</style>
      </div>
    );
  }

  // ─── Idle entry screen ─── kiosk-code input + Pair button
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #5D0E27 0%, #8B1538 100%)', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5vw' }}>
      <img src="/binus-logo.jpg" alt="BINUS" style={{ width: 90, height: 90, borderRadius: 16, background: '#fff', padding: 6, marginBottom: 28 }} />
      <h1 style={{ fontSize: '2.6rem', fontWeight: 800, margin: 0 }}>PickupGuard TV</h1>
      <p style={{ opacity: 0.75, fontSize: '1.15rem', margin: '8px 0 40px' }}>Set up this screen — type the kiosk code or pair from the dashboard.</p>

      <form onSubmit={submitCode} style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 20, padding: 28, width: 'min(560px, 90vw)', textAlign: 'center' }}>
        <label style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.15em', opacity: 0.7 }}>
          Kiosk code
        </label>
        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={8}
          autoFocus
          placeholder="e.g. PYP1"
          style={{
            display: 'block', width: '100%', marginTop: 14, padding: '20px 16px',
            fontSize: '3rem', fontFamily: 'ui-monospace, monospace',
            textAlign: 'center', letterSpacing: '0.4em',
            background: 'rgba(255,255,255,0.08)', color: '#FCBF11',
            border: '2px solid rgba(255,255,255,0.2)', borderRadius: 14, outline: 'none',
          }}
        />
        <button type="submit" disabled={busy || !code}
          style={{
            marginTop: 18, width: '100%', padding: '14px',
            background: '#FCBF11', color: '#5D0E27', fontSize: '1.1rem', fontWeight: 700,
            border: 'none', borderRadius: 12, cursor: 'pointer',
            opacity: busy || !code ? 0.5 : 1,
          }}>
          {busy ? 'Connecting…' : 'Connect →'}
        </button>
      </form>

      {err && (
        <div style={{ marginTop: 24, color: '#FFB4B4', background: 'rgba(0,0,0,0.3)', borderRadius: 10, padding: '10px 18px', fontSize: '0.95rem' }}>
          ⚠ {err}
        </div>
      )}

      <div style={{ marginTop: 36, display: 'flex', alignItems: 'center', gap: 12, opacity: 0.6 }}>
        <div style={{ height: 1, width: 60, background: '#fff' }} />
        <span style={{ fontSize: '0.9rem' }}>or</span>
        <div style={{ height: 1, width: 60, background: '#fff' }} />
      </div>

      <button onClick={startPairing} disabled={busy}
        style={{
          marginTop: 24, background: 'transparent', color: '#fff',
          border: '2px solid rgba(255,255,255,0.4)', borderRadius: 12,
          padding: '14px 32px', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
        }}>
        Pair this TV from the dashboard
      </button>
    </div>
  );
}

function PickupCard({ ev, featured, serverOffsetMs }) {
  const theme = STATE_THEME[ev.cardState] || STATE_THEME.yellow;
  const decisionLabel = DECISION_LABEL[ev.decision] || ev.decision;
  const live = (() => {
    if (!ev.recordedAt) return false;
    const eventMs = new Date(ev.recordedAt).getTime();
    const syncedNowMs = Date.now() + (serverOffsetMs || 0);
    return Number.isFinite(eventMs) ? ((syncedNowMs - eventMs) / 1000) < 25 : false;
  })();
  const studentLimit = featured ? 12 : 3;
  const studentSrc = ev.capturePath || ev.chaperone?.photoUrl;
  const students = ev.students || [];

  // ─── #2 Hold-timer ring (featured only) ─────────────────────────────
  // Counts down ev.holdSeconds from when the event was recorded.
  // SVG circle stroke-dashoffset animates around the photo.
  const holdSec = Math.max(15, ev.holdSeconds || 60);
  const [holdProgress, setHoldProgress] = useState(0); // 0 → 1 over holdSec
  useEffect(() => {
    if (!featured) return;
    const start = ev.recordedAt ? new Date(ev.recordedAt).getTime() : (Date.now() + (serverOffsetMs || 0));
    const tick = () => {
      const elapsed = ((Date.now() + (serverOffsetMs || 0)) - start) / 1000;
      setHoldProgress(Math.min(1, Math.max(0, elapsed / holdSec)));
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [featured, ev.recordedAt, holdSec, ev.id, serverOffsetMs]);
  const holdRemaining = Math.max(0, Math.ceil(holdSec * (1 - holdProgress)));
  const ringColor = ev.cardState === 'red' ? '#EF4444'
                  : ev.cardState === 'yellow' ? '#FCBF11'
                  : '#22C55E';

  return (
    <div className={`pcard ${featured ? 'featured' : ''}`}>
      <div className={`pc-band ${theme.tone}`}>
        <span className="pcb-icon">{theme.icon}</span>
        <span>{theme.label}</span>
        <span className="pcb-time">{fmtTime(ev.scannedAt)}</span>
        {featured && holdRemaining > 0 && (
          <span className="pcb-hold">HOLD {holdRemaining}s</span>
        )}
        {ev.officerOverride && (
          <span className="pcb-override" title={ev.officerOverride.note || ''}>OFFICER OK</span>
        )}
      </div>
      {/* #16 — show 6-digit override code on featured flagged cards so the
          gate officer can punch it into /pickup/officer to release them. */}
      {featured && ev.overrideCode && !ev.officerOverride && (
        <div className={`pc-override-bar tone-${theme.tone}`}>
          <div className="oc-label">Officer override</div>
          <div className="oc-code">{ev.overrideCode}</div>
          <div className="oc-hint">Type at /pickup/officer</div>
        </div>
      )}
      <div className="pc-body">
        <div className="pc-top">
          <div className="pc-photo-wrap">
            <div className="pc-photo" style={{ borderColor: theme.ring }}>
              {studentSrc
                ? /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={studentSrc} alt={ev.chaperone?.name || ''} />
                : <div className="pc-fallback">👤</div>}
              {live && <div className="pc-live">● LIVE</div>}
            </div>
            {featured && (
              <svg className="pc-hold-ring" viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="56" className="pc-ring-bg" />
                <circle
                  cx="60" cy="60" r="56"
                  className="pc-ring-fg"
                  stroke={ringColor}
                  style={{
                    strokeDasharray: 2 * Math.PI * 56,
                    strokeDashoffset: 2 * Math.PI * 56 * holdProgress,
                  }}
                />
              </svg>
            )}
          </div>
          <div className="pc-info">
            <div className="pc-name">{ev.chaperone?.name || 'Unknown'}</div>
            <div><span className="pc-rel">{ev.chaperone?.relation || 'Pickup'}</span></div>
            <div className="pc-meta">{decisionLabel}</div>
            {!featured && (
              <>
                <div className="pc-students-label">Children ({students.length})</div>
                <div className="pc-students">
                  {students.slice(0, studentLimit).map((s) => (
                    <div key={s.id} className="pc-student">
                      {s.photoUrl
                        ? /* eslint-disable-next-line @next/next/no-img-element */
                          <img className="pc-student-photo" src={s.photoUrl} alt={s.name} />
                        : <div className="pc-student-fb">{(s.name || '?').charAt(0)}</div>}
                      <div>
                        <div className="pcs-name">{s.name}</div>
                        <div className="pcs-class">{s.homeroom || '—'}</div>
                      </div>
                    </div>
                  ))}
                  {students.length === 0 && (
                    <div className="pc-no-students">No authorised students</div>
                  )}
                  {students.length > studentLimit && (
                    <div className="pc-more">+{students.length - studentLimit}</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {featured && (
          <div className="pc-children-block">
            <div className="pc-students-label">
              Children ({students.length})
            </div>
            {students.length === 0 ? (
              <div className="pc-no-students">No authorised students</div>
            ) : (
              <div className={`pc-students-grid kids-${Math.min(students.slice(0, studentLimit).length, 5)}${students.slice(0, studentLimit).length >= 5 ? ' kids-many' : ''}`}>
                {students.slice(0, studentLimit).map((s) => (
                  <div key={s.id} className="pc-student-tile">
                    {s.photoUrl
                      ? /* eslint-disable-next-line @next/next/no-img-element */
                        <img className="pc-tile-photo" src={s.photoUrl} alt={s.name} />
                      : <div className="pc-tile-fb">{(s.name || '?').charAt(0)}</div>}
                    <div className="pc-tile-info">
                      <div className="pc-tile-name">{s.name}</div>
                      <div className="pc-tile-class">{s.homeroom || '—'}</div>
                      <div className="pc-tile-check">
                        <span className="pc-tile-check-ico">✓</span>
                        Verified
                      </div>
                    </div>
                  </div>
                ))}
                {students.length > studentLimit && (
                  <div className="pc-tile-more">+{students.length - studentLimit}</div>
                )}
              </div>
            )}
            {students.length > 0 && ev.cardState === 'green' && (
              <div className="pc-success-seal">
                <div className="pc-seal-ring" key={ev.id}>✓</div>
                <div className="pc-seal-text">Cleared for pickup</div>
                <div className="pc-seal-sub">All children verified · release authorised</div>
              </div>
            )}
          </div>
        )}

        <div className="pc-footer">
          <span>{ev.gate || ev.deviceName}</span>
          <span>EVT {ev.eventId?.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  );
}

function IdleSplash({ profile }) {
  return (
    <div className="tv-idle">
      <div className="ico">👋</div>
      <h2>Ready</h2>
      <p>{profile?.name ? `${profile.name} · awaiting next chaperone scan…` : 'Awaiting next chaperone scan…'}</p>
    </div>
  );
}

function GateClosed({ profile, gateStatus, clock }) {
  const timer = computeGateTimer(clock, gateStatus);
  return (
    <div className="tv-gate-closed">
      <div className="gc-badge">
        <i className="ph ph-lock-key" aria-hidden="true"></i>
        <span>Gate Closed</span>
      </div>
      <h1 className="gc-title">{profile?.name || 'Pickup gate'} is closed</h1>
      <p className="gc-sub">
        Pickup is currently outside the scheduled window. Early scans are being suppressed to prevent false alerts.
      </p>
      <div className="gc-window">
        <div className="gc-row">
          <label>Opens</label>
          <span className="gc-time">{gateStatus?.opensAt || '—'}</span>
        </div>
        <div className="gc-divider" />
        <div className="gc-row">
          <label>Closes</label>
          <span className="gc-time">{gateStatus?.closesAt || '—'}</span>
        </div>
      </div>
      {timer?.value && (
        <p className="gc-countdown" aria-live="polite">
          {timer.label || 'Gate opens in'} <b>{timer.value}</b>
        </p>
      )}
    </div>
  );
}

function QueueRow({ ev }) {
  const cls = ev.cardState === 'green' ? 'qg' : ev.cardState === 'yellow' ? 'qy' : 'qd';
  const students = ev.students || [];
  const studentLimit = 4;
  return (
    <div className={`qr ${cls}`}>
      {ev.chaperone?.photoUrl
        ? /* eslint-disable-next-line @next/next/no-img-element */
          <img className="qr-photo" src={ev.chaperone.photoUrl} alt="" />
        : <div className="qr-photo" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FCBF11', fontSize: 22 }}>
            {(ev.chaperone?.name || '?').charAt(0)}
          </div>}
      <div className="qr-meta">
        <div className="qr-name">{ev.chaperone?.name || 'Unknown'}</div>
        <div className="qr-sub">
          {students.map((s) => s.name).slice(0, 2).join(', ') || '—'}
          {students.length > 2 ? ` +${students.length - 2}` : ''}
        </div>
      </div>
      <div className="qr-time">{fmtTime(ev.scannedAt)}</div>
      {students.length > 0 && (
        <div className="qr-students">
          {students.slice(0, studentLimit).map((s) => (
            s.photoUrl
              ? /* eslint-disable-next-line @next/next/no-img-element */
                <img key={s.id} className="qr-stud-photo" src={s.photoUrl} alt={s.name} title={`${s.name} · ${s.homeroom || ''}`} />
              : <div key={s.id} className="qr-stud-fb" title={`${s.name} · ${s.homeroom || ''}`}>
                  {(s.name || '?').charAt(0)}
                </div>
          ))}
          {students.length > studentLimit && (
            <div className="qr-stud-more">+{students.length - studentLimit}</div>
          )}
        </div>
      )}
    </div>
  );
}

function SpiritTicker({ gateStats }) {
  const hasStats = gateStats && gateStats.length > 0;
  return (
    <div className="ticker">
      <div className="ticker-label">
        <span>★</span> BINUS SPIRIT
      </div>
      {/* #7 — per-gate counts on the right of the ticker */}
      {hasStats && (
        <div className="ticker-stats">
          {gateStats.map((g) => (
            <div key={g.gate} className="ts-gate" title={g.gate}>
              <span className="ts-gate-name">{g.gate.split(' (')[0]}</span>
              <span className="ts-gate-counts">
                <span className="ts-ok">{g.ok}</span>
                {g.warn > 0 && <span className="ts-warn">·{g.warn}</span>}
                {g.deny > 0 && <span className="ts-deny">·{g.deny}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="ticker-track">
        <div className="ticker-scroll">
          {[...SPIRIT_VALUES, ...SPIRIT_VALUES, ...SPIRIT_VALUES].map((v, i) => (
            <span key={i} className="ticker-item">
              <span className="ti-letter">{v.short}</span>
              <span className="ti-word">{v.word}</span>
              <span className="ti-desc">{v.desc}</span>
              <span className="ti-dot">◆</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── #3 Just-arrived flagged-event toast ─────────────────────────────────
function JustArrivedToast({ ev, onClose }) {
  const isRed = ev.cardState === 'red';
  return (
    <div className={`tv-toast ${isRed ? 'red' : 'yellow'}`} onClick={onClose}>
      <div className="tt-icon">{isRed ? '✕' : '⚠'}</div>
      <div className="tt-text">
        <div className="tt-head">
          {isRed ? 'UNAUTHORISED PICKUP' : 'ATTENTION REQUIRED'}
        </div>
        <div className="tt-sub">
          {ev.chaperone?.name || 'Unknown'} · {ev.gate || ev.deviceName} · {fmtTime(ev.scannedAt)}
        </div>
      </div>
      <div className="tt-close" aria-label="Dismiss">×</div>
    </div>
  );
}

// ─── #8 Idle screensaver ─────────────────────────────────────────────────
function Screensaver({ clock, profile }) {
  return (
    <div className="tv-screensaver" aria-hidden="true">
      <div className="ss-bg" />
      <div className="ss-content">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/binus-logo.jpg" alt="" className="ss-logo" />
        <div className="ss-title">BINUS School Simprug</div>
        <div className="ss-sub">PickupGuard standing by</div>
        <div className="ss-clock">
          {clock ? clock.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--'}
        </div>
        <div className="ss-date">
          {clock ? clock.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : ''}
        </div>
        {profile?.name && <div className="ss-gate">{profile.name}</div>}
        <div className="ss-hint">Display will resume on next pickup scan</div>
      </div>
    </div>
  );
}
