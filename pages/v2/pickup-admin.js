/**
 * /v2/pickup-admin
 *
 * Admin review queue for PickupGuard parent submissions. Pro-grade UX:
 *   - Search + sort + per-tab counts
 *   - Bulk select + bulk approve / bulk reject (with reason)
 *   - Inline reject form (no browser prompts)
 *   - Toast notifications instead of alert()
 *   - Printable "Filled Form Preview" modal per record
 *   - Per-record device-enrollment status & one-click re-push
 *   - Stat strip with health indicators
 *
 * Approve  → POST /api/pickup/admin/approve         (single)
 * Reject   → POST /api/pickup/admin/reject          (single, with reason)
 * Bulk     → POST /api/pickup/admin/bulk-action     (action: approve|reject)
 * Re-push  → POST /api/pickup/admin/reenroll        (after approval)
 */
import Head from 'next/head';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import V2Layout from '../../components/v2/V2Layout';
import KioskManager from '../../components/v2/KioskManager';

const TABS = [
  { key: 'pending',  label: 'Pending',  badge: true },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const REL_LABEL = {
  mother: 'Mother', father: 'Father', parent: 'Parent',
  guardian: 'Guardian', driver: 'Driver', nanny: 'Nanny',
  grandparent: 'Grandparent', sibling: 'Sibling',
  emergency: 'Emergency contact', other: 'Other',
};

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'most-chaperones', label: 'Most chaperones' },
  { key: 'most-students', label: 'Most students' },
  { key: 'name-az', label: 'Guardian A → Z' },
];

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
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
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Toast system ───────────────────────────────────────────────────────────
let _toastSeq = 0;
function ToastHost({ toasts, onDismiss }) {
  return (
    <div className="fixed top-4 right-4 z-[9999] space-y-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id}
          className={`pointer-events-auto min-w-[280px] max-w-md rounded-lg border shadow-2xl shadow-black/40 backdrop-blur-xl px-4 py-3 text-sm flex items-start gap-3 animate-slide-up ${
            t.kind === 'error' ? 'bg-red-950/90 border-red-500/40 text-red-100' :
            t.kind === 'warn'  ? 'bg-amber-950/90 border-amber-500/40 text-amber-100' :
                                 'bg-emerald-950/90 border-emerald-500/40 text-emerald-100'
          }`}>
          <i className={`ph ${
            t.kind === 'error' ? 'ph-x-circle' : t.kind === 'warn' ? 'ph-warning' : 'ph-check-circle'
          } text-lg flex-shrink-0 mt-0.5`}></i>
          <div className="flex-1 min-w-0">
            {t.title && <div className="font-semibold mb-0.5">{t.title}</div>}
            <div className="text-xs opacity-90 whitespace-pre-line break-words">{t.message}</div>
          </div>
          <button onClick={() => onDismiss(t.id)}
            className="text-slate-300 hover:text-white text-xs flex-shrink-0">
            <i className="ph ph-x"></i>
          </button>
        </div>
      ))}
    </div>
  );
}

