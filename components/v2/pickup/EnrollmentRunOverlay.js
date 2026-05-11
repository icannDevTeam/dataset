/**
 * EnrollmentRunOverlay
 *
 * Live progress modal for chaperone enrollment runs.
 *
 * Usage:
 *   <EnrollmentRunOverlay
 *     queue={[{ id, name, terminals: [{ip, name, isMatched}] }]}
 *     onClose={() => setRun(null)}
 *     onDone={(summary) => refresh()}
 *   />
 *
 * The overlay:
 *   - Iterates the queue serially, calling POST /api/pickup/admin/reenroll
 *     with { chaperoneIds: [id], deviceIps: [...selected ips] } per chaperone.
 *   - Renders a per-chaperone row with live status (pending → uploading →
 *     done) and per-device sub-rows (✓ / ✗ + error).
 *   - On completion, summarises results and offers:
 *       • Retry failed only (re-run only the failed chaperone × device pairs)
 *       • Re-enroll all
 *       • Done (closes overlay, parent refreshes)
 *   - Non-dismissable while in flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STATUS_META = {
  pending:   { icon: 'ph-circle-dashed',         tone: 'slate',   label: 'Waiting' },
  uploading: { icon: 'ph-spinner-gap animate-spin', tone: 'sky',  label: 'Uploading…' },
  success:   { icon: 'ph-check-circle',          tone: 'emerald', label: 'Enrolled' },
  partial:   { icon: 'ph-circle-half',           tone: 'amber',   label: 'Partial' },
  failed:    { icon: 'ph-x-circle',              tone: 'rose',    label: 'Failed' },
};

const TONE = {
  slate:   { dot: 'bg-slate-500',   text: 'text-slate-300', bg: 'bg-slate-500/10', border: 'border-slate-500/30' },
  sky:     { dot: 'bg-sky-500',     text: 'text-sky-300',   bg: 'bg-sky-500/10',   border: 'border-sky-500/30' },
  emerald: { dot: 'bg-emerald-500', text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  amber:   { dot: 'bg-amber-500',   text: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
  rose:    { dot: 'bg-rose-500',    text: 'text-rose-300',  bg: 'bg-rose-500/10',  border: 'border-rose-500/30' },
};

export default function EnrollmentRunOverlay({ queue, onClose, onDone }) {
  // runs[i] = { id, name, terminals: [{ip,name,isMatched}], status, devices: [{ip,name,status,error}] }
  const [runs, setRuns] = useState(() =>
    queue.map((q) => ({
      id: q.id,
      name: q.name,
      terminals: q.terminals,
      status: 'pending',
      devices: q.terminals.map((t) => ({ ip: t.ip, name: t.name, status: 'pending', error: null })),
    }))
  );
  const [done, setDone] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const cancelled = useRef(false);

  // ── Run worker ──
  const runQueue = useCallback(async (queueToRun) => {
    cancelled.current = false;
    setDone(false);
    for (let i = 0; i < queueToRun.length; i++) {
      if (cancelled.current) break;
      const item = queueToRun[i];
      // mark uploading
      setRuns((prev) => prev.map((r) =>
        r.id === item.id
          ? { ...r, status: 'uploading', devices: r.devices.map((d) => ({ ...d, status: 'uploading', error: null })) }
          : r
      ));

      try {
        const res = await fetch('/api/pickup/admin/reenroll', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chaperoneIds: [item.id],
            deviceIps: item.terminals.map((t) => t.ip),
          }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || j.message || `HTTP ${res.status}`);
        const summary = (j.summary || [])[0] || {};
        const deviceResults = Array.isArray(summary.devices) ? summary.devices : [];
        const byIp = new Map(deviceResults.map((d) => [d.ip, d]));

        setRuns((prev) => prev.map((r) => {
          if (r.id !== item.id) return r;
          const updatedDevices = r.devices.map((d) => {
            const dr = byIp.get(d.ip);
            if (!dr) return { ...d, status: 'failed', error: 'no result returned' };
            return { ...d, status: dr.ok ? 'success' : 'failed', error: dr.ok ? null : (dr.error || 'unknown error') };
          });
          const oks = updatedDevices.filter((d) => d.status === 'success').length;
          const fails = updatedDevices.filter((d) => d.status === 'failed').length;
          const overall = fails === 0 ? 'success' : (oks > 0 ? 'partial' : 'failed');
          return { ...r, status: overall, devices: updatedDevices };
        }));
      } catch (e) {
        setRuns((prev) => prev.map((r) =>
          r.id === item.id
            ? { ...r, status: 'failed', devices: r.devices.map((d) => ({ ...d, status: 'failed', error: e.message })) }
            : r
        ));
      }
    }
    setDone(true);
    setRetrying(false);
  }, []);

  // Kick off on mount
  useEffect(() => {
    runQueue(queue);
    return () => { cancelled.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived counts ──
  const counts = useMemo(() => {
    let ok = 0, fail = 0, partial = 0, pending = 0;
    runs.forEach((r) => {
      if (r.status === 'success') ok += 1;
      else if (r.status === 'partial') partial += 1;
      else if (r.status === 'failed') fail += 1;
      else pending += 1;
    });
    const totalDevices = runs.reduce((n, r) => n + r.devices.length, 0);
    const okDevices = runs.reduce((n, r) => n + r.devices.filter((d) => d.status === 'success').length, 0);
    const failDevices = runs.reduce((n, r) => n + r.devices.filter((d) => d.status === 'failed').length, 0);
    return { ok, fail, partial, pending, totalChaperones: runs.length, okDevices, failDevices, totalDevices };
  }, [runs]);

  const failedQueue = useMemo(() => {
    // Per-chaperone retry: include only the devices that previously failed.
    return runs
      .filter((r) => r.status === 'partial' || r.status === 'failed')
      .map((r) => ({
        id: r.id,
        name: r.name,
        terminals: r.devices
          .filter((d) => d.status === 'failed')
          .map((d) => ({ ip: d.ip, name: d.name, isMatched: true })),
      }))
      .filter((r) => r.terminals.length > 0);
  }, [runs]);

  const retryFailed = async () => {
    if (failedQueue.length === 0) return;
    setRetrying(true);
    // Reset only the failed devices to pending in the UI
    setRuns((prev) => prev.map((r) => {
      const inRetry = failedQueue.find((f) => f.id === r.id);
      if (!inRetry) return r;
      return {
        ...r,
        status: 'pending',
        devices: r.devices.map((d) => {
          const willRetry = inRetry.terminals.some((t) => t.ip === d.ip);
          return willRetry ? { ...d, status: 'pending', error: null } : d;
        }),
      };
    }));
    await runQueue(failedQueue);
  };

  const reEnrollAll = async () => {
    setRetrying(true);
    setRuns((prev) => prev.map((r) => ({
      ...r,
      status: 'pending',
      devices: r.devices.map((d) => ({ ...d, status: 'pending', error: null })),
    })));
    await runQueue(queue);
  };

  const handleClose = () => {
    if (!done) return; // non-dismissable while running
    onDone && onDone(runs);
    onClose && onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[90vh] rounded-2xl bg-slate-950 border border-slate-700 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              done
                ? counts.fail === 0 ? 'bg-emerald-500/15 border border-emerald-500/40' : 'bg-amber-500/15 border border-amber-500/40'
                : 'bg-sky-500/15 border border-sky-500/40'
            }`}>
              <i className={`ph text-2xl ${
                done
                  ? counts.fail === 0 ? 'ph-check-circle text-emerald-300' : 'ph-warning text-amber-300'
                  : 'ph-fingerprint text-sky-300 animate-pulse'
              }`} />
            </div>
            <div className="min-w-0">
              <div className="text-base font-bold text-white">
                {done ? 'Enrollment complete' : 'Enrolling chaperones'}
              </div>
              <div className="text-[11px] text-slate-400">
                {done
                  ? `${counts.okDevices}/${counts.totalDevices} device pushes succeeded`
                  : `Pushing to ${counts.totalDevices} terminal${counts.totalDevices !== 1 ? 's' : ''}…`}
              </div>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={!done}
            className="text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed text-xl"
            title={done ? 'Close' : 'Wait for enrollment to finish'}
          >
            <i className="ph ph-x" />
          </button>
        </div>

        {/* Stat strip */}
        <div className="px-6 py-3 grid grid-cols-4 gap-2 flex-shrink-0 border-b border-slate-800">
          {[
            { k: 'Total',   v: counts.totalChaperones, tone: 'slate',   icon: 'ph-users' },
            { k: 'Ok',      v: counts.ok,              tone: 'emerald', icon: 'ph-check-circle' },
            { k: 'Partial', v: counts.partial,         tone: 'amber',   icon: 'ph-circle-half' },
            { k: 'Failed',  v: counts.fail,            tone: 'rose',    icon: 'ph-x-circle' },
          ].map((s) => {
            const t = TONE[s.tone];
            return (
              <div key={s.k} className={`rounded-lg border ${t.border} ${t.bg} px-3 py-2 flex items-center gap-2`}>
                <i className={`ph ${s.icon} ${t.text}`} />
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">{s.k}</div>
                  <div className={`text-base font-bold ${t.text}`}>{s.v}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Live list */}
        <div className="flex-1 min-h-0 overflow-auto px-6 py-4 space-y-2">
          {runs.map((r) => {
            const meta = STATUS_META[r.status];
            const tone = TONE[meta.tone];
            return (
              <div key={r.id} className={`rounded-lg border ${tone.border} ${tone.bg} p-3`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <i className={`ph ${meta.icon} text-lg ${tone.text} flex-shrink-0`} />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{r.name}</div>
                      <div className={`text-[10px] uppercase tracking-wider ${tone.text}`}>{meta.label}</div>
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono flex-shrink-0">
                    {r.devices.filter((d) => d.status === 'success').length}/{r.devices.length}
                  </div>
                </div>

                {/* Per-device chips */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {r.devices.map((d) => {
                    const dm = STATUS_META[d.status];
                    const dt = TONE[dm.tone];
                    return (
                      <span
                        key={d.ip}
                        title={d.error || `${d.name} · ${d.ip}`}
                        className={`text-[10px] px-1.5 py-0.5 rounded border font-mono inline-flex items-center gap-1 ${dt.border} ${dt.bg} ${dt.text}`}
                      >
                        <i className={`ph ${dm.icon} text-[10px]`} />
                        {d.name.replace(/\s*\(.*\)\s*$/, '')}
                      </span>
                    );
                  })}
                </div>

                {/* Error detail */}
                {r.devices.some((d) => d.error) && (
                  <details className="mt-2">
                    <summary className="text-[10px] text-rose-300 cursor-pointer hover:underline">View errors</summary>
                    <ul className="mt-1 space-y-0.5 text-[10px] text-rose-200 font-mono pl-3">
                      {r.devices.filter((d) => d.error).map((d) => (
                        <li key={d.ip}><span className="text-rose-400">{d.name}:</span> {d.error}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between gap-2 flex-shrink-0">
          <div className="text-[11px] text-slate-500">
            {done
              ? counts.fail > 0 || counts.partial > 0
                ? `${counts.failDevices} device${counts.failDevices !== 1 ? 's' : ''} failed — retry or reconfigure.`
                : 'All chaperones successfully enrolled on the selected terminals.'
              : 'Do not close this window until all uploads finish.'}
          </div>
          <div className="flex gap-2">
            {done && failedQueue.length > 0 && (
              <button
                onClick={retryFailed}
                disabled={retrying}
                className="text-xs px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-200 hover:bg-rose-500/30 disabled:opacity-50 font-semibold"
              >
                <i className="ph ph-arrow-counter-clockwise mr-1" />
                Retry failed ({failedQueue.length})
              </button>
            )}
            {done && (
              <button
                onClick={reEnrollAll}
                disabled={retrying}
                className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
              >
                <i className="ph ph-arrows-clockwise mr-1" />
                Re-enroll all
              </button>
            )}
            <button
              onClick={handleClose}
              disabled={!done}
              className={`text-xs px-4 py-1.5 rounded-lg font-semibold ${
                done
                  ? 'bg-brand-500 border border-brand-400 text-white hover:bg-brand-600'
                  : 'bg-slate-800 border border-slate-700 text-slate-500 cursor-not-allowed'
              }`}
            >
              {done ? 'Done' : <><i className="ph ph-spinner-gap animate-spin mr-1" />Running…</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
