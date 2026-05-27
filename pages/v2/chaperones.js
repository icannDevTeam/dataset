/**
 * /v2/chaperones
 *
 * Bulk chaperone management (#14):
 *   - List + filter + search all chaperones
 *   - Multi-select + bulk re-enroll campaign
 *   - Click name → opens audit timeline (/v2/chaperone/[id])
 *   - Shadow-delete with mandatory reason + Show deleted toggle + Restore
 */
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'due', label: 'Re-enroll due' },
  { key: 'never_enrolled', label: 'Never enrolled' },
];

const AVATAR_COLORS = [
  'bg-rose-500/30 text-rose-100',
  'bg-amber-500/30 text-amber-100',
  'bg-emerald-500/30 text-emerald-100',
  'bg-sky-500/30 text-sky-100',
  'bg-violet-500/30 text-violet-100',
  'bg-fuchsia-500/30 text-fuchsia-100',
  'bg-teal-500/30 text-teal-100',
  'bg-orange-500/30 text-orange-100',
];

function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorOf(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ url, name, size = 32 }) {
  const cls = `rounded-full overflow-hidden flex items-center justify-center font-semibold ${colorOf(name)}`;
  const style = { width: size, height: size, fontSize: Math.max(10, Math.floor(size * 0.38)) };
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={name || 'chaperone'}
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return <div className={cls} style={style}>{initialsOf(name)}</div>;
}

function StudentChips({ students = [], max = 3 }) {
  if (!students.length) return <span className="text-[11px] text-slate-500">none</span>;
  const list = students.slice(0, max);
  const more = students.length - list.length;
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((s) => (
        <span
          key={s.id || s.binusId || s.name}
          title={[s.name, s.homeroom, s.grade].filter(Boolean).join(' · ')}
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800/80 border border-slate-700 text-slate-200"
        >
          {s.name || s.binusId || s.id}
        </span>
      ))}
      {more > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-slate-400">
          +{more} more
        </span>
      )}
    </div>
  );
}