export default function PickupAdminPage() {
  const [tab, setTab] = useState('pending');
  const [records, setRecords] = useState([]);
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [working, setWorking] = useState({});       // recordId -> 'approve'|'reject'|'reenroll'
  const [expanded, setExpanded] = useState({});     // recordId -> bool
  const [rejectingId, setRejectingId] = useState(null);  // inline reject form
  const [rejectReason, setRejectReason] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const [thumbnails, setThumbnails] = useState({});
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [selected, setSelected] = useState({});     // recordId -> bool
  const [bulkBusy, setBulkBusy] = useState(false);
  const [printRec, setPrintRec] = useState(null);
  const [toasts, setToasts] = useState([]);

  // Top-level view switch — Onboarding queue vs TV Kiosk profiles.
  // Driven by the sidebar (?view=kiosks); no in-page toggle.
  const router = useRouter();
  const [view, setView] = useState('onboarding');
  useEffect(() => {
    if (!router.isReady) return;
    const v = String(router.query.view || '').toLowerCase();
    setView(v === 'kiosks' ? 'kiosks' : 'onboarding');
  }, [router.isReady, router.query.view]);

  // KioskManager toast adapter
  const kioskToast = useCallback((kind, msg) => {
    pushToast(kind === 'ok' ? 'success' : kind, msg);
  }, []);

  function pushToast(kind, message, title = null, ttl = 5000) {
    const id = ++_toastSeq;
    setToasts((ts) => [...ts, { id, kind, message, title }]);
    if (ttl) setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ttl);
  }

  // Load BINUS dataset thumbnails (cached server-side)
  useEffect(() => {
    fetch('/api/dataset/thumbnails', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (j?.thumbnails) setThumbnails(j.thumbnails); })
      .catch(() => {});
  }, []);

  const fetchList = useCallback(async (status) => {
    const r = await fetch(`/api/pickup/admin/onboarding-list?status=${status}&limit=100`, {
      credentials: 'include',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || j.message || 'fetch failed');
    return j.records || [];
  }, []);

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      // Always fetch all three tabs in parallel so the stat strip is accurate
      const [pendingL, approvedL, rejectedL] = await Promise.all([
        fetchList('pending').catch(() => []),
        fetchList('approved').catch(() => []),
        fetchList('rejected').catch(() => []),
      ]);
      setCounts({ pending: pendingL.length, approved: approvedL.length, rejected: rejectedL.length });
      setRecords(tab === 'pending' ? pendingL : tab === 'approved' ? approvedL : rejectedL);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [tab, fetchList]);

  useEffect(() => { reload(); }, [reload]);

  // Refresh pending count badge every 15s
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const list = await fetchList('pending');
        setCounts((c) => ({ ...c, pending: list.length }));
        if (tab === 'pending') setRecords(list);
      } catch {}
    }, 15000);
    return () => clearInterval(t);
  }, [tab, fetchList]);

  // Clear selection when tab changes
  useEffect(() => { setSelected({}); setRejectingId(null); }, [tab]);

  // ─── Filtered + sorted view ─────────────────────────────────────────────
  const visibleRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = records;
    if (q) {
      list = list.filter((r) => {
        const hay = [
          r.guardian?.name, r.guardian?.email, r.guardian?.phone,
          ...(r.students || []).flatMap((s) => [s.name, s.dbName, s.id, s.homeroom]),
          ...(r.chaperones || []).flatMap((c) => [c.name, c.phone, c.email, c.idNumber]),
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    const sorters = {
      'newest': (a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')),
      'oldest': (a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')),
      'most-chaperones': (a, b) => (b.chaperones?.length || 0) - (a.chaperones?.length || 0),
      'most-students': (a, b) => (b.students?.length || 0) - (a.students?.length || 0),
      'name-az': (a, b) => (a.guardian?.name || '').localeCompare(b.guardian?.name || ''),
    };
    return [...list].sort(sorters[sort] || sorters.newest);
  }, [records, search, sort]);

  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);
  const allSelected = visibleRecords.length > 0 && visibleRecords.every((r) => selected[r.id]);
  const someSelected = selectedIds.length > 0 && !allSelected;

  function toggleAll() {
    if (allSelected) setSelected({});
    else {
      const n = {};
      visibleRecords.forEach((r) => { n[r.id] = true; });
      setSelected(n);
    }
  }

  // ─── Single-record actions ──────────────────────────────────────────────
  async function approve(rec) {
    if (!confirm(`Approve submission from ${rec.guardian?.name}?\n\n` +
      `Allocates ${rec.chaperones.length} chaperone employeeNo(s) (9XXXXXXXXX) ` +
      `and pushes to all configured Hikvision devices.`)) return;
    setWorking((w) => ({ ...w, [rec.id]: 'approve' }));
    try {
      const r = await fetch('/api/pickup/admin/approve', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: rec.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'approve failed');
      const allocated = (j.allocated || []).length;
      const enrolledOk = (j.enrollment || []).filter((e) => e.ok).length;
      const enrolledFail = (j.enrollment || []).filter((e) => !e.ok).length;
      pushToast(
        enrolledFail > 0 ? 'warn' : 'success',
        `Allocated ${allocated} chaperone(s). Enrolled on devices: ${enrolledOk} ok` +
          (enrolledFail > 0 ? `, ${enrolledFail} failed (use Re-push to retry)` : '.'),
        `Approved: ${rec.guardian?.name}`,
      );
      await reload();
    } catch (e) { pushToast('error', e.message, 'Approve failed'); }
    finally { setWorking((w) => { const n = { ...w }; delete n[rec.id]; return n; }); }
  }

  async function submitReject(rec) {
    const reason = rejectReason.trim();
    if (reason.length < 4) return pushToast('warn', 'Reason must be at least 4 characters.');
    setWorking((w) => ({ ...w, [rec.id]: 'reject' }));
    try {
      const r = await fetch('/api/pickup/admin/reject', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: rec.id, reason }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'reject failed');
      pushToast('success', `Marked as rejected.`, rec.guardian?.name || rec.id);
      setRejectingId(null); setRejectReason('');
      await reload();
    } catch (e) { pushToast('error', e.message, 'Reject failed'); }
    finally { setWorking((w) => { const n = { ...w }; delete n[rec.id]; return n; }); }
  }

  async function reenroll(rec) {
    if (!confirm(`Re-push ${rec.allocatedChaperones?.length || 0} chaperone(s) to all configured Hikvision devices?`)) return;
    setWorking((w) => ({ ...w, [rec.id]: 'reenroll' }));
    try {
      const r = await fetch('/api/pickup/admin/reenroll', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: rec.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'reenroll failed');
      const okN = (j.summary || []).filter((e) => e.ok).length;
      const failN = (j.summary || []).filter((e) => !e.ok).length;
      pushToast(failN > 0 ? 'warn' : 'success',
        `Devices: ${okN} ok` + (failN ? `, ${failN} failed` : ''),
        'Re-enrollment complete');
      await reload();
    } catch (e) { pushToast('error', e.message, 'Re-enroll failed'); }
    finally { setWorking((w) => { const n = { ...w }; delete n[rec.id]; return n; }); }
  }

  // ─── Bulk actions ───────────────────────────────────────────────────────
  async function bulkApprove() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Approve ${selectedIds.length} pending submission(s)?\n\n` +
      `Each will allocate chaperone IDs and push to all configured Hikvision devices.`)) return;
    setBulkBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/bulk-action', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', recordIds: selectedIds }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'bulk approve failed');
      const okN = (j.results || []).filter((x) => x.ok).length;
      const failN = (j.results || []).filter((x) => !x.ok).length;
      pushToast(failN > 0 ? 'warn' : 'success',
        `${okN} approved, ${failN} failed.` + (failN ? '\nSee individual records for details.' : ''),
        'Bulk approve complete', 7000);
      setSelected({});
      await reload();
    } catch (e) { pushToast('error', e.message, 'Bulk approve failed'); }
    finally { setBulkBusy(false); }
  }

  async function bulkReject() {
    if (selectedIds.length === 0) return;
    const reason = prompt(`Reject ${selectedIds.length} submission(s)?\n\nReason (min 4 chars):`);
    if (!reason || reason.trim().length < 4) return;
    setBulkBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/bulk-action', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', recordIds: selectedIds, reason: reason.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'bulk reject failed');
      const okN = (j.results || []).filter((x) => x.ok).length;
      const failN = (j.results || []).filter((x) => !x.ok).length;
      pushToast(failN > 0 ? 'warn' : 'success', `${okN} rejected, ${failN} failed.`, 'Bulk reject complete');
      setSelected({});
      await reload();
    } catch (e) { pushToast('error', e.message, 'Bulk reject failed'); }
    finally { setBulkBusy(false); }
  }

  // ─── Stats ──────────────────────────────────────────────────────────────
  const enrollmentHealth = useMemo(() => {
    // For approved tab, derive totals
    if (tab !== 'approved') return null;
    let total = 0, ok = 0, partial = 0, fail = 0;
    records.forEach((r) => {
      const chaps = r.allocatedChaperones || [];
      chaps.forEach((c) => {
        total++;
        const e = (r.enrollment || []).find((x) => x.chaperoneId === c.chaperoneId);
        if (!e) fail++;
        else if (e.ok) ok++;
        else if ((e.devices || []).some((d) => d.ok)) partial++;
        else fail++;
      });
    });
    return { total, ok, partial, fail };
  }, [tab, records]);

  return (
    <>
      <Head><title>Pickup Admin · BINUSFace</title></Head>
      <V2Layout>
        <ToastHost toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />

        <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[90rem] mx-auto">
          {/* Page header (shared) */}
          <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                <i className="ph ph-hand-waving text-brand-400"></i>
                PickupGuard Admin
              </h1>
              <p className="text-sm text-slate-400 mt-1">
                {view === 'kiosks'
                  ? 'Manage TV kiosk profiles — one per screen, filtered by gate and grade.'
                  : 'Review parent-submitted authorizations. Approve to allocate a chaperone ID and push the face to all pickup terminals.'}
              </p>
            </div>
            {view === 'onboarding' && (
              <div className="flex items-center gap-2">
                <button onClick={reload}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
                  <i className="ph ph-arrows-clockwise mr-1"></i>Refresh
                </button>
              </div>
            )}
          </div>

          {view === 'kiosks' ? (
            <KioskManager showToast={kioskToast} />
          ) : (
          <>

          {/* #13 — Live "now at the gate" tile so admins see incoming pickups
              without having to open the TV display. Polls the same TV feed. */}
          <LiveGateTile />

          {/* Stat strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <StatCard label="Pending" value={counts.pending}
              tone={counts.pending > 0 ? 'amber' : 'slate'}
              icon="ph-clock" hint={counts.pending > 0 ? 'awaiting review' : 'all clear'} />
            <StatCard label="Approved (visible)" value={counts.approved}
              tone="emerald" icon="ph-check-circle" />
            <StatCard label="Rejected" value={counts.rejected}
              tone="slate" icon="ph-x-circle" />
            {enrollmentHealth ? (
              <StatCard
                label="Device enrollment"
                value={`${enrollmentHealth.ok}/${enrollmentHealth.total}`}
                tone={enrollmentHealth.fail === 0 ? 'emerald' : enrollmentHealth.ok > 0 ? 'amber' : 'red'}
                icon="ph-fingerprint"
                hint={
                  enrollmentHealth.total === 0 ? 'no chaperones'
                  : enrollmentHealth.fail === 0 ? 'all enrolled'
                  : `${enrollmentHealth.fail} need re-push`
                }
              />
            ) : (
              <StatCard label="Selected" value={selectedIds.length}
                tone={selectedIds.length > 0 ? 'brand' : 'slate'}
                icon="ph-check-square" hint="for bulk action" />
            )}
          </div>

          {/* Tabs + search + sort row */}
          <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
            <div className="flex gap-1 bg-white/5 p-1 rounded-lg border border-slate-800">
              {TABS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all relative ${
                    tab === t.key ? 'bg-brand-500/20 text-brand-300' : 'text-slate-400 hover:text-slate-200'
                  }`}>
                  {t.label}
                  <span className={`ml-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold ${
                    t.key === 'pending' && counts.pending > 0 ? 'bg-amber-500 text-amber-950' :
                    'bg-slate-800 text-slate-400'
                  }`}>
                    {counts[t.key]}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-[260px] sm:max-w-md">
              <div className="relative flex-1">
                <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"></i>
                <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search guardian, student, chaperone, ID…"
                  className="w-full bg-white/5 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500/50" />
                {search && (
                  <button onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                    <i className="ph ph-x"></i>
                  </button>
                )}
              </div>
              <select value={sort} onChange={(e) => setSort(e.target.value)}
                className="bg-white/5 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:border-brand-500/50">
                {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {/* Bulk action bar (only on pending tab when items selected) */}
          {tab === 'pending' && (
            <div className="flex items-center gap-3 mb-4 px-4 py-2.5 rounded-lg bg-white/5 border border-slate-800">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={toggleAll}
                  className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus:ring-brand-500/40" />
                <span className="font-medium">
                  {allSelected ? 'Deselect all' : someSelected ? `${selectedIds.length} selected` : 'Select all'}
                </span>
                <span className="text-slate-500">({visibleRecords.length} visible)</span>
              </label>
              <div className="flex-1"></div>
              {selectedIds.length > 0 && (
                <>
                  <button onClick={bulkReject} disabled={bulkBusy}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 disabled:opacity-50">
                    {bulkBusy ? 'Working…' : <><i className="ph ph-x mr-1"></i>Reject {selectedIds.length}</>}
                  </button>
                  <button onClick={bulkApprove} disabled={bulkBusy}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
                    {bulkBusy ? 'Approving…' : <><i className="ph ph-check mr-1"></i>Approve {selectedIds.length}</>}
                  </button>
                </>
              )}
            </div>
          )}

          {err && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              <i className="ph ph-warning mr-2"></i>{err}
            </div>
          )}

          {loading ? (
            <div className="text-center py-16 text-slate-500">
              <i className="ph ph-spinner-gap text-3xl animate-spin"></i>
            </div>
          ) : visibleRecords.length === 0 ? (
            <div className="text-center py-16 text-slate-500 bg-white/5 rounded-xl border border-slate-800/80">
              <i className="ph ph-tray text-4xl mb-2 block"></i>
              {search ? `No results for "${search}".` : `No ${tab} submissions.`}
            </div>
          ) : (
            <div className="space-y-4">
              {visibleRecords.map((rec) => (
                <RecordCard
                  key={rec.id}
                  rec={rec}
                  thumbnails={thumbnails}
                  selected={!!selected[rec.id]}
                  onToggleSelect={() => setSelected((s) => ({ ...s, [rec.id]: !s[rec.id] }))}
                  expanded={!!expanded[rec.id]}
                  onToggle={() => setExpanded((x) => ({ ...x, [rec.id]: !x[rec.id] }))}
                  onApprove={() => approve(rec)}
                  onStartReject={() => { setRejectingId(rec.id); setRejectReason(''); setExpanded((x) => ({ ...x, [rec.id]: true })); }}
                  onCancelReject={() => { setRejectingId(null); setRejectReason(''); }}
                  onSubmitReject={() => submitReject(rec)}
                  onReenroll={() => reenroll(rec)}
                  onPhoto={(url, caption) => setLightbox({ url, caption })}
                  onPrint={() => setPrintRec(rec)}
                  busy={working[rec.id]}
                  rejecting={rejectingId === rec.id}
                  rejectReason={rejectReason}
                  setRejectReason={setRejectReason}
                  showSelect={tab === 'pending'}
                />
              ))}
            </div>
          )}
        </>
        )}
        </div>

        {lightbox && (
          <div onClick={() => setLightbox(null)}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6 cursor-zoom-out">
            <div className="max-w-3xl max-h-full">
              <img src={lightbox.url} alt={lightbox.caption}
                className="max-w-full max-h-[80vh] rounded-lg shadow-2xl object-contain" />
              {lightbox.caption && (
                <div className="text-center text-slate-300 text-sm mt-3">{lightbox.caption}</div>
              )}
            </div>
          </div>
        )}

        {printRec && (
          <PrintFormModal rec={printRec} thumbnails={thumbnails} onClose={() => setPrintRec(null)} />
        )}

        {/* Print stylesheet — hides everything except the modal */}
        <style jsx global>{`
          @media print {
            body * { visibility: hidden !important; }
            .pg-print, .pg-print * { visibility: visible !important; }
            .pg-print { position: absolute !important; inset: 0 !important; background: white !important; color: black !important; }
            .pg-print img { max-height: 110px !important; }
            .pg-no-print { display: none !important; }
          }
        `}</style>
      </V2Layout>
    </>
  );
}

