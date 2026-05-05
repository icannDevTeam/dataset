/**
 * /pickup/teacher — Teacher iPad Pickup Validation Screen
 *
 * Auth-gated: teacher (or admin) must be signed in.
 * Shows pickup events filtered to the teacher's assigned classes.
 * Approve button uses the 6-digit override code → officer-override API.
 *
 * Design: full-screen, mobile-first, large touch targets for iPad.
 * BINUS maroon (#8B1538) + gold (#FCBF11) + slate palette.
 */
import Head from 'next/head';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/router';
import { signOut as fbSignOut } from '../../lib/firebase-client';

const POLL_MS = 3000;
const BINUS_MAROON = '#8B1538';
const BINUS_GOLD = '#FCBF11';

// ─── Decision band colours ────────────────────────────────────────────────────
const CARD_THEME = {
  green:  { border: '#22C55E', bg: 'rgba(34,197,94,0.08)',  label: 'AUTHORISED',  icon: '✓', labelColor: '#22C55E' },
  yellow: { border: '#FCBF11', bg: 'rgba(252,191,17,0.08)', label: 'NEEDS CHECK', icon: '⚠', labelColor: '#FCBF11' },
  red:    { border: '#EF4444', bg: 'rgba(239,68,68,0.08)',  label: 'BLOCKED',     icon: '✕', labelColor: '#EF4444' },
};

function theme(cardState) {
  return CARD_THEME[cardState] || CARD_THEME.yellow;
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return '—'; }
}

function elapsed(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({ src, name, size = 72, ring }) {
  const [err, setErr] = useState(false);
  const initials = (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
      border: `3px solid ${ring || '#334155'}`,
      background: '#1E293B',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: ring ? `0 0 16px ${ring}44` : 'none',
    }}>
      {src && !err
        ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setErr(true)} />
        : <span style={{ fontSize: size * 0.36, fontWeight: 800, color: '#94A3B8' }}>{initials}</span>}
    </div>
  );
}

// ─── Student chip ─────────────────────────────────────────────────────────────
function StudentChip({ student }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'rgba(255,255,255,0.05)', borderRadius: 10,
      padding: '6px 10px', border: '1px solid rgba(255,255,255,0.08)',
    }}>
      <Avatar src={student.photoUrl} name={student.name} size={36} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#E2E8F0' }}>{student.name}</div>
        <div style={{ fontSize: 11, color: BINUS_GOLD, fontWeight: 600 }}>{student.homeroom}</div>
      </div>
    </div>
  );
}

