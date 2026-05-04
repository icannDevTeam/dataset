/**
 * /v2/chaperones
 *
 * Bulk chaperone management (#14):
 *   - List + filter + search all chaperones
 *   - Multi-select + bulk re-enroll campaign
 *   - Click name → opens audit timeline (/v2/chaperone/[id])
 */
import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'due', label: 'Re-enroll due' },
  { key: 'never_enrolled', label: 'Never enrolled' },
];

export default function ChaperonesPage() {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterGrade, setFilterGrade] = useState('all');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState({}); // {id: true}
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const load = () => {
    setLoading(true);
    fetch(`/api/pickup/admin/chaperones-list?status=${filter}`)
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
        else { setData(j); setErr(null); setSelected({}); }
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [filter]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.items.filter((c) => {
      const matchText = !q ||
        (c.name || '').toLowerCase().includes(q) ||
        (c.employeeNo || '').toLowerCase().includes(q) ||
        (c.relationship || '').toLowerCase().includes(q) ||
        (c.studentClasses || []).some((v) => String(v).toLowerCase().includes(q)) ||
        (c.studentGrades || []).some((v) => String(v).toLowerCase().includes(q));

      const matchClass =
        filterClass === 'all' || (c.studentClasses || []).includes(filterClass);
      const matchGrade =
        filterGrade === 'all' || (c.studentGrades || []).includes(filterGrade);

      return matchText && matchClass && matchGrade;
    });
  }, [data, search, filterClass, filterGrade]);

  const classOptions = useMemo(() => {
    if (!data?.items) return [];
    const s = new Set();
    data.items.forEach((c) => (c.studentClasses || []).forEach((v) => v && s.add(v)));
    return Array.from(s).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  }, [data]);

  const gradeOptions = useMemo(() => {
    if (!data?.items) return [];
    const s = new Set();
    data.items.forEach((c) => (c.studentGrades || []).forEach((v) => v && s.add(v)));
    return Array.from(s).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  }, [data]);

  const selectedIds = useMemo(
    () => Object.keys(selected).filter((k) => selected[k]),
    [selected]
  );

  const allChecked = visible.length > 0 && visible.every((c) => selected[c.id]);
  const someChecked = !allChecked && visible.some((c) => selected[c.id]);

  const toggleAll = () => {
    if (allChecked) {
      const next = { ...selected };
      visible.forEach((c) => delete next[c.id]);
      setSelected(next);
    } else {
      const next = { ...selected };
      visible.forEach((c) => { next[c.id] = true; });
      setSelected(next);
    }
  };

  const runBulkReenroll = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Push face photos to all gates for ${selectedIds.length} chaperone(s)?`)) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/pickup/admin/reenroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chaperoneIds: selectedIds }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setResult(j);
      setSelected({});
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head><title>Chaperones · BINUSFace</title></Head>
      <V2Layout>
        <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[90rem] mx-auto">

          {/* Header */}
          <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                <i className="ph ph-users-three text-brand-400"></i>
                Chaperones
              </h1>
              <p className="text-sm text-slate-400 mt-1">
                Manage all approved chaperones. Multi-select to run a bulk re-enroll campaign across all gates.
              </p>
            </div>
            <button onClick={load}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
              <i className="ph ph-arrows-clockwise mr-1"></i>Refresh
            </button>
          </div>

          {/* Filters & search */}
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div className="flex items-center gap-1 flex-wrap">
              {STATUS_FILTERS.map((f) => {
                const count = data?.counts?.[f.key];
                return (
                  <button key={f.key} onClick={() => setFilter(f.key)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                      filter === f.key
                        ? 'bg-brand-500 border-brand-400 text-white'
                        : 'bg-white/5 border-slate-800 text-slate-300 hover:bg-white/10'
                    }`}>
                    {f.label}
                    {typeof count === 'number' && (
                      <span className="ml-1.5 opacity-70 tabular-nums">({count})</span>
                    )}
                  </button>
                );
              })}

              <select
                value={filterClass}
                onChange={(e) => setFilterClass(e.target.value)}
                className="px-2.5 py-1.5 text-xs rounded-lg bg-white/5 border border-slate-800 text-slate-200 focus:outline-none focus:border-brand-400"
                title="Filter by class"
              >
                <option value="all">All classes</option>
                {classOptions.map((cls) => (
                  <option key={cls} value={cls}>{cls}</option>
                ))}
              </select>

              <select
                value={filterGrade}
                onChange={(e) => setFilterGrade(e.target.value)}
                className="px-2.5 py-1.5 text-xs rounded-lg bg-white/5 border border-slate-800 text-slate-200 focus:outline-none focus:border-brand-400"
                title="Filter by grade"
              >
                <option value="all">All grades</option>
                {gradeOptions.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, employeeNo, class, grade…"
              className="w-full sm:w-72 px-3 py-1.5 text-sm rounded-lg bg-white/5 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-400"
            />
          </div>

          {/* Bulk action bar */}
          {selectedIds.length > 0 && (
            <div className="rounded-xl border border-brand-500/40 bg-brand-500/10 px-4 py-3 mb-4 flex items-center justify-between flex-wrap gap-3">
              <div className="text-sm text-white">
                <strong className="tabular-nums">{selectedIds.length}</strong> chaperone(s) selected
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setSelected({})}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10">
                  Clear
                </button>
                <button onClick={runBulkReenroll} disabled={busy}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-brand-500 hover:bg-brand-400 disabled:opacity-50 text-white">
                  {busy ? 'Pushing…' : <><i className="ph ph-cloud-arrow-up mr-1"></i>Bulk re-enroll across all gates</>}
                </button>
              </div>
            </div>
          )}

          {err && <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-200 p-3 text-sm mb-3">⚠ {err}</div>}
          {result && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-100 p-3 text-sm mb-3">
              <strong>Bulk re-enroll done.</strong>{' '}
              {result.summary?.filter?.((s) => s.ok).length || 0} ok ·{' '}
              {result.summary?.filter?.((s) => !s.ok).length || 0} failed
            </div>
          )}

          {/* Table */}
          <div className="rounded-xl border border-slate-800 bg-white/5 overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" checked={allChecked}
                      ref={(el) => { if (el) el.indeterminate = someChecked; }}
                      onChange={toggleAll} />
                  </th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">EmployeeNo</th>
                  <th className="px-3 py-2 text-left">Students</th>
                  <th className="px-3 py-2 text-left">Class / Grade</th>
                  <th className="px-3 py-2 text-left">Enrollment</th>
                  <th className="px-3 py-2 text-left">Last seen</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && !loading && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500 text-xs">No chaperones match.</td></tr>
                )}
                {visible.map((c) => (
                  <tr key={c.id} className="border-t border-slate-800 hover:bg-white/5">
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={!!selected[c.id]}
                        onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))} />
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/v2/chaperone/${c.id}`} className="text-slate-100 font-medium hover:text-brand-300">
                        {c.name}
                      </Link>
                      {c.relationship && <span className="ml-2 text-[11px] text-slate-500">{c.relationship}</span>}
                      {c.suspended && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30">SUSPENDED</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-400 font-mono text-xs">{c.employeeNo || '—'}</td>
                    <td className="px-3 py-2 text-slate-300 tabular-nums">{c.authorizedStudentIds.length}</td>
                    <td className="px-3 py-2 text-[11px]">
                      <div className="text-slate-200">{(c.studentClasses || []).join(', ') || '—'}</div>
                      <div className="text-slate-500">{(c.studentGrades || []).join(', ') || '—'}</div>
                    </td>
                    <td className="px-3 py-2">
                      {c.enrollmentSummary ? (
                        <span className={`text-[11px] font-medium ${c.enrollmentSummary.fail ? 'text-amber-300' : 'text-emerald-300'}`}>
                          {c.enrollmentSummary.ok}/{c.enrollmentSummary.total}
                          {c.enrollmentSummary.fail > 0 && <> · {c.enrollmentSummary.fail} fail</>}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-500">never</span>
                      )}
                      {c.isReenrollDue && (
                        <div className="text-[10px] text-amber-400 mt-0.5">re-enroll overdue</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-400">
                      {c.lastSeenAt ? <>{fmt(c.lastSeenAt)}<div className="text-slate-500">{c.lastSeenGate}</div></> : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/v2/chaperone/${c.id}`} className="text-[11px] text-brand-300 hover:text-brand-200">
                        Audit →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loading && <div className="text-xs text-slate-500 px-3 py-2">Loading…</div>}
          </div>

        </div>
      </V2Layout>
    </>
  );
}

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}
