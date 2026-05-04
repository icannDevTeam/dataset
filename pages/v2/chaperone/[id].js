/**
 * /v2/chaperone/[id]
 *
 * Per-chaperone audit timeline (#15). Shows:
 *   - Chaperone profile + last-seen
 *   - Onboarding submission link
 *   - Chronological feed of pickup_events (green/yellow/red)
 *   - Security incidents flagged against this chaperone
 *
 * Read-only — for admin investigation when something looks wrong.
 */
import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import V2Layout from '../../../components/v2/V2Layout';

export default function ChaperoneAuditPage() {
  const router = useRouter();
  const { id } = router.query;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let stop = false;
    setLoading(true);
    fetch(`/api/pickup/admin/chaperone-audit?id=${encodeURIComponent(String(id))}`)
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (stop) return;
        if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); }
        else { setData(j); setErr(null); }
      })
      .catch((e) => !stop && setErr(e.message))
      .finally(() => !stop && setLoading(false));
    return () => { stop = true; };
  }, [id]);

  // Merge events + incidents into one chronological list
  const timeline = useMemo(() => {
    if (!data) return [];
    const items = [
      ...(data.events || []).map((e) => ({ ...e, _t: e.at })),
      ...(data.incidents || []).map((i) => ({ ...i, _t: i.at })),
    ];
    items.sort((a, b) => (b._t || '').localeCompare(a._t || ''));
    return items;
  }, [data]);

  const counts = useMemo(() => {
    const c = { total: 0, ok: 0, warn: 0, deny: 0 };
    (data?.events || []).forEach((e) => {
      c.total++;
      if (e.cardState === 'green') c.ok++;
      else if (e.cardState === 'yellow') c.warn++;
      else if (e.cardState === 'red') c.deny++;
    });
    return c;
  }, [data]);

  return (
    <>
      <Head><title>Chaperone audit · BINUSFace</title></Head>
      <V2Layout>
        <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-5xl mx-auto">
          <button onClick={() => router.back()}
            className="text-xs text-slate-400 hover:text-white mb-3">
            <i className="ph ph-arrow-left mr-1"></i>Back
          </button>

          {loading && <div className="text-sm text-slate-400">Loading audit timeline…</div>}
          {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-200 p-3 text-sm">⚠ {err}</div>}

          {data && (
            <>
              {/* Header */}
              <div className="rounded-2xl border border-slate-800 bg-white/5 p-5 mb-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-slate-500">Chaperone audit</div>
                    <h1 className="text-2xl font-bold text-white tracking-tight mt-1">
                      {data.chaperone.name || '—'}
                    </h1>
                    <div className="text-sm text-slate-400 mt-1 flex items-center gap-3 flex-wrap">
                      <span><i className="ph ph-id-card mr-1"></i>#{data.chaperone.employeeNo || '—'}</span>
                      {data.chaperone.relationship && <span>· {data.chaperone.relationship}</span>}
                      <span>· {data.chaperone.authorizedStudentIds?.length || 0} student(s)</span>
                      <span>· {data.chaperone.photoCount} photo(s)</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-2">
                      Last seen: {data.chaperone.lastSeenAt ? `${fmt(data.chaperone.lastSeenAt)} at ${data.chaperone.lastSeenGate || '—'}` : 'never'}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <Stat label="Pickups" value={counts.total} />
                    <Stat label="OK" value={counts.ok} tone="emerald" />
                    <Stat label="Warn" value={counts.warn} tone="amber" />
                    <Stat label="Deny" value={counts.deny} tone="red" />
                  </div>
                </div>
                {data.onboarding && (
                  <div className="mt-4 pt-3 border-t border-slate-800 text-xs text-slate-400">
                    Onboarded by <span className="text-slate-200 font-medium">{data.onboarding.guardian || '—'}</span>
                    {data.onboarding.submittedAt && <> · submitted {fmt(data.onboarding.submittedAt)}</>}
                    {data.onboarding.approvedAt && <> · approved {fmt(data.onboarding.approvedAt)}</>}
                    {data.onboarding.status && <> · status <span className="text-slate-200">{data.onboarding.status}</span></>}
                  </div>
                )}
              </div>

              {/* Timeline */}
              <h2 className="text-sm font-semibold text-white mb-3 px-1">
                Activity ({timeline.length})
              </h2>
              {timeline.length === 0 ? (
                <div className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-800 rounded-xl">
                  No activity recorded yet.
                </div>
              ) : (
                <ol className="relative border-l border-slate-800 ml-3 space-y-3">
                  {timeline.map((it, i) => <TimelineItem key={`${it.kind}-${it.id || i}`} it={it} />)}
                </ol>
              )}
            </>
          )}
        </div>
      </V2Layout>
    </>
  );
}

function Stat({ label, value, tone = 'slate' }) {
  const tones = {
    slate: 'text-white border-slate-700 bg-white/5',
    emerald: 'text-emerald-200 border-emerald-500/30 bg-emerald-500/10',
    amber: 'text-amber-200 border-amber-500/30 bg-amber-500/10',
    red: 'text-red-200 border-red-500/30 bg-red-500/10',
  }[tone];
  return (
    <div className={`rounded-lg border ${tones} px-3 py-2 min-w-[60px]`}>
      <div className="text-lg font-bold tabular-nums leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-wider opacity-70 mt-1">{label}</div>
    </div>
  );
}

function TimelineItem({ it }) {
  const isIncident = it.kind === 'security_incident';
  const tone = isIncident ? 'red'
    : it.cardState === 'red' ? 'red'
    : it.cardState === 'yellow' ? 'amber'
    : 'emerald';
  const dotColor = { red: 'bg-red-500', amber: 'bg-amber-500', emerald: 'bg-emerald-500' }[tone];
  const ringColor = {
    red: 'border-red-500/30 bg-red-500/5',
    amber: 'border-amber-500/30 bg-amber-500/5',
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
  }[tone];

  return (
    <li className="ml-4 pl-2">
      <span className={`absolute -left-[6.5px] mt-2 h-3 w-3 rounded-full ${dotColor} ring-2 ring-slate-950`} />
      <div className={`rounded-xl border ${ringColor} p-3`}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs uppercase tracking-wider text-slate-300 font-bold">
            {isIncident ? <><i className="ph ph-shield-warning mr-1"></i>{it.type}</>
              : <><i className="ph ph-hand-waving mr-1"></i>{it.decision}</>}
          </div>
          <div className="text-[11px] text-slate-500 tabular-nums">{fmt(it.at || it._t)}</div>
        </div>
        {!isIncident && (
          <div className="mt-1 text-sm text-slate-200">
            {(it.students || []).join(', ') || <span className="text-slate-500">no students</span>}
            <span className="text-slate-500"> · {it.gate}</span>
          </div>
        )}
        {isIncident && it.gate && (
          <div className="mt-1 text-sm text-slate-300">at {it.gate}</div>
        )}
        {it.officerOverride && (
          <div className="mt-2 text-[11px] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-200">
            <i className="ph ph-check"></i>
            Officer override by {it.officerOverride.by}
          </div>
        )}
        {it.override && (
          <div className="mt-2 text-[11px] text-emerald-300">
            Resolved by {it.override.by}
          </div>
        )}
      </div>
    </li>
  );
}

function fmt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}
