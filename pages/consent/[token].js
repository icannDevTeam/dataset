/**
 * /consent/[token] — Guardian-facing consent capture page.
 *
 * Public (no Firebase Auth). Token is HMAC-signed and carries
 * { tenantId, studentId, expiry }. Loads the active Privacy Policy and
 * the student's current consent state, then lets the guardian record or
 * withdraw consent.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function ConsentPage() {
  const router = useRouter();
  const { token } = router.query;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [status, setStatus] = useState(null);

  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianRelation, setGuardianRelation] = useState('parent');
  const [signature, setSignature] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null); // {kind:'recorded'|'withdrawn', at:iso}

  useEffect(() => {
    if (!token) return;
    let cancel = false;
    (async () => {
      try {
        setLoading(true);
        const sRes = await fetch(`/api/consent/status?token=${encodeURIComponent(token)}`);
        const sJson = await sRes.json();
        if (!sRes.ok) throw new Error(sJson.error || 'token error');
        if (cancel) return;
        setStatus(sJson);
        const pRes = await fetch(`/api/consent/policy?tenant=${encodeURIComponent(sJson.tenantId)}`);
        const pJson = await pRes.json();
        if (!pRes.ok) throw new Error(pJson.error || 'policy error');
        if (cancel) return;
        setPolicy(pJson);
        if (sJson.consentedAt && !sJson.withdrawnAt) {
          // pre-fill guardian fields if a consent already exists (read-back)
        }
      } catch (e) {
        if (!cancel) setError(e.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [token]);

  async function recordConsent(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/consent/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, guardianName, guardianEmail, guardianRelation, signature }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'failed');
      setDone({ kind: 'recorded', at: json.consentedAt });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function withdrawConsent() {
    if (!confirm('Withdraw consent? Biometric data will be deleted within 30 days.')) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/consent/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, reason: 'guardian_request' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'failed');
      setDone({ kind: 'withdrawn', at: json.withdrawnAt });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Head><title>Privacy Consent</title></Head>
      <main style={{ maxWidth: 760, margin: '40px auto', padding: '0 20px', fontFamily: 'system-ui, sans-serif', color: '#222' }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Facial Attendance — Privacy Consent</h1>
        {policy && <p style={{ color: '#666', marginTop: 0 }}>{policy.tenantName} · Policy version {policy.versionId} · effective {policy.effectiveDate}</p>}

        {loading && <p>Loading…</p>}

        {error && (
          <div style={{ background: '#ffe7e7', border: '1px solid #f5b5b5', padding: 12, borderRadius: 6, color: '#8a1a1a' }}>
            {error}
          </div>
        )}

        {!loading && status && !done && (
          <>
            <section style={{ background: '#f7f7f9', padding: 14, borderRadius: 6, margin: '16px 0' }}>
              <strong>Student:</strong> {status.student?.name || status.student?.id}
              {status.student?.homeroom && <> &middot; Homeroom {status.student.homeroom}</>}
              <br />
              <strong>Current consent state:</strong> <code>{status.state}</code>
              {status.consentedAt && <> · last recorded {new Date(status.consentedAt).toLocaleString()}</>}
            </section>

            {policy && (
              <details open style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 20 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Read Privacy Policy ({policy.body?.length || 0} chars · sha256 {String(policy.sha256 || '').slice(0, 12)}…)</summary>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.4, marginTop: 12, fontFamily: 'inherit' }}>{policy.body}</pre>
              </details>
            )}

            {status.state !== 'active' && (
              <form onSubmit={recordConsent} style={{ display: 'grid', gap: 12 }}>
                <h2 style={{ fontSize: 18, margin: 0 }}>Record consent</h2>
                <label>
                  Guardian full name
                  <input required value={guardianName} onChange={e => setGuardianName(e.target.value)}
                    style={inputStyle} />
                </label>
                <label>
                  Guardian email
                  <input required type="email" value={guardianEmail} onChange={e => setGuardianEmail(e.target.value)}
                    style={inputStyle} />
                </label>
                <label>
                  Relation
                  <select value={guardianRelation} onChange={e => setGuardianRelation(e.target.value)} style={inputStyle}>
                    <option value="parent">Parent</option>
                    <option value="guardian">Legal guardian</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label>
                  Type your full name as signature (must match exactly)
                  <input required value={signature} onChange={e => setSignature(e.target.value)}
                    style={inputStyle} placeholder="Your name" />
                </label>
                <button type="submit" disabled={submitting} style={primaryBtn}>
                  {submitting ? 'Submitting…' : 'I consent'}
                </button>
              </form>
            )}

            {status.state === 'active' && (
              <div style={{ marginTop: 16 }}>
                <p>You have an <strong>active</strong> consent on file for the current Privacy Policy.</p>
                <button onClick={withdrawConsent} disabled={submitting} style={dangerBtn}>
                  {submitting ? 'Withdrawing…' : 'Withdraw consent'}
                </button>
              </div>
            )}
          </>
        )}

        {done && (
          <div style={{ background: '#e7f6ee', border: '1px solid #b5e0c5', padding: 14, borderRadius: 6, marginTop: 16, color: '#1a5a31' }}>
            {done.kind === 'recorded' ? 'Consent recorded' : 'Consent withdrawn'} · {new Date(done.at).toLocaleString()}
            {done.kind === 'withdrawn' && <p style={{ margin: '8px 0 0' }}>Biometric data will be deleted within 30 days.</p>}
          </div>
        )}
      </main>
    </>
  );
}

const inputStyle = { display: 'block', width: '100%', padding: '8px 10px', marginTop: 4, border: '1px solid #ccc', borderRadius: 4, fontSize: 14, boxSizing: 'border-box' };
const primaryBtn = { background: '#0a66c2', color: 'white', border: 'none', padding: '10px 18px', borderRadius: 4, fontSize: 15, cursor: 'pointer' };
const dangerBtn = { background: '#b9352b', color: 'white', border: 'none', padding: '10px 18px', borderRadius: 4, fontSize: 15, cursor: 'pointer' };
