/**
 * /v2/security
 *
 * Security incident heatmap (#17). Day × Hour grid coloured by incident
 * count, plus breakdowns by kind and gate, and a recent-incidents list.
 *
 * Pure read-only investigation surface.
 */
import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const KIND_LABEL = {
  unknown_chaperone: 'Unknown chaperone',
  suspended: 'Suspended',
  reenroll_overdue: 'Re-enroll overdue',
  officer_override: 'Officer override',
  unknown: 'Other',
};
const KIND_TONE = {
  unknown_chaperone: 'red',
  suspended: 'red',
  reenroll_overdue: 'amber',
  officer_override: 'emerald',
  unknown: 'slate',
};

export default function SecurityHeatmapPage() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stop = false;
    setLoading(true);
    fetch(`/api/pickup/admin/security-heatmap?days=${days}`)
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (stop) return;
        if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
        else { setData(j); setErr(null); }
      })
      .catch((e) => !stop && setErr(e.message))
      .finally(() => !stop && setLoading(false));
    return () => { stop = true; };
  }, [days]);

  const maxCount = useMemo(() => {
    if (!data?.byDayHour) return 0;
    return Math.max(0, ...Object.values(data.byDayHour));
  }, [data]);

  return (
    <>
      <Head><title>Security Heatmap · BINUSFace</title></Head>
      <V2Layout>
        <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[90rem] mx-auto">
          {/* Header */}
          <div className="flex items-end justify-between flex-wrap gap-3 mb-5">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                <i className="ph ph-shield-warning text-amber-400"></i>
                Security Heatmap
              </h1>
              <p className="text-sm text-slate-400 mt-1">
                When and where unknown chaperones, suspensions, and overrides are happening.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {[7, 14, 30, 60].map((d) => (
                <button key={d} onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                    days === d
                      ? 'bg-brand-500 border-brand-400 text-white'
                      : 'bg-white/5 border-slate-800 text-slate-300 hover:bg-white/10'
                  }`}>{d}d</button>
              ))}
            </div>
          </div>

          {err && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-200 p-3 text-sm mb-4">⚠ {err}</div>
          )}

          {data && (
            <>
              {/* Top stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                <SmallStat label="Total incidents" value={data.total} />
                <SmallStat label="Days analysed" value={data.days} />
                <SmallStat label="Peak hour" value={peakHour(data)} />
                <SmallStat label="Worst gate" value={worstGate(data)} />
              </div>

              {/* Heatmap */}
              <div className="rounded-2xl border border-slate-800 bg-white/5 p-5 mb-5 overflow-x-auto">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-white tracking-tight">Day × Hour heatmap</h2>
                  <Legend max={maxCount} />
                </div>
                <table className="border-separate" style={{ borderSpacing: '2px' }}>
                  <thead>
                    <tr>
                      <th className="text-[10px] text-slate-500 font-medium pr-2 text-right">Date</th>
                      {HOURS.map((h) => (
                        <th key={h} className="text-[9px] text-slate-500 font-mono w-7 text-center">
                          {h % 3 === 0 ? pad(h) : ''}
                        </th>
                      ))}
                      <th className="text-[10px] text-slate-500 font-medium pl-2 text-left">Σ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dayAxis.map((day) => (
                      <tr key={day}>
                        <td className="text-[10px] text-slate-400 font-mono pr-2 text-right whitespace-nowrap">
                          {day.slice(5)}
                        </td>
                        {HOURS.map((h) => {
                          const count = data.byDayHour[`${day}|${h}`] || 0;
                          return (
                            <td key={h} title={`${day} ${pad(h)}:00 — ${count} incident${count === 1 ? '' : 's'}`}
                              className="w-7 h-7 rounded text-center align-middle"
                              style={{ background: heatColor(count, maxCount) }}>
                              {count > 0 && (
                                <span className="text-[10px] font-bold text-white tabular-nums">{count}</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="text-[10px] text-slate-300 pl-2 font-bold tabular-nums">
                          {data.dayTotals[day] || 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Breakdowns + recent */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <Breakdown title="By kind" rows={Object.entries(data.byKind)} labeler={(k) => KIND_LABEL[k] || k} toner={(k) => KIND_TONE[k] || 'slate'} />
                <Breakdown title="By gate" rows={Object.entries(data.byGate)} />
                <RecentList items={data.recent} />
              </div>
            </>
          )}

          {loading && !data && <div className="text-sm text-slate-400">Loading heatmap…</div>}
        </div>
      </V2Layout>
    </>
  );
}

function SmallStat({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-white/5 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-xl font-bold text-white tabular-nums mt-1">{value || '—'}</div>
    </div>
  );
}

function Breakdown({ title, rows, labeler = (s) => s, toner = () => 'slate' }) {
  const sorted = [...rows].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = Math.max(1, ...sorted.map((r) => r[1]));
  return (
    <div className="rounded-xl border border-slate-800 bg-white/5 p-4">
      <h3 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">{title}</h3>
      {sorted.length === 0 ? (
        <div className="text-xs text-slate-500">None.</div>
      ) : (
        <ul className="space-y-2">
          {sorted.map(([k, v]) => {
            const tone = toner(k);
            const barTone = { red: 'bg-red-500/60', amber: 'bg-amber-500/60', emerald: 'bg-emerald-500/60', slate: 'bg-slate-500/60' }[tone];
            return (
              <li key={k}>
                <div className="flex justify-between text-[11px] text-slate-300 mb-0.5">
                  <span className="truncate pr-2">{labeler(k)}</span>
                  <span className="font-bold tabular-nums">{v}</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div className={`h-full ${barTone}`} style={{ width: `${(v / max) * 100}%` }}/>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RecentList({ items }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-white/5 p-4">
      <h3 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-3">Recent incidents</h3>
      {items.length === 0 ? (
        <div className="text-xs text-slate-500">None.</div>
      ) : (
        <ul className="space-y-2 max-h-80 overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className="text-[11px] flex items-start gap-2 border-l-2 border-slate-700 pl-2">
              <span className={`mt-1 h-1.5 w-1.5 rounded-full ${i.resolved ? 'bg-emerald-400' : 'bg-amber-400'} flex-shrink-0`}/>
              <div className="min-w-0 flex-1">
                <div className="text-slate-200 font-medium">{KIND_LABEL[i.kind] || i.kind}</div>
                <div className="text-slate-500">
                  {fmt(i.at)} · {i.gate || '—'} {i.chaperoneName && <>· {i.chaperoneName}</>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Legend({ max }) {
  return (
    <div className="flex items-center gap-1 text-[10px] text-slate-500">
      <span>0</span>
      {[0, 0.2, 0.4, 0.6, 0.8, 1].map((p) => (
        <span key={p} className="w-4 h-3 rounded" style={{ background: heatColor(Math.round(p * max), max) }}/>
      ))}
      <span>{max}</span>
    </div>
  );
}

function heatColor(n, max) {
  if (!n) return 'rgba(255,255,255,0.03)';
  const t = max ? n / max : 0;
  // Ramp: cool slate → amber → red
  if (t < 0.5) {
    const r = Math.round(50 + t * 2 * 200);
    const g = Math.round(50 + t * 2 * 130);
    const b = Math.round(80 - t * 2 * 50);
    return `rgba(${r},${g},${b},0.85)`;
  } else {
    const u = (t - 0.5) * 2;
    const r = Math.round(250 - u * 10);
    const g = Math.round(180 - u * 130);
    const b = Math.round(30);
    return `rgba(${r},${g},${b},0.95)`;
  }
}

function peakHour(data) {
  if (!data?.byDayHour) return '—';
  const byHour = {};
  Object.entries(data.byDayHour).forEach(([k, v]) => {
    const h = parseInt(k.split('|')[1], 10);
    byHour[h] = (byHour[h] || 0) + v;
  });
  const peaks = Object.entries(byHour).sort((a, b) => b[1] - a[1]);
  if (peaks.length === 0 || peaks[0][1] === 0) return '—';
  return `${pad(peaks[0][0])}:00 (${peaks[0][1]})`;
}

function worstGate(data) {
  if (!data?.byGate) return '—';
  const sorted = Object.entries(data.byGate).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return '—';
  return `${sorted[0][0]} (${sorted[0][1]})`;
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}