function DeleteReasonModal({ open, chaperone, onCancel, onConfirm, busy }) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <i className="ph ph-trash text-rose-300" />
          Shadow-delete chaperone
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Marks <span className="text-slate-200 font-medium">{chaperone?.name || '—'}</span> as deleted.
          Hikvision enrolment and audit history are preserved; the record can be restored later.
        </p>
        <label className="block mt-4 text-[11px] uppercase tracking-wider text-slate-500">
          Reason <span className="text-rose-300">*</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this chaperone being removed?"
          rows={3}
          maxLength={500}
          className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-rose-400"
          autoFocus
        />
        <div className="text-[10px] text-slate-500 text-right mt-1">{reason.length}/500</div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !reason.trim()}
            onClick={() => onConfirm(reason.trim())}
            className="px-3 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy ? <><i className="ph ph-circle-notch animate-spin" /> Deleting…</> : <><i className="ph ph-trash" /> Shadow-delete</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ChaperonesPage() {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterGrade, setFilterGrade] = useState('all');
  const [showDeleted, setShowDeleted] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState({}); // {id: true}
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams({ status: filter });
    if (showDeleted) qs.set('includeDeleted', '1');
    fetch(`/api/pickup/admin/chaperones-list?${qs.toString()}`)
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
        else { setData(j); setErr(null); setSelected({}); }
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [filter, showDeleted]);
  useEffect(load, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.items.filter((c) => {
      const matchText = !q ||
        (c.name || '').toLowerCase().includes(q) ||
        (c.employeeNo || '').toLowerCase().includes(q) ||
        (c.relationship || '').toLowerCase().includes(q) ||
        (c.studentClasses || []).some((v) => String(v).toLowerCase().includes(q)) ||
        (c.studentGrades || []).some((v) => String(v).toLowerCase().includes(q)) ||
        (c.linkedStudents || []).some((s) => String(s.name || '').toLowerCase().includes(q));

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

  const selectableVisible = useMemo(
    () => visible.filter((c) => c.lifecycleStatus !== 'deleted'),
    [visible]
  );
  const allChecked = selectableVisible.length > 0 && selectableVisible.every((c) => selected[c.id]);
  const someChecked = !allChecked && selectableVisible.some((c) => selected[c.id]);

  const toggleAll = () => {
    if (allChecked) {
      const next = { ...selected };
      selectableVisible.forEach((c) => delete next[c.id]);
      setSelected(next);
    } else {
      const next = { ...selected };
      selectableVisible.forEach((c) => { next[c.id] = true; });
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

  const confirmDelete = async (reason) => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/chaperone-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chaperoneId: deleteTarget.id, reason }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setDeleteTarget(null);
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const restoreChaperone = async (c) => {
    if (!window.confirm(`Restore chaperone ${c.name}?`)) return;
    try {
      const r = await fetch('/api/pickup/admin/chaperone-restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chaperoneId: c.id }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      load();
    } catch (e) {
      setErr(e.message);
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
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => setShowDeleted(e.target.checked)}
                  className="accent-rose-500"
                />
                Show deleted
                {typeof data?.counts?.deleted === 'number' && (
                  <span className="ml-1 text-slate-500 tabular-nums">({data.counts.deleted})</span>
                )}
              </label>
              <button onClick={load}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
                <i className="ph ph-arrows-clockwise mr-1"></i>Refresh
              </button>
            </div>
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
              placeholder="Search name, employeeNo, student, class, grade…"
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
                  <th className="px-3 py-2 text-left w-10"></th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">EmployeeNo</th>
                  <th className="px-3 py-2 text-left">Linked students</th>
                  <th className="px-3 py-2 text-left">Class / Grade</th>
                  <th className="px-3 py-2 text-left">Enrollment</th>
                  <th className="px-3 py-2 text-left">Last seen</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && !loading && (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500 text-xs">No chaperones match.</td></tr>
                )}
                {visible.map((c) => {
                  const isDeleted = c.lifecycleStatus === 'deleted';
                  return (
                  <tr key={c.id} className={`border-t border-slate-800 hover:bg-white/5 ${isDeleted ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={!!selected[c.id]}
                        disabled={isDeleted}
                        onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))} />
                    </td>
                    <td className="px-3 py-2">
                      <Avatar url={c.photoUrl} name={c.name} size={32} />
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/v2/chaperone/${c.id}`} className="text-slate-100 font-medium hover:text-brand-300">
                        {c.name}
                      </Link>
                      {c.relationship && <span className="ml-2 text-[11px] text-slate-500">{c.relationship}</span>}
                      {c.suspended && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/30">SUSPENDED</span>}
                      {isDeleted && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-200 border border-rose-500/30">DELETED</span>}
                      {isDeleted && c.deletedReason && (
                        <div className="mt-0.5 text-[10px] text-rose-300/80 italic line-clamp-1" title={c.deletedReason}>
                          “{c.deletedReason}”
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-400 font-mono text-xs">{c.employeeNo || '—'}</td>
                    <td className="px-3 py-2">
                      <StudentChips students={c.linkedStudents} max={3} />
                    </td>
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
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/v2/chaperone/${c.id}`} className="text-[11px] text-brand-300 hover:text-brand-200">
                          Audit →
                        </Link>
                        {isDeleted ? (
                          <button
                            type="button"
                            onClick={() => restoreChaperone(c)}
                            className="text-[11px] text-emerald-300 hover:text-emerald-200"
                            title="Restore"
                          >
                            <i className="ph ph-arrow-counter-clockwise mr-0.5" />Restore
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(c)}
                            className="text-[11px] text-rose-300 hover:text-rose-200"
                            title="Shadow-delete"
                          >
                            <i className="ph ph-trash mr-0.5" />Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {loading && <div className="text-xs text-slate-500 px-3 py-2">Loading…</div>}
          </div>

        </div>
      </V2Layout>

      <DeleteReasonModal
        open={!!deleteTarget}
        chaperone={deleteTarget}
        busy={deleteBusy}
        onCancel={() => !deleteBusy && setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}