// ─── Live "now at the gate" tile (#13) ──────────────────────────────────────
// Polls the same TV feed and shows the latest 6 events as compact pills so
// admins watching pickup-admin can react to flagged events without opening
// the TV. Click an event → opens TV in a new tab.
function LiveGateTile() {
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer = null;
    const load = async () => {
      try {
        const r = await fetch('/api/pickup/tv/feed?limit=6');
        const j = await r.json();
        if (stop) return;
        if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
        setErr(null);
        setEvents(Array.isArray(j.events) ? j.events.slice(0, 6) : []);
      } catch (e) {
        if (!stop) setErr(e.message);
      } finally {
        if (!stop) timer = setTimeout(load, 4000);
      }
    };
    load();
    const tickInt = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { stop = true; if (timer) clearTimeout(timer); clearInterval(tickInt); };
  }, []);

  const flagged = useMemo(
    () => events.filter((e) => e.cardState && e.cardState !== 'green').length,
    [events]
  );

  // Force re-render every second so timestamps stay fresh
  void tick;

  if (err && events.length === 0) {
    return (
      <div className="mb-4 rounded-xl border border-slate-800 bg-white/5 px-4 py-3 text-xs text-slate-500">
        Live feed unavailable — {err}
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900/60 to-slate-950/60 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <h2 className="text-sm font-semibold text-white tracking-tight">Live at the gate</h2>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">last 6 pickups</span>
        </div>
        <div className="flex items-center gap-2">
          {flagged > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 border border-amber-500/30 font-semibold">
              {flagged} flagged
            </span>
          )}
          <a href="/pickup/tv" target="_blank" rel="noreferrer"
            className="text-[11px] text-brand-300 hover:text-brand-200 font-medium">
            <i className="ph ph-television-simple mr-1"></i>Open TV →
          </a>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="text-xs text-slate-500 py-4 text-center">No pickups yet today.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {events.map((e) => <LiveGatePill key={e.id} ev={e} />)}
        </div>
      )}
    </div>
  );
}