// ─── Approve panel (shown when event needs override) ─────────────────────────
function ApprovePanel({ event, onApproved }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = useCallback(async (finalCode) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/pickup/admin/officer-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',   // sends __session cookie
        body: JSON.stringify({ code: finalCode }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error || 'Failed to approve');
      } else {
        onApproved(event.id);
      }
    } catch (e) {
      setErr(e.message || 'Network error');
    } finally {
      setBusy(false);
    }
  }, [busy, event.id, onApproved]);

  const tap = (digit) => {
    if (code.length >= 6) return;
    const next = code + digit;
    setCode(next);
    if (next.length === 6) submit(next);
  };

  const clear = () => { setCode(''); setErr(null); };

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
      <div style={{ fontSize: 13, color: '#94A3B8', marginBottom: 10, fontWeight: 600 }}>
        Enter 6-digit override code shown on the TV screen
      </div>

      {/* Code display */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, justifyContent: 'center' }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{
            width: 40, height: 48, borderRadius: 10,
            border: `2px solid ${i < code.length ? BINUS_GOLD : 'rgba(255,255,255,0.15)'}`,
            background: i < code.length ? 'rgba(252,191,17,0.1)' : 'rgba(255,255,255,0.04)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 800, color: BINUS_GOLD,
            transition: 'border-color 0.15s, background 0.15s',
          }}>
            {code[i] ? '•' : ''}
          </div>
        ))}
      </div>

      {err && (
        <div style={{
          margin: '0 0 12px', padding: '8px 12px', borderRadius: 8,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
          color: '#FCA5A5', fontSize: 13, textAlign: 'center',
        }}>
          {err}
        </div>
      )}

      {/* NumPad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, maxWidth: 240, margin: '0 auto' }}>
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d) => (
          <button key={d} disabled={busy || (!d && d !== '0')}
            onClick={() => {
              if (!d) return;
              if (d === '⌫') clear();
              else tap(d);
            }}
            style={{
              height: 56, borderRadius: 12, fontWeight: 800, fontSize: 22,
              background: d === '⌫' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.07)',
              border: `1px solid ${d === '⌫' ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.1)'}`,
              color: d === '⌫' ? '#FCA5A5' : '#E2E8F0',
              cursor: d || d === '0' ? 'pointer' : 'default',
              opacity: (busy || !d) && d !== '0' ? 0.4 : 1,
              transition: 'opacity 0.1s, background 0.1s',
              WebkitTapHighlightColor: 'transparent',
            }}>
            {busy && code.length === 6 && d === '0' ? '…' : d}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Event card ───────────────────────────────────────────────────────────────
function EventCard({ event, onApproved }) {
  const t = theme(event.cardState);
  const approved = !!event.officerOverride;
  const needsApproval = !approved && (event.cardState === 'yellow' || event.cardState === 'red');

  return (
    <div style={{
      borderRadius: 16, border: `2px solid ${t.border}`,
      background: t.bg, padding: 20, marginBottom: 14,
      boxShadow: `0 0 24px ${t.border}22`,
    }}>
      {/* Status banner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: `${t.border}22`, border: `2px solid ${t.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 900, color: t.labelColor,
        }}>
          {approved ? '✓' : t.icon}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.labelColor, letterSpacing: 1 }}>
            {approved ? 'APPROVED' : t.label}
          </div>
          {approved && (
            <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 500 }}>
              by {event.officerOverride.by} · {fmtTime(event.officerOverride.at)}
            </div>
          )}
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 12, color: '#64748B', fontWeight: 500 }}>
            {fmtTime(event.scannedAt || event.recordedAt)}
          </div>
          <div style={{ fontSize: 11, color: '#475569' }}>
            {elapsed(event.scannedAt || event.recordedAt)} · {event.gate || '—'}
          </div>
        </div>
      </div>

      {/* Chaperone */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Avatar src={event.chaperone?.photoUrl} name={event.chaperone?.name} size={56} ring={t.border} />
        <div>
          <div style={{ fontSize: 11, color: '#64748B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>Chaperone</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#E2E8F0' }}>{event.chaperone?.name || '—'}</div>
        </div>
        {event.overrideCode && !approved && (
          <div style={{
            marginLeft: 'auto', background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10, padding: '6px 12px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 10, color: '#64748B', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Code</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: BINUS_GOLD, letterSpacing: 3, fontVariantNumeric: 'tabular-nums' }}>
              {event.overrideCode}
            </div>
          </div>
        )}
      </div>

      {/* Students */}
      {event.students && event.students.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: needsApproval ? 0 : 4 }}>
          {event.students.map((s, i) => <StudentChip key={i} student={s} />)}
        </div>
      )}

      {/* Approve panel */}
      {needsApproval && <ApprovePanel event={event} onApproved={onApproved} />}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ classScopes }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 24px' }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#E2E8F0', marginBottom: 8 }}>All clear</div>
      <div style={{ fontSize: 14, color: '#64748B' }}>
        No pending pickup events for {classScopes.length > 0 ? classScopes.join(', ') : 'your classes'}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function TeacherPickup() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [feed, setFeed] = useState({ events: [], classScopes: [], displayName: '', role: '' });
  const [online, setOnline] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [err, setErr] = useState(null);
  const [approvedIds, setApprovedIds] = useState(new Set());
  const pollRef = useRef(null);

  useEffect(() => { setMounted(true); }, []);

  const fetchFeed = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/teacher/feed', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (r.status === 401) { router.replace('/login'); return; }
      if (r.status === 403) { setErr('Access denied. Check your account permissions.'); return; }
      const j = await r.json();
      if (!r.ok) { setErr(j.error || 'Feed error'); return; }
      setFeed(j);
      setLastUpdated(new Date());
      setOnline(true);
      setErr(null);
    } catch (e) {
      setOnline(false);
      setErr(e.message);
    }
  }, [router]);

  useEffect(() => {
    if (!mounted) return;
    fetchFeed();
    pollRef.current = setInterval(fetchFeed, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [mounted, fetchFeed]);

  const handleApproved = useCallback((id) => {
    setApprovedIds((prev) => new Set([...prev, id]));
    // Refresh immediately to pick up updated event state
    fetchFeed();
  }, [fetchFeed]);

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/session', { method: 'DELETE', credentials: 'include' });
      await fbSignOut();
    } catch {}
    router.replace('/login');
  };

  if (!mounted) return null;

  // Filter events: only pending (no override, yellow/red) for the main queue
  // Show recently resolved (override exists) in a separate list below
  const pending = feed.events.filter((e) =>
    !e.officerOverride && (e.cardState === 'yellow' || e.cardState === 'red')
  );
  const resolved = feed.events.filter((e) => e.officerOverride || e.cardState === 'green');

  return (
    <>
      <Head>
        <title>Teacher · Pickup Validation</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <meta name="theme-color" content={BINUS_MAROON} />
      </Head>

      <div style={{
        minHeight: '100dvh',
        background: 'linear-gradient(160deg, #0A0A14 0%, #0D1117 100%)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: 'white',
        overscrollBehavior: 'none',
      }}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 50,
          background: 'rgba(10,10,20,0.92)', backdropFilter: 'blur(20px)',
          borderBottom: `2px solid ${BINUS_MAROON}`,
          padding: '14px 20px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {/* Logo mark */}
          <div style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            background: BINUS_MAROON,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
          }}>🏫</div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#E2E8F0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {feed.displayName || 'Teacher'} · Pickup
            </div>
            {feed.classScopes && feed.classScopes.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
                {feed.classScopes.map((c) => (
                  <span key={c} style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 1,
                    padding: '2px 7px', borderRadius: 20,
                    background: `${BINUS_GOLD}22`, color: BINUS_GOLD,
                    border: `1px solid ${BINUS_GOLD}44`,
                  }}>{c}</span>
                ))}
              </div>
            )}
          </div>

          {/* Status dot */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: online ? '#22C55E' : '#EF4444',
              boxShadow: online ? '0 0 6px #22C55E' : '0 0 6px #EF4444',
            }} />
            {pending.length > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 800, letterSpacing: 0.5,
                padding: '2px 8px', borderRadius: 20,
                background: '#FCBF11', color: '#000',
              }}>
                {pending.length} pending
              </span>
            )}
          </div>

          <button onClick={handleSignOut} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#64748B', fontSize: 22, lineHeight: 1, padding: '4px 2px',
            WebkitTapHighlightColor: 'transparent',
          }} title="Sign out">⏻</button>
        </div>

        {/* ── Error banner ─────────────────────────────────────────── */}
        {err && (
          <div style={{
            margin: '12px 16px 0', padding: '10px 14px', borderRadius: 10,
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            color: '#FCA5A5', fontSize: 13,
          }}>
            {err}
          </div>
        )}

        {/* ── Event list ───────────────────────────────────────────── */}
        <div style={{ padding: '16px 16px 32px' }}>

          {/* Pending section */}
          {pending.length > 0 ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 10 }}>
                Needs your approval ({pending.length})
              </div>
              {pending.map((ev) => (
                <EventCard key={ev.id} event={ev} onApproved={handleApproved} />
              ))}
            </>
          ) : (
            <EmptyState classScopes={feed.classScopes || []} />
          )}

          {/* Resolved section */}
          {resolved.length > 0 && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#334155',
                letterSpacing: 2, textTransform: 'uppercase',
                margin: '20px 0 10px',
              }}>
                Recent · resolved ({resolved.length})
              </div>
              {resolved.map((ev) => (
                <EventCard key={ev.id} event={ev} onApproved={handleApproved} />
              ))}
            </>
          )}

          {/* Last updated */}
          {lastUpdated && (
            <div style={{ textAlign: 'center', marginTop: 24, fontSize: 11, color: '#1E293B' }}>
              Last updated {lastUpdated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
