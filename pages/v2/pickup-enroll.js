/**
 * /v2/pickup-enroll
 *
 * Card-based enrolment board.
 *
 * - Only chaperones from APPROVED forms appear here (chaperone docs are
 *   created on approval, so this is automatically the case).
 * - Each chaperone is one big card with face avatar, status ring, class,
 *   authorised students, per-device chips, and an Enrol button.
 * - Cards are grouped under collapsible class headers.
 * - Designed to be scannable: green ring = done, amber = partial, red =
 *   never enrolled, violet = needs photo first.
 */
import Head from 'next/head';
import { useEffect, useMemo, useState, useCallback } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import TerminalPicker from '../../components/v2/pickup/TerminalPicker';
import EnrollmentRunOverlay from '../../components/v2/pickup/EnrollmentRunOverlay';

const REL_LABEL = {
  parent: 'Parent', mother: 'Mother', father: 'Father',
  guardian: 'Guardian', driver: 'Driver', nanny: 'Nanny',
  grandparent: 'Grandparent', sibling: 'Sibling', other: 'Other',
};

const FILTERS = [
  { key: 'all',          label: 'All',           icon: 'ph-list' },
  { key: 'needs-enroll', label: 'Never enrolled', icon: 'ph-x-circle' },
  { key: 'partial',      label: 'Partial',        icon: 'ph-circle-half' },
  { key: 'enrolled',     label: 'Fully enrolled', icon: 'ph-check-circle' },
  { key: 'no-photos',    label: 'Need photo',     icon: 'ph-camera-slash' },
];