function LiveGatePill({ ev }) {
  const tone = ev.cardState === 'red' ? 'red'
    : ev.cardState === 'yellow' ? 'amber'
    : 'emerald';
  const dot = { red: 'bg-red-400', amber: 'bg-amber-400', emerald: 'bg-emerald-400' }[tone];
  const ring = {
    red: 'border-red-500/40 bg-red-500/8',
    amber: 'border-amber-500/40 bg-amber-500/8',
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
  }[tone];
  const ts = ev.scannedAt ? new Date(ev.scannedAt) : null;
  const ago = ts ? Math.max(0, Math.floor((Date.now() - ts.getTime()) / 1000)) : 0;
  const agoStr = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
  const stuNames = (ev.students || []).map((s) => s.name).filter(Boolean).slice(0, 3).join(', ');
  return (
    <div className={`flex items-center gap-3 rounded-lg border ${ring} px-3 py-2`}>
      <span className={`h-2 w-2 rounded-full ${dot} flex-shrink-0`}></span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white font-medium truncate">
          {ev.chaperone?.name || '—'}
        </div>
        <div className="text-[11px] text-slate-400 truncate">
          {stuNames || ev.decision} · {ev.gate}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[10px] text-slate-500 tabular-nums">{agoStr}</div>
        {ev.overrideCode && !ev.officerOverride && (
          <div className="text-[11px] font-mono font-bold text-amber-300 tabular-nums">{ev.overrideCode}</div>
        )}
      </div>
    </div>
  );
}

