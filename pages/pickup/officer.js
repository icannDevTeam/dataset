/**
 * /pickup/officer  — Gate-officer override pad.
 *
 * Mobile-optimised page where an officer types the 6-digit code shown on
 * the TV display for a flagged pickup_event, plus their name. POSTs to
 * /api/pickup/admin/officer-override.
 *
 * Designed to be opened on a phone at the gate. No login — protected by
 * the same-origin / api-key check on the endpoint plus the fact that the
 * code is only on the TV at that moment.
 */
import Head from 'next/head';
import { useState, useEffect } from 'react';

const OFFICER_LS_KEY = 'pgtv_officer_name';

export default function OfficerPage() {
  const [code, setCode] = useState('');
  const [officer, setOfficer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Remember officer name across sessions
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(OFFICER_LS_KEY);
    if (saved) setOfficer(saved);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (officer) window.localStorage.setItem(OFFICER_LS_KEY, officer);
  }, [officer]);

  const submit = async (e) => {
    e?.preventDefault?.();
    setError(null); setResult(null);
    if (!/^\d{6}$/.test(code)) { setError('Code must be 6 digits.'); return; }
    if (!officer.trim()) { setError('Enter your name.'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/officer-override', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, officer: officer.trim(), note: note.trim() || undefined }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
      } else {
        setResult(j);
        setCode(''); setNote('');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Auto-submit when code reaches 6 digits + officer name known
  useEffect(() => {
    if (code.length === 6 && officer.trim() && !busy) {
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <>
      <Head>
        <title>Gate Officer · PickupGuard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>
      <div className="page">
        <header className="hd">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/binus-logo.jpg" alt="" />
          <div>
            <div className="hd-t">PickupGuard</div>
            <div className="hd-s">Gate Officer Override</div>
          </div>
        </header>

        <form onSubmit={submit} className="card">
          <label className="lbl">Officer name</label>
          <input
            value={officer}
            onChange={(e) => setOfficer(e.target.value)}
            placeholder="e.g. Pak Andi"
            className="inp"
            autoComplete="name"
          />

          <label className="lbl" style={{ marginTop: 18 }}>6-digit code from TV</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className="inp code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoFocus
          />

          <label className="lbl" style={{ marginTop: 18 }}>Note (optional)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Verified via emergency contact list"
            className="inp"
          />

          <button type="submit" className="btn" disabled={busy || code.length !== 6 || !officer.trim()}>
            {busy ? 'Sending…' : 'Approve pickup'}
          </button>

          {error && <div className="msg err">⚠ {error}</div>}
          {result && (
            <div className="msg ok">
              <strong>Approved</strong> · {result.chaperone}
              <div style={{ opacity: 0.75, fontSize: 13, marginTop: 4 }}>
                {result.gate} · event {result.eventId?.slice(0, 8)}
              </div>
            </div>
          )}
        </form>

        <p className="hint">
          The 6-digit code appears on the gate TV next to any flagged pickup
          (yellow / red band). Codes expire after 10 minutes and one-time-use.
        </p>
      </div>

      <style jsx global>{`
        html, body { margin: 0; padding: 0; background: linear-gradient(160deg, #2a0a18 0%, #5D0E27 100%); min-height: 100vh; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: #f8f1e6; }
        * { box-sizing: border-box; }
      `}</style>
      <style jsx>{`
        .page { max-width: 480px; margin: 0 auto; padding: 24px 18px 60px; }
        .hd { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
        .hd img { width: 54px; height: 54px; border-radius: 14px; background: white; padding: 5px; }
        .hd-t { font-size: 22px; font-weight: 800; }
        .hd-s { font-size: 13px; opacity: 0.65; letter-spacing: 1.2px; text-transform: uppercase; margin-top: 2px; }
        .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(252,191,17,0.18); border-radius: 18px; padding: 22px; backdrop-filter: blur(8px); }
        .lbl { display: block; font-size: 12px; opacity: 0.7; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 8px; }
        .inp { width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid rgba(252,191,17,0.3); background: rgba(0,0,0,0.25); color: white; font-size: 17px; outline: none; }
        .inp:focus { border-color: #FCBF11; }
        .inp.code { font-size: 38px; text-align: center; letter-spacing: 14px; font-variant-numeric: tabular-nums; padding: 18px 8px; font-weight: 700; color: #FCBF11; }
        .btn { width: 100%; margin-top: 22px; padding: 16px; border: 0; border-radius: 14px; background: #FCBF11; color: #5D0E27; font-size: 17px; font-weight: 800; letter-spacing: 0.5px; cursor: pointer; }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .msg { margin-top: 16px; padding: 12px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; }
        .msg.ok { background: rgba(34,197,94,0.16); border: 1px solid rgba(34,197,94,0.4); color: #bbf7d0; }
        .msg.err { background: rgba(239,68,68,0.18); border: 1px solid rgba(239,68,68,0.45); color: #fecaca; }
        .hint { margin-top: 22px; font-size: 12.5px; opacity: 0.55; line-height: 1.55; padding: 0 4px; }
      `}</style>
    </>
  );
}