export default function PickupEnrollPage() {
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedGrade, setSelectedGrade] = useState('all');
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [lightbox, setLightbox] = useState(null);
  // Per-CLASS terminal-IP override (homeroom -> ip[] | null/undefined = use defaults)
  // Defaults are "all configured + enabled terminals visible to this group"
  // (computed in resolveDefaultsFor).
  const [classTerminalOverrides, setClassTerminalOverrides] = useState({});
  // Active enrollment run (drives the overlay). null = closed.
  const [activeRun, setActiveRun] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/pickup/admin/enrollment-board', { credentials: 'include' })
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok) setErr(j.error || `HTTP ${r.status}`);
        else { setBoard(j); setErr(null); }
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const showToast = (kind, message, ttl = 4000) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), ttl);
  };

  const filteredGroups = useMemo(() => {
    if (!board) return [];
    const q = search.trim().toLowerCase();
    return board.groups
      .filter((g) => selectedGrade === 'all' || g.grade === selectedGrade)
      .map((g) => ({
        ...g,
        chaperones: g.chaperones.filter((c) => {
          if (q) {
            const hay = [c.name, c.employeeNo || '', c.phone || '',
              ...c.authorizedStudents.map((s) => s.name)].join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
          }
          if (filter === 'needs-enroll') return c.needsEnroll;
          if (filter === 'partial')      return !c.allEnrolled && c.enrolledDeviceCount > 0;
          if (filter === 'enrolled')     return c.allEnrolled;
          if (filter === 'no-photos')    return c.noPhotos;
          return true;
        }),
      }))
      .filter((g) => g.chaperones.length > 0);
  }, [board, filter, search, selectedGrade]);

  // Default terminals for a given class group: every configured + enabled
  // terminal whose gradeScopes include the class's grade (or has empty
  // scopes = shared gate). If nothing matches, fall back to all terminals
  // so operators always see SOMETHING pre-selected.
  const resolveDefaultsForGroup = useCallback((group) => {
    const all = board?.devices || [];
    if (all.length === 0) return [];
    const grade = String(group.grade || '');
    const matched = all.filter((d) =>
      !d.gradeScopes || d.gradeScopes.length === 0 || d.gradeScopes.map(String).includes(grade)
    );
    return (matched.length ? matched : all).map((d) => d.ip);
  }, [board]);

  // Resolve which terminals will be hit for a given chaperone. Driven by
  // the chaperone's class override (or that class's defaults).
  const resolveTerminalsFor = useCallback((c) => {
    const all = c.enrollment?.allDevices || [];
    const homeroom = ((c.studentClasses || [])[0] || '— UNASSIGNED').toUpperCase();
    let ips = classTerminalOverrides[homeroom];
    if (ips === undefined || ips === null) {
      // Compute defaults: terminals whose gradeScopes match this chaperone's
      // grades, falling back to every available device.
      const matched = all.filter((d) => d.isMatched);
      ips = (matched.length ? matched : all).map((d) => d.ip);
    }
    const ipSet = new Set(ips);
    return all.filter((d) => ipSet.has(d.ip)).map((d) => ({
      ip: d.ip, name: d.name, isMatched: d.isMatched,
    }));
  }, [classTerminalOverrides]);

  const visibleEnrollableIds = useMemo(() => {
    const ids = [];
    filteredGroups.forEach((g) => g.chaperones.forEach((c) => {
      if (!c.noPhotos && resolveTerminalsFor(c).length > 0) ids.push(c.id);
    }));
    return ids;
  }, [filteredGroups, resolveTerminalsFor]);

  const allSelected = visibleEnrollableIds.length > 0 && visibleEnrollableIds.every((id) => selected[id]);
  const selectedCount = Object.values(selected).filter(Boolean).length;

  const toggleAll = () => {
    if (allSelected) setSelected({});
    else {
      const next = {};
      visibleEnrollableIds.forEach((id) => { next[id] = true; });
      setSelected(next);
    }
  };

  // Open the live overlay with an arbitrary set of chaperones. Each entry
  // carries its resolved terminal IPs so the overlay knows what to push.
  const startRun = (chaperones) => {
    if (chaperones.length === 0) return;
    const queue = chaperones
      .map((c) => ({ id: c.id, name: c.name, terminals: resolveTerminalsFor(c) }))
      .filter((q) => q.terminals.length > 0);
    if (queue.length === 0) {
      showToast('warn', 'No terminals selected for any of the chosen chaperones.');
      return;
    }
    setBusy(true);
    setActiveRun(queue);
  };

  const onRunDone = (runs) => {
    const okCount = runs.filter((r) => r.status === 'success').length;
    const failCount = runs.filter((r) => r.status === 'failed' || r.status === 'partial').length;
    showToast(
      failCount === 0 ? 'success' : 'warn',
      `${okCount}/${runs.length} chaperones enrolled${failCount > 0 ? ` · ${failCount} need attention` : ''}`,
    );
    setActiveRun(null);
    setBusy(false);
    setBusyId(null);
    setSelected({});
    load();
  };

  const enrollSelected = () => {
    const ids = new Set(Object.keys(selected).filter((id) => selected[id]));
    if (ids.size === 0) return;
    const chaperones = [];
    filteredGroups.forEach((g) => g.chaperones.forEach((c) => { if (ids.has(c.id)) chaperones.push(c); }));
    startRun(chaperones);
  };

  const enrollOne = (c) => {
    setBusyId(c.id);
    startRun([c]);
  };

  const enrollGroup = (group) => {
    const chaperones = group.chaperones.filter((c) => !c.noPhotos && resolveTerminalsFor(c).length > 0);
    if (chaperones.length === 0) {
      showToast('warn', `${group.homeroom}: nothing to enrol.`);
      return;
    }
    startRun(chaperones);
  };

  const grades = useMemo(() => {
    if (!board) return [];
    return [...new Set(board.groups.map((g) => g.grade))].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }, [board]);

  return (
    <V2Layout>
      <Head><title>Chaperone Enrolment · BINUS Pickup System</title></Head>

      <div className="space-y-5">
        {/* ── Header ───────────────────────────────────────── */}
        <div className="rounded-2xl bg-gradient-to-br from-brand-500/10 via-slate-900/40 to-slate-900/40 border border-brand-500/20 p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center flex-shrink-0">
                <i className="ph ph-fingerprint text-brand-300 text-2xl"></i>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">Chaperone Enrolment</h1>
                <p className="text-sm text-slate-300 mt-1 max-w-2xl">
                  Push <strong className="text-orange-300">approved chaperones</strong> (parents, drivers, nannies)
                  onto the right grade-level Hikvision terminal. One card per chaperone — green check = enrolled.
                </p>
                <p className="text-[11px] text-slate-500 mt-1.5 flex items-center gap-1.5">
                  <i className="ph ph-info"></i>
                  Students are enrolled separately via the BINUS class roster — this page is chaperones only.
                </p>
              </div>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={load}
                disabled={loading}
                className="px-3 py-2 text-sm rounded-lg bg-slate-800/70 border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                title="Refresh board"
              >
                <i className={`ph ph-arrows-clockwise ${loading ? 'animate-spin' : ''}`}></i>
              </button>
              <button
                onClick={enrollSelected}
                disabled={busy || selectedCount === 0}
                className="px-4 py-2 text-sm rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-brand-500/20"
              >
                {busy ? <i className="ph ph-spinner-gap animate-spin mr-1"></i> : <i className="ph ph-fingerprint mr-1"></i>}
                Enrol selected ({selectedCount})
              </button>
            </div>
          </div>

          {/* Compact device strip inside header */}
          {board && (
            <div className="mt-4 pt-4 border-t border-slate-800 flex items-center gap-3 flex-wrap text-[11px]">
              <span className="text-slate-500 uppercase tracking-wider font-semibold">Terminals:</span>
              {board.devices.length === 0 && <span className="text-amber-400">No devices configured</span>}
              {board.devices.map((d) => (
                <span key={d.ip}
                  title={`${d.ip} — ${d.gradeScopes.length === 0 ? 'all grades' : `grades ${d.gradeScopes.join(', ')}`}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900/80 border border-slate-700/60 text-slate-300">
                  <i className="ph ph-cpu text-brand-300/70"></i>
                  <span className="font-medium">{d.name.replace(/\s*\(.*\)\s*$/, '')}</span>
                  {d.section && <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-brand-500/10 text-brand-200 font-mono">{d.section}</span>}
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-400 font-mono">
                    {d.gradeScopes.length === 0 ? 'all' : `g${d.gradeScopes.join(',')}`}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Stats ───────────────────────────────────────── */}
        {board && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard active={filter === 'all'}          onClick={() => setFilter('all')}          label="All chaperones"  value={board.summary.totalChaperones}    icon="ph-users-three"  tone="slate" />
            <StatCard active={filter === 'enrolled'}     onClick={() => setFilter('enrolled')}     label="Fully enrolled"  value={board.summary.fullyEnrolled}      icon="ph-check-circle" tone="emerald" />
            <StatCard active={filter === 'partial'}      onClick={() => setFilter('partial')}      label="Partial"         value={board.summary.partiallyEnrolled}  icon="ph-circle-half"  tone="amber" />
            <StatCard active={filter === 'needs-enroll'} onClick={() => setFilter('needs-enroll')} label="Never enrolled"  value={board.summary.neverEnrolled}      icon="ph-x-circle"     tone="rose" />
            <StatCard active={filter === 'no-photos'}    onClick={() => setFilter('no-photos')}    label="Need photo"      value={board.summary.awaitingPhotos}     icon="ph-camera-slash" tone="violet"
              hint="Chaperone face photo missing — admin can upload on Onboarding Review." />
          </div>
        )}

        {/* ── Toolbar ─────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-slate-900/40 border border-slate-800">
          <div className="flex gap-1 flex-wrap">
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={`text-xs px-3 py-1.5 rounded-md border inline-flex items-center gap-1.5 ${
                  filter === f.key
                    ? 'bg-brand-500 border-brand-400 text-white'
                    : 'bg-slate-800/40 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}>
                <i className={`ph ${f.icon}`}></i>{f.label}
              </button>
            ))}
          </div>
          <div className="h-6 w-px bg-slate-800 mx-1"></div>
          <select
            value={selectedGrade}
            onChange={(e) => setSelectedGrade(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-slate-200"
          >
            <option value="all">All grades</option>
            {grades.map((g) => <option key={g} value={g}>Grade {g}</option>)}
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <i className="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm"></i>
            <input
              placeholder="Search name, phone, employeeNo, or student…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-xs pl-8 pr-3 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-slate-200 placeholder-slate-500"
            />
          </div>
          {visibleEnrollableIds.length > 0 && (
            <button onClick={toggleAll}
              className="text-xs px-3 py-1.5 rounded-md bg-slate-800/60 border border-slate-700 text-slate-300 hover:bg-slate-800">
              {allSelected ? 'Clear' : `Select all visible (${visibleEnrollableIds.length})`}
            </button>
          )}
        </div>

        {/* ── Body ────────────────────────────────────────── */}
        {err && (
          <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
            <i className="ph ph-warning-circle mr-1"></i>{err}
          </div>
        )}
        {!err && loading && !board && (
          <div className="p-12 text-center text-slate-500">
            <i className="ph ph-spinner-gap animate-spin text-3xl"></i>
            <div className="mt-2 text-sm">Loading enrolment board…</div>
          </div>
        )}
        {!err && board && filteredGroups.length === 0 && (
          <div className="p-16 text-center rounded-xl bg-slate-900/40 border border-slate-800">
            <i className="ph ph-confetti text-5xl text-emerald-400/60"></i>
            <div className="mt-3 text-base font-semibold text-slate-300">
              {board.summary.totalChaperones === 0
                ? 'No approved chaperones yet'
                : 'No chaperones match these filters'}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {board.summary.totalChaperones === 0
                ? <>Approve a parent submission on the <a className="underline text-brand-300" href="/v2/pickup-admin">Onboarding Review</a> page first.</>
                : 'Try clearing the search or switching filter.'}
            </div>
          </div>
        )}

        {filteredGroups.map((group) => {
          const isCollapsed = collapsed[group.homeroom];
          const pendingCount = group.chaperones.filter((c) => !c.allEnrolled && !c.noPhotos && resolveTerminalsFor(c).length > 0).length;
          const doneCount = group.chaperones.filter((c) => c.allEnrolled).length;
          const groupAllDevices = (board?.devices || []).map((d) => ({
            name: d.name,
            ip: d.ip,
            section: d.section || null,
            gradeScopes: d.gradeScopes || [],
            isMatched: !d.gradeScopes || d.gradeScopes.length === 0
              || d.gradeScopes.map(String).includes(String(group.grade || '')),
            ok: false, attempted: false, error: null,
          }));
          const groupDefaults = resolveDefaultsForGroup(group);
          const groupSelectedIps = classTerminalOverrides[group.homeroom];
          const effectiveSelected = groupSelectedIps !== undefined && groupSelectedIps !== null
            ? groupSelectedIps
            : groupDefaults;
          return (
            <section key={group.homeroom} className="rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden">
              {/* Group header */}
              <header className="px-5 py-3.5 flex items-center justify-between gap-3 flex-wrap bg-gradient-to-r from-brand-500/10 to-transparent border-b border-slate-800">
                <button
                  onClick={() => setCollapsed((s) => ({ ...s, [group.homeroom]: !isCollapsed }))}
                  className="flex items-center gap-3 group flex-1 min-w-0 text-left"
                >
                  <i className={`ph ph-caret-down text-slate-400 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}></i>
                  {(() => {
                    const isUnassigned = /UNASSIGNED/i.test(group.homeroom);
                    const badge = isUnassigned ? '?' : group.homeroom;
                    const label = isUnassigned ? 'Unassigned' : group.homeroom;
                    return (
                      <>
                        <div className="w-10 h-10 rounded-lg bg-brand-500/20 border border-brand-500/40 flex items-center justify-center text-brand-200 font-bold text-sm flex-shrink-0 overflow-hidden">
                          <span className="truncate px-1">{badge}</span>
                        </div>
                        <div className="min-w-0">
                          <div className="text-lg font-bold text-white truncate">
                            Class {label}
                            {!isUnassigned && (
                              <span className="ml-2 text-xs font-normal text-slate-400">Grade {group.grade}</span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-3 flex-wrap">
                            <span><i className="ph ph-users mr-1"></i>{group.chaperones.length} chaperone{group.chaperones.length !== 1 ? 's' : ''}</span>
                            {doneCount > 0 && <span className="text-emerald-400"><i className="ph ph-check-circle mr-1"></i>{doneCount} enrolled</span>}
                            {pendingCount > 0 && <span className="text-amber-400"><i className="ph ph-clock mr-1"></i>{pendingCount} pending</span>}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </button>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {/* Class-level terminal picker (far right of class card) */}
                  {groupAllDevices.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold hidden sm:inline">
                        <i className="ph ph-cpu mr-1"></i>Terminals
                      </span>
                      <TerminalPicker
                        allDevices={groupAllDevices}
                        selectedIps={groupSelectedIps}
                        defaultIps={groupDefaults}
                        onChange={(ips) => setClassTerminalOverrides((m) => ({ ...m, [group.homeroom]: ips }))}
                        align="right"
                      />
                    </div>
                  )}
                  {pendingCount > 0 && (
                    <button onClick={() => enrollGroup(group)}
                      disabled={busy || effectiveSelected.length === 0}
                      title={effectiveSelected.length === 0 ? 'Pick at least one terminal' : ''}
                      className="text-xs px-3.5 py-2 rounded-lg bg-brand-500 text-white font-semibold hover:bg-brand-600 disabled:opacity-50 shadow-md shadow-brand-500/20">
                      <i className="ph ph-fingerprint mr-1"></i>
                      Enrol class ({pendingCount})
                    </button>
                  )}
                </div>
              </header>

              {!isCollapsed && (
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
                  {group.chaperones.map((c) => (
                    <ChaperoneCard
                      key={c.id}
                      c={c}
                      checked={!!selected[c.id]}
                      onCheck={(v) => setSelected((s) => ({ ...s, [c.id]: v }))}
                      onEnroll={() => enrollOne(c)}
                      onPhoto={() => c.facePhotoUrl && setLightbox({ url: c.facePhotoUrl, caption: c.name })}
                      busy={busy}
                      busyHere={busyId === c.id}
                      resolvedTerminalCount={resolveTerminalsFor(c).length}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center cursor-zoom-out p-6">
          <div className="max-w-2xl">
            <img src={lightbox.url} alt={lightbox.caption} className="max-h-[80vh] rounded-lg shadow-2xl" />
            <div className="mt-3 text-center text-white text-sm">{lightbox.caption}</div>
          </div>
        </div>
      )}

      {/* Live enrollment run overlay */}
      {activeRun && (
        <EnrollmentRunOverlay
          queue={activeRun}
          onClose={() => { setActiveRun(null); setBusy(false); setBusyId(null); }}
          onDone={onRunDone}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-2xl border text-sm max-w-sm ${
          toast.kind === 'success' ? 'bg-emerald-500/95 border-emerald-400 text-white'
          : toast.kind === 'warn'  ? 'bg-amber-500/95 border-amber-400 text-white'
          : 'bg-rose-500/95 border-rose-400 text-white'
        }`}>
          <i className={`ph ${
            toast.kind === 'success' ? 'ph-check-circle' :
            toast.kind === 'warn'    ? 'ph-warning' : 'ph-x-circle'
          } mr-2`}></i>
          {toast.message}
        </div>
      )}
    </V2Layout>
  );
}

function StatCard({ label, value, icon, tone, hint, active, onClick }) {
  const tones = {
    slate:   { bg: 'from-slate-800/40 to-slate-900/40', border: 'border-slate-800', text: 'text-slate-300', activeBorder: 'border-slate-500' },
    emerald: { bg: 'from-emerald-500/10 to-emerald-900/10', border: 'border-emerald-500/30', text: 'text-emerald-300', activeBorder: 'border-emerald-400' },
    amber:   { bg: 'from-amber-500/10 to-amber-900/10', border: 'border-amber-500/30', text: 'text-amber-300', activeBorder: 'border-amber-400' },
    rose:    { bg: 'from-rose-500/10 to-rose-900/10', border: 'border-rose-500/30', text: 'text-rose-300', activeBorder: 'border-rose-400' },
    violet:  { bg: 'from-violet-500/10 to-violet-900/10', border: 'border-violet-500/30', text: 'text-violet-300', activeBorder: 'border-violet-400' },
  };
  const t = tones[tone] || tones.slate;
  return (
    <button onClick={onClick} title={hint || ''}
      className={`text-left rounded-xl bg-gradient-to-br border p-3 transition-all hover:scale-[1.02] ${
        t.bg} ${t.text} ${active ? `${t.activeBorder} ring-2 ring-offset-2 ring-offset-slate-950 ring-current/30` : t.border
      }`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider opacity-80 font-semibold">{label}</span>
        <i className={`ph ${icon} text-base opacity-60`}></i>
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {hint && <div className="text-[10px] opacity-60 mt-1 leading-tight">{hint}</div>}
    </button>
  );
}

function ChaperoneCard({
  c, checked, onCheck, onEnroll, onPhoto, busy, busyHere,
  resolvedTerminalCount,
}) {
  const allDevices = c.enrollment?.allDevices || [];
  const ringClass =
    c.noPhotos                          ? 'ring-violet-500/60' :
    c.allEnrolled                       ? 'ring-emerald-500/70' :
    c.enrolledDeviceCount > 0           ? 'ring-amber-500/60' :
    allDevices.length === 0             ? 'ring-slate-700' :
                                          'ring-rose-500/60';

  const statusBadge =
    c.noPhotos                          ? { label: 'NEEDS PHOTO', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/40', icon: 'ph-camera-slash' } :
    c.allEnrolled                       ? { label: 'ENROLLED',    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', icon: 'ph-check-circle' } :
    c.enrolledDeviceCount > 0           ? { label: 'PARTIAL',     cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40', icon: 'ph-circle-half' } :
    allDevices.length === 0             ? { label: 'NO TERMINAL', cls: 'bg-slate-700/40 text-slate-400 border-slate-600', icon: 'ph-warning' } :
                                          { label: 'NOT ENROLLED', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40', icon: 'ph-x-circle' };

  const canEnroll = !c.noPhotos && resolvedTerminalCount > 0;

  return (
    <div className={`relative rounded-xl border bg-gradient-to-br from-slate-900/70 to-slate-900/30 overflow-hidden transition-all ${
      checked ? 'border-brand-400 ring-2 ring-brand-500/30' : 'border-slate-800 hover:border-slate-700'
    }`}>
      {/* Top ribbon: select + status */}
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            disabled={!canEnroll}
            className="w-4 h-4 rounded accent-brand-500 disabled:opacity-30 disabled:cursor-not-allowed"
          />
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
            {canEnroll ? 'Select' : 'Locked'}
          </span>
        </label>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border inline-flex items-center gap-1 ${statusBadge.cls}`}>
          <i className={`ph ${statusBadge.icon}`}></i>{statusBadge.label}
        </span>
      </div>

      {/* Body: avatar + identity */}
      <div className="px-4 pb-3 flex gap-3">
        <button
          onClick={onPhoto}
          disabled={!c.facePhotoUrl}
          className={`relative w-20 h-20 rounded-xl overflow-hidden ring-4 ${ringClass} ring-offset-2 ring-offset-slate-950 flex-shrink-0 ${
            c.facePhotoUrl ? 'cursor-zoom-in hover:scale-105 transition-transform' : 'cursor-default'
          }`}
          title={[
            c.employeeNo ? `Hikvision #${c.employeeNo}` : null,
            c.facePhotoUrl ? 'Click to view full photo' : 'No face photo',
          ].filter(Boolean).join(' · ')}
        >
          {c.facePhotoUrl ? (
            <img src={c.facePhotoUrl} alt={c.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-violet-500/10 flex items-center justify-center">
              <i className="ph ph-user-circle text-violet-300 text-3xl"></i>
            </div>
          )}
          {c.photoCount > 1 && (
            <span className="absolute bottom-0.5 right-0.5 text-[9px] font-mono px-1 py-0 rounded bg-black/70 text-white">
              ×{c.photoCount}
            </span>
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="text-base font-bold text-white truncate" title={c.name}>{c.name}</div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
              {REL_LABEL[c.relation] || c.relation}
            </span>
          </div>
          {c.phone && (
            <div className="text-[11px] text-slate-400 mt-1.5 truncate">
              <i className="ph ph-phone text-slate-500 mr-1"></i>{c.phone}
            </div>
          )}
          {c.guardianName && c.guardianName !== c.name && (
            <div className="text-[10px] text-slate-500 mt-0.5 truncate" title={`Form submitted by: ${c.guardianName}`}>
              <i className="ph ph-user mr-1"></i>via {c.guardianName}
            </div>
          )}
        </div>
      </div>

      {/* Picks-up section */}
      {c.authorizedStudents.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-800/60 bg-slate-900/40">
          <div className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold mb-1 flex items-center gap-1">
            <i className="ph ph-graduation-cap"></i>Authorised to pick up
          </div>
          <div className="flex flex-wrap gap-1">
            {c.authorizedStudents.map((s) => (
              <span key={s.id} className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-200 border border-brand-500/30">
                {s.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Terminal summary (read-only — picker now lives on class header) */}
      <div className="px-4 py-2 border-t border-slate-800/60">
        <div className="text-[10px] text-slate-400 flex items-center justify-between gap-2">
          <span>
            <i className="ph ph-cpu text-slate-500 mr-1"></i>
            {allDevices.length === 0
              ? <span className="text-amber-300">No terminals configured</span>
              : resolvedTerminalCount === 0
                ? <span className="text-amber-300">Pick terminals on class header above</span>
                : <>Will enrol on <span className="text-slate-200 font-semibold">{resolvedTerminalCount}</span> terminal{resolvedTerminalCount !== 1 ? 's' : ''}</>
            }
          </span>
          {c.availableDeviceCount > 0 && (
            <span className="font-mono text-slate-500 text-[10px]">
              {c.enrolledDeviceCount}/{c.availableDeviceCount} live
            </span>
          )}
        </div>
      </div>

      {/* Action footer */}
      <div className="px-4 py-3 border-t border-slate-800/60 bg-slate-900/40">
        {c.noPhotos ? (
          <a href="/v2/pickup-admin?status=approved"
            className="block text-center text-xs px-3 py-2 rounded-lg bg-violet-500/15 border border-violet-500/40 text-violet-200 font-semibold hover:bg-violet-500/25">
            <i className="ph ph-camera-plus mr-1"></i>Upload chaperone photo first
          </a>
        ) : allDevices.length === 0 ? (
          <a href="/v2/terminals"
            className="block text-center text-xs px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-200 font-semibold hover:bg-amber-500/25">
            <i className="ph ph-cpu mr-1"></i>Configure a terminal first
          </a>
        ) : resolvedTerminalCount === 0 ? (
          <div className="text-center text-[11px] text-amber-300/80 px-2 py-2">
            <i className="ph ph-list-checks mr-1"></i>Pick at least one terminal on the class header
          </div>
        ) : (
          <button
            onClick={onEnroll}
            disabled={busy}
            className={`w-full text-sm px-3 py-2 rounded-lg font-semibold border ${
              c.allEnrolled
                ? 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
                : 'bg-brand-500 border-brand-400 text-white hover:bg-brand-600 shadow-md shadow-brand-500/20'
            } disabled:opacity-50`}
          >
            {busyHere ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Enrolling…</>
              : c.allEnrolled ? <><i className="ph ph-arrows-clockwise mr-1"></i>Re-enrol on {resolvedTerminalCount} terminal{resolvedTerminalCount !== 1 ? 's' : ''}</>
              : <><i className="ph ph-fingerprint mr-1"></i>Enrol on {resolvedTerminalCount} terminal{resolvedTerminalCount !== 1 ? 's' : ''}</>}
          </button>
        )}
      </div>
    </div>
  );
}