// ─── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, hint, tone = 'slate', icon }) {
  const tones = {
    slate:   'bg-white/5 border-slate-800',
    amber:   'bg-amber-500/10 border-amber-500/30',
    emerald: 'bg-emerald-500/10 border-emerald-500/30',
    red:     'bg-red-500/10 border-red-500/30',
    brand:   'bg-brand-500/10 border-brand-500/30',
  };
  const valueTones = {
    slate: 'text-white', amber: 'text-amber-200', emerald: 'text-emerald-200',
    red: 'text-red-200', brand: 'text-brand-200',
  };
  return (
    <div className={`border rounded-xl px-4 py-3 ${tones[tone] || tones.slate}`}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">{label}</div>
        {icon && <i className={`ph ${icon} text-slate-500`}></i>}
      </div>
      <div className={`text-2xl font-bold mt-1 ${valueTones[tone] || valueTones.slate}`}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    pending:  ['bg-amber-500/15 text-amber-300 border-amber-500/30',  'ph-clock'],
    approved: ['bg-emerald-500/15 text-emerald-300 border-emerald-500/30', 'ph-check-circle'],
    rejected: ['bg-red-500/15 text-red-300 border-red-500/30',        'ph-x-circle'],
  };
  const [cls, icon] = map[status] || map.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${cls}`}>
      <i className={`ph ${icon}`}></i>{status}
    </span>
  );
}

// ─── Record card ────────────────────────────────────────────────────────────
function RecordCard(props) {
  const {
    rec, thumbnails, selected, onToggleSelect, expanded, onToggle,
    onApprove, onStartReject, onCancelReject, onSubmitReject, onReenroll,
    onPhoto, onPrint, busy, rejecting, rejectReason, setRejectReason, showSelect,
  } = props;

  const enrichedStudents = (rec.students || []).map((s) => ({
    ...s,
    photoUrl: s.photoUrl || thumbnails[s.id] || thumbnails[`name:${s.name}`] || null,
  }));

  // Per-record device-enrollment summary
  const enrollSummary = useMemo(() => {
    if (rec.status !== 'approved') return null;
    const allocated = rec.allocatedChaperones || [];
    if (allocated.length === 0) return null;
    let ok = 0, fail = 0;
    allocated.forEach((a) => {
      const e = (rec.enrollment || []).find((x) => x.chaperoneId === a.chaperoneId);
      if (e?.ok) ok++; else fail++;
    });
    return { ok, fail, total: allocated.length };
  }, [rec]);

  return (
    <div className={`bg-white/5 border rounded-xl overflow-hidden transition-colors ${
      selected ? 'border-brand-500/50 ring-1 ring-brand-500/30' : 'border-slate-800'
    }`}>
      {/* Header strip */}
      <div className="px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {showSelect && (
            <input type="checkbox" checked={selected} onChange={onToggleSelect}
              className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus:ring-brand-500/40 flex-shrink-0" />
          )}
          <div className="w-10 h-10 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center font-bold flex-shrink-0">
            {(rec.guardian?.name || '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white truncate flex items-center gap-2 flex-wrap">
              {rec.guardian?.name || '—'}
              <StatusPill status={rec.status} />
              {enrollSummary && (
                <EnrollPill summary={enrollSummary} />
              )}
            </div>
            <div className="text-xs text-slate-500 truncate">
              {rec.guardian?.email} · {rec.guardian?.phone}
              <span className="mx-1.5 text-slate-700">·</span>
              <span title={fmtTime(rec.submittedAt)}>{timeAgo(rec.submittedAt)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-400 px-2 py-1 rounded bg-white/5 border border-slate-800">
            <i className="ph ph-graduation-cap mr-1"></i>{rec.students?.length || 0}
          </span>
          <span className="text-xs text-slate-400 px-2 py-1 rounded bg-white/5 border border-slate-800">
            <i className="ph ph-users mr-1"></i>{rec.chaperones?.length || 0}
          </span>
          <button onClick={onPrint}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10"
            title="Open printable form view">
            <i className="ph ph-printer mr-1"></i>Form
          </button>
          {rec.status === 'pending' && (
            <button onClick={onApprove} disabled={!!busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50">
              {busy === 'approve' ? '…' : <><i className="ph ph-check mr-1"></i>Approve</>}
            </button>
          )}
          <button onClick={onToggle}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
            <i className={`ph ${expanded ? 'ph-caret-up' : 'ph-caret-down'} mr-1`}></i>
            {expanded ? 'Collapse' : 'Details'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-800 px-5 py-5 space-y-5 bg-slate-950/40">
          {/* Submission metadata grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <MetaCell label="Submitted" value={fmtTime(rec.submittedAt)} />
            <MetaCell label="Reviewed" value={rec.reviewedAt ? fmtTime(rec.reviewedAt) : '—'} />
            <MetaCell label="Reviewer" value={rec.reviewedBy || '—'} mono />
            <MetaCell label="Token TTL" value={rec.tokenExp ? fmtTime(new Date(rec.tokenExp * 1000).toISOString()) : '—'} />
          </div>

          {/* Students */}
          <div>
            <SectionHeader icon="ph-graduation-cap" label={`Students (${enrichedStudents.length})`} />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {enrichedStudents.map((s) => (
                <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-slate-800">
                  {s.photoUrl ? (
                    <img src={s.photoUrl} alt={s.name}
                      onClick={() => onPhoto(s.photoUrl, `${s.name} (BINUS DB)`)}
                      className="w-14 h-14 rounded-lg object-cover flex-shrink-0 cursor-zoom-in border border-slate-700" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-slate-800 flex items-center justify-center text-slate-600 text-xs flex-shrink-0">
                      <i className="ph ph-user"></i>
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{s.name}</div>
                    <div className="text-xs text-slate-500 truncate">
                      ID {s.id}{s.homeroom ? ` · ${s.homeroom}` : ''}
                    </div>
                    {!s.photoUrl && (
                      <div className="text-[10px] text-amber-400 mt-0.5">
                        <i className="ph ph-warning"></i> No DB photo
                      </div>
                    )}
                    {s.dbName && s.dbName !== s.name && (
                      <div className="text-[10px] text-slate-500 mt-0.5" title="Name on file in BINUS DB">
                        DB: {s.dbName}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Chaperones */}
          <div>
            <SectionHeader icon="ph-users" label={`Authorized Adults (${rec.chaperones?.length || 0})`} />
            <div className="space-y-3">
              {(rec.chaperones || []).map((c, i) => {
                const allocated = rec.allocatedChaperones?.[i];
                const enrol = (rec.enrollment || []).find((e) => e.chaperoneId === allocated?.chaperoneId);
                return (
                  <ChaperoneRow key={c.tempId || i} c={c} index={i} allocated={allocated} enrol={enrol}
                    enrichedStudents={enrichedStudents} onPhoto={onPhoto} />
                );
              })}
            </div>
          </div>

          {/* Consent panel */}
          <div className="px-3 py-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-start gap-3">
            <i className="ph ph-signature text-emerald-400 mt-0.5"></i>
            <div className="flex-1 text-xs">
              <div className="text-slate-400">
                Consent signature:&nbsp;
                <strong className="text-white">{rec.guardian?.signatureRef || rec.consentSignature || '—'}</strong>
              </div>
              <div className="text-slate-500 mt-0.5">
                By submitting, the guardian acknowledged biometric processing of the
                listed adults strictly for school pickup verification, and authorises
                BINUS to retain face data for 12 months after which re-enrollment is
                required.
              </div>
            </div>
          </div>

          {/* Action bar */}
          {rec.status === 'pending' ? (
            rejecting ? (
              <div className="pt-2 border-t border-slate-800 space-y-2">
                <label className="text-xs font-medium text-red-300 block">
                  Rejection reason (visible to parent on follow-up):
                </label>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                  rows={2} placeholder="e.g. Chaperone face photos are blurry — please re-upload."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-red-500/50" />
                <div className="flex items-center justify-end gap-2">
                  <button onClick={onCancelReject} disabled={!!busy}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
                    Cancel
                  </button>
                  <button onClick={onSubmitReject} disabled={!!busy || rejectReason.trim().length < 4}
                    className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-40">
                    {busy === 'reject' ? 'Rejecting…' : 'Confirm rejection'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                <button onClick={onStartReject} disabled={!!busy}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 disabled:opacity-50">
                  <i className="ph ph-x mr-1"></i>Reject
                </button>
                <button onClick={onApprove} disabled={!!busy}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
                  {busy === 'approve' ? 'Approving…' : <><i className="ph ph-check mr-1"></i>Approve & enrol</>}
                </button>
              </div>
            )
          ) : (
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800 flex-wrap">
              <div className="text-xs text-slate-500">
                {rec.status === 'approved' ? 'Approved' : 'Rejected'} {fmtTime(rec.reviewedAt)} by{' '}
                <span className="font-mono text-slate-400">{rec.reviewedBy || '—'}</span>
                {rec.rejectionReason && <div className="mt-1 text-red-400">Reason: {rec.rejectionReason}</div>}
                {rec.approvalNotes && <div className="mt-1 text-emerald-400">Notes: {rec.approvalNotes}</div>}
                {rec.lastReenrollAt && (
                  <div className="mt-1 text-slate-500">Last re-push: {fmtTime(rec.lastReenrollAt)}</div>
                )}
              </div>
              {rec.status === 'approved' && rec.allocatedChaperones?.length > 0 && (
                <button onClick={onReenroll} disabled={!!busy}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-500/10 border border-brand-500/30 text-brand-300 hover:bg-brand-500/20 disabled:opacity-50">
                  {busy === 'reenroll' ? 'Re-enrolling…' : (
                    <><i className="ph ph-fingerprint mr-1"></i>Re-push to devices</>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ icon, label }) {
  return (
    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
      {icon && <i className={`ph ${icon}`}></i>}{label}
    </div>
  );
}

function MetaCell({ label, value, mono }) {
  return (
    <div className="px-3 py-2 rounded-lg bg-white/5 border border-slate-800">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className={`text-xs text-slate-200 mt-0.5 truncate ${mono ? 'font-mono' : ''}`} title={value}>{value}</div>
    </div>
  );
}

function EnrollPill({ summary }) {
  const { ok, fail, total } = summary;
  if (total === 0) return null;
  if (fail === 0) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
      <i className="ph ph-fingerprint mr-0.5"></i>{ok}/{total} enrolled
    </span>;
  }
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
    <i className="ph ph-warning mr-0.5"></i>{ok}/{total} enrolled
  </span>;
}

function ChaperoneRow({ c, index, allocated, enrol, enrichedStudents, onPhoto }) {
  return (
    <div className="bg-white/5 border border-slate-800 rounded-lg p-4">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-300 flex items-center justify-center text-xs font-bold">
              {index + 1}
            </span>
            <span className="text-sm font-semibold text-white">{c.name}</span>
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
              {REL_LABEL[c.relation] || c.relation}
            </span>
            {allocated && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                #{allocated.employeeNo}
              </span>
            )}
            {allocated && enrol && (
              enrol.ok ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  title={(enrol.devices || []).map((d) => `${d.name}: ${d.ok ? 'ok' : d.error}`).join('\n')}>
                  <i className="ph ph-fingerprint mr-0.5"></i>enrolled
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30"
                  title={(enrol.devices || []).map((d) => `${d.name}: ${d.ok ? 'ok' : d.error}`).join('\n') || enrol.error || ''}>
                  <i className="ph ph-warning mr-0.5"></i>enroll failed
                </span>
              )
            )}
          </div>
          <div className="text-xs text-slate-500 break-all">
            <i className="ph ph-phone mr-0.5"></i>{c.phone}
            {c.email && <> · <i className="ph ph-envelope mr-0.5"></i>{c.email}</>}
            {c.idNumber && <> · <i className="ph ph-identification-card mr-0.5"></i>{c.idNumber}</>}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(c.authorizedStudentIds || []).map((sid) => {
              const s = enrichedStudents.find((x) => x.id === sid);
              return (
                <span key={sid}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-300 border border-brand-500/30">
                  ✓ {s?.name || sid}
                </span>
              );
            })}
          </div>
          {/* Per-device enrollment status */}
          {enrol && enrol.devices && enrol.devices.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {enrol.devices.map((d, k) => (
                <span key={k} title={d.error || ''}
                  className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                    d.ok
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                      : 'bg-red-500/10 text-red-300 border-red-500/30'
                  }`}>
                  {d.ok ? '✓' : '✗'} {d.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Side-by-side: BINUS student vs chaperone faces */}
        <div className="flex items-center gap-3">
          {(() => {
            const sid = (c.authorizedStudentIds || [])[0];
            const s = enrichedStudents.find((x) => x.id === sid);
            return s ? (
              <div className="text-center">
                <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Picks up</div>
                {s.photoUrl ? (
                  <img src={s.photoUrl} alt={s.name}
                    onClick={() => onPhoto(s.photoUrl, `${s.name} (BINUS DB)`)}
                    className="w-16 h-16 rounded-lg object-cover border-2 border-slate-700 cursor-zoom-in" />
                ) : (
                  <div className="w-16 h-16 rounded-lg bg-slate-800 flex items-center justify-center text-slate-600">
                    <i className="ph ph-user-circle text-2xl"></i>
                  </div>
                )}
              </div>
            ) : null;
          })()}
          <div className="text-slate-600 text-2xl font-thin px-1">↔</div>
          <div className="text-center">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Chaperone faces</div>
            <div className="flex gap-1">
              {(c.faceUrls || []).length === 0 ? (
                <div className="w-16 h-16 rounded-lg bg-slate-800 flex items-center justify-center text-slate-600 text-xs">
                  no photos
                </div>
              ) : (c.faceUrls).map((u, j) => (
                <img key={j} src={u} alt={`${c.name} ${j + 1}`}
                  onClick={() => onPhoto(u, `${c.name} (parent-supplied)`)}
                  className="w-16 h-16 rounded-lg object-cover border-2 border-orange-500/40 cursor-zoom-in" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Printable form preview ─────────────────────────────────────────────────
function PrintFormModal({ rec, thumbnails, onClose }) {
  const enrichedStudents = (rec.students || []).map((s) => ({
    ...s,
    photoUrl: s.photoUrl || thumbnails[s.id] || thumbnails[`name:${s.name}`] || null,
  }));
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center p-4 sm:p-8 overflow-auto">
      <div className="pg-print bg-white text-slate-900 rounded-xl max-w-3xl w-full p-8 shadow-2xl">
        {/* Toolbar — hidden in print */}
        <div className="pg-no-print flex items-center justify-between mb-6">
          <div className="text-xs text-slate-500">Filled-form preview · BINUS PickupGuard</div>
          <div className="flex gap-2">
            <button onClick={() => window.print()}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-700">
              <i className="ph ph-printer mr-1"></i>Print / Save PDF
            </button>
            <button onClick={onClose}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-200 text-slate-800 hover:bg-slate-300">
              Close
            </button>
          </div>
        </div>

        {/* Letterhead */}
        <div className="border-b-2 border-slate-900 pb-4 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-orange-600 font-bold">BINUS School Simprug</div>
              <div className="text-2xl font-bold mt-1">PickupGuard Authorization Form</div>
            </div>
            <div className="text-right text-xs text-slate-600">
              <div>Submission ID:&nbsp;<span className="font-mono">{rec.id}</span></div>
              <div>Submitted:&nbsp;<span className="font-mono">{fmtTime(rec.submittedAt)}</span></div>
              <div>Status:&nbsp;<span className="font-mono uppercase">{rec.status}</span></div>
            </div>
          </div>
        </div>

        {/* Section 1 — Guardian */}
        <Section title="1. Guardian / Submitter">
          <Field label="Full name"  value={rec.guardian?.name} />
          <Field label="Email"      value={rec.guardian?.email} />
          <Field label="Phone"      value={rec.guardian?.phone} />
        </Section>

        {/* Section 2 — Students */}
        <Section title={`2. Students under guardian (${enrichedStudents.length})`}>
          <table className="w-full text-sm border border-slate-300">
            <thead className="bg-slate-100 text-xs uppercase">
              <tr>
                <th className="text-left p-2 border border-slate-300">#</th>
                <th className="text-left p-2 border border-slate-300">Photo</th>
                <th className="text-left p-2 border border-slate-300">Name</th>
                <th className="text-left p-2 border border-slate-300">Student ID</th>
                <th className="text-left p-2 border border-slate-300">Class</th>
              </tr>
            </thead>
            <tbody>
              {enrichedStudents.map((s, i) => (
                <tr key={s.id}>
                  <td className="p-2 border border-slate-300 align-top">{i + 1}</td>
                  <td className="p-2 border border-slate-300 align-top">
                    {s.photoUrl
                      ? <img src={s.photoUrl} alt="" className="w-12 h-12 object-cover rounded" />
                      : <span className="text-slate-400 text-xs">—</span>}
                  </td>
                  <td className="p-2 border border-slate-300 align-top font-semibold">{s.name}</td>
                  <td className="p-2 border border-slate-300 align-top font-mono text-xs">{s.id}</td>
                  <td className="p-2 border border-slate-300 align-top">{s.homeroom || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* Section 3 — Chaperones */}
        <Section title={`3. Authorised pickup persons (${rec.chaperones?.length || 0})`}>
          {(rec.chaperones || []).map((c, i) => (
            <div key={i} className="border border-slate-300 rounded-lg p-3 mb-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="text-sm">
                  <div className="font-bold text-base">
                    {i + 1}. {c.name}
                    <span className="ml-2 text-xs uppercase tracking-wider text-orange-700">
                      ({REL_LABEL[c.relation] || c.relation})
                    </span>
                  </div>
                  <div className="text-xs text-slate-700 mt-1 space-y-0.5">
                    <div>Phone: <span className="font-mono">{c.phone}</span></div>
                    {c.email && <div>Email: <span className="font-mono">{c.email}</span></div>}
                    {c.idNumber && <div>Government ID: <span className="font-mono">{c.idNumber}</span></div>}
                  </div>
                  <div className="text-xs mt-1.5">
                    <span className="text-slate-600">Authorised to pick up: </span>
                    <strong>
                      {(c.authorizedStudentIds || [])
                        .map((sid) => enrichedStudents.find((x) => x.id === sid)?.name || sid)
                        .join(', ') || '—'}
                    </strong>
                  </div>
                  {rec.allocatedChaperones?.[i] && (
                    <div className="text-xs mt-1 text-emerald-700">
                      Chaperone ID: <span className="font-mono">#{rec.allocatedChaperones[i].employeeNo}</span>
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  {(c.faceUrls || []).map((u, j) => (
                    <img key={j} src={u} alt="" className="w-20 h-20 object-cover rounded border border-slate-300" />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </Section>

        {/* Section 4 — Consent */}
        <Section title="4. Consent & signature">
          <p className="text-xs text-slate-700 leading-relaxed mb-2">
            By submitting this form I consent to BINUS Simprug processing the
            facial biometric data of the listed adults strictly for the purpose
            of verifying authorised pickup at school exits. Face images are stored
            for 12 months and may be revoked at any time by contacting the school.
          </p>
          <Field label="Electronic signature (typed)"
            value={rec.guardian?.signatureRef || rec.consentSignature || '—'} mono />
          <Field label="Submitted at" value={fmtTime(rec.submittedAt)} />
          {rec.reviewedAt && (
            <>
              <Field label={rec.status === 'approved' ? 'Approved at' : 'Rejected at'}
                value={fmtTime(rec.reviewedAt)} />
              <Field label="Reviewer" value={rec.reviewedBy || '—'} mono />
            </>
          )}
          {rec.rejectionReason && (
            <Field label="Rejection reason" value={rec.rejectionReason} />
          )}
        </Section>

        <div className="text-[10px] text-slate-400 text-center mt-8 pt-4 border-t border-slate-200">
          BINUS School Simprug · PickupGuard · Generated {fmtTime(new Date().toISOString())}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-bold uppercase tracking-wider text-orange-700 mb-2">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div className="flex border-b border-slate-200 py-1.5 text-sm">
      <div className="w-48 text-slate-600 text-xs uppercase tracking-wider pt-0.5">{label}</div>
      <div className={`flex-1 text-slate-900 ${mono ? 'font-mono' : 'font-medium'}`}>{value || '—'}</div>
    </div>
  );
}
