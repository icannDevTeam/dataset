/**
 * /v2/pickup-admin
 *
 * Admin review queue for Pickup System parent submissions. Pro-grade UX:
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
    setView(v === 'kiosks' ? 'kiosks' : v === 'settings' ? 'settings' : v === 'invites' ? 'invites' : 'onboarding');
  }, [router.isReady, router.query.view]);

  // ─── Pickup settings state ──────────────────────────────────────────────
  const [pickupSettings, setPickupSettings] = useState(null);  // null = loading
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [kioskProfiles, setKioskProfiles] = useState([]);
  const [kioskDrafts, setKioskDrafts] = useState({});
  const [kiosksLoading, setKiosksLoading] = useState(false);
  const [kioskBusy, setKioskBusy] = useState({});

  useEffect(() => {
    if (view !== 'settings') return;
    fetch('/api/pickup/admin/settings', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => { if (j.ok) setPickupSettings(j.settings); })
      .catch(() => {});
  }, [view]);

  useEffect(() => {
    if (view !== 'settings') return;
    setKiosksLoading(true);
    fetch('/api/pickup/admin/kiosk-profiles', { credentials: 'include' })
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        const profiles = Array.isArray(j.profiles) ? j.profiles : [];
        setKioskProfiles(profiles);
        const drafts = {};
        profiles.forEach((p) => {
          drafts[p.id] = {
            windowOpen: p.windowOpen || '',
            windowClose: p.windowClose || '',
            suppressOutOfWindow: p.suppressOutOfWindow !== false,
          };
        });
        setKioskDrafts(drafts);
      })
      .catch((e) => pushToast('error', e.message || 'Failed loading gate hours', 'Settings load failed'))
      .finally(() => setKiosksLoading(false));
  }, [view]);

  async function toggleSetting(key, value) {
    setSettingsBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'update failed');
      setPickupSettings((s) => ({ ...s, [key]: value }));
      pushToast('success', `${key} set to ${value}`);
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setSettingsBusy(false);
    }
  }

  function updateKioskDraft(id, patch) {
    setKioskDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), ...patch },
    }));
  }

  async function saveGateHours(profileId) {
    const profile = kioskProfiles.find((p) => p.id === profileId);
    const draft = kioskDrafts[profileId] || {};
    if (!profile) return;

    setKioskBusy((b) => ({ ...b, [profileId]: true }));
    try {
      const payload = {
        name: profile.name,
        kioskCode: profile.kioskCode || '',
        gates: profile.gates || [],
        homerooms: profile.homerooms || [],
        showQueue: profile.showQueue !== false,
        maxCards: profile.maxCards || 5,
        beepEnabled: profile.beepEnabled !== false,
        accent: profile.accent || '#8B1538',
        windowOpen: draft.windowOpen || null,
        windowClose: draft.windowClose || null,
        suppressOutOfWindow: draft.suppressOutOfWindow !== false,
      };

      const r = await fetch(`/api/pickup/admin/kiosk-profiles?id=${encodeURIComponent(profileId)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.message || j?.error || 'Failed saving gate hours');

      const updated = j.profile;
      setKioskProfiles((list) => list.map((p) => (p.id === profileId ? updated : p)));
      setKioskDrafts((prev) => ({
        ...prev,
        [profileId]: {
          windowOpen: updated.windowOpen || '',
          windowClose: updated.windowClose || '',
          suppressOutOfWindow: updated.suppressOutOfWindow !== false,
        },
      }));
      pushToast('success', `Gate hours saved for ${updated.name}`);
    } catch (e) {
      pushToast('error', e.message || 'Failed saving gate hours');
    } finally {
      setKioskBusy((b) => ({ ...b, [profileId]: false }));
    }
  }

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

  // Admin uploads a student profile photo from the form details view.
  // The parent form only collects student id+name; admins fill in the photo here.
  const uploadStudentPhoto = useCallback(async (studentId, file) => {
    if (!studentId || !file) return;
    if (!/^image\/(jpe?g|png|webp)$/i.test(file.type)) {
      pushToast('error', 'Photo must be JPEG, PNG or WebP.');
      return;
    }
    if (file.size > 800 * 1024) {
      pushToast('error', 'Photo must be ≤ 800 KB.');
      return;
    }
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    try {
      const r = await fetch('/api/pickup/admin/student-photo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studentId, imageBase64: dataUrl }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'upload failed');
      // Patch the in-memory thumbnails so the new photo shows immediately.
      setThumbnails((m) => ({ ...m, [studentId]: j.photoUrl }));
      pushToast('success', `Saved photo for ${studentId}.`);
      // Refresh records so onboarding-list re-reads `students/{sid}.photoUrl`.
      reload();
    } catch (e) {
      pushToast('error', `Upload failed: ${e.message}`);
    }
  }, [reload]);

  // Admin uploads/appends a chaperone face photo (only available after the form
  // is approved, because that's when chaperones get a stable doc id).
  const uploadChaperonePhoto = useCallback(async (chaperoneId, file, { replace = false } = {}) => {
    if (!chaperoneId || !file) return;
    if (!/^image\/(jpe?g|png|webp)$/i.test(file.type)) {
      pushToast('error', 'Photo must be JPEG, PNG or WebP.');
      return;
    }
    if (file.size > 800 * 1024) {
      pushToast('error', 'Photo must be ≤ 800 KB.');
      return;
    }
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    try {
      const r = await fetch('/api/pickup/admin/chaperone-photos', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chaperoneId,
          replace,
          enroll: true,
          photos: [{ imageBase64: dataUrl }],
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'upload failed');
      const enrollFails = (j.enrollment || []).filter((e) => !e.ok);
      if (enrollFails.length) {
        pushToast('warn', `Photo saved but enroll warning on ${enrollFails.length} device(s).`);
      } else {
        pushToast('success', `Chaperone photo ${replace ? 'replaced' : 'added'} & enrolled.`);
      }
      reload();
    } catch (e) {
      pushToast('error', `Upload failed: ${e.message}`);
    }
  }, [reload]);

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
                Pickup System Admin
              </h1>
              <p className="text-sm text-slate-400 mt-1">
                {view === 'kiosks'
                  ? 'Manage TV kiosk profiles — one per screen, filtered by gate and grade.'
                  : view === 'invites'
                  ? 'Generate and manage open-ended onboarding links to share with parents.'
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
          ) : view === 'invites' ? (
            <InviteLinksManager pushToast={pushToast} />
          ) : view === 'settings' ? (
            <div className="max-w-4xl">
              <h2 className="text-lg font-semibold text-white mb-1">Pickup Settings</h2>
              <p className="text-sm text-slate-400 mb-6">Tenant-level configuration for Pickup System behaviour.</p>

              {/* Per-terminal gate control + schedule (live state, admin override) */}
              <div className="mb-4">
                <TerminalGateControlCard />
              </div>

              {pickupSettings === null ? (
                <div className="text-slate-400 text-sm">Loading…</div>
              ) : (
                <div className="space-y-4">
                  {/* allowSelfClaim toggle */}
                  <div className="flex items-start justify-between gap-6 rounded-xl bg-white/5 border border-slate-800 px-5 py-4">
                    <div>
                      <p className="text-sm font-medium text-white">Allow TV self-claim</p>
                      <p className="text-xs text-slate-400 mt-0.5 max-w-sm">
                        When on, a TV can pair itself by entering a kiosk code — no admin step needed.
                        Turn off to require an admin to approve every pairing from the dashboard.
                      </p>
                    </div>
                    <button
                      disabled={settingsBusy}
                      onClick={() => toggleSetting('allowSelfClaim', !pickupSettings.allowSelfClaim)}
                      className={`relative flex-shrink-0 mt-0.5 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                        pickupSettings.allowSelfClaim ? 'bg-brand-500' : 'bg-slate-700'
                      } ${settingsBusy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      role="switch"
                      aria-checked={pickupSettings.allowSelfClaim}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                        pickupSettings.allowSelfClaim ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>

                  {/* Per-gate schedule controls */}
                  <div className="rounded-xl bg-white/5 border border-slate-800 px-5 py-4">
                    <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
                      <div>
                        <p className="text-sm font-medium text-white">Gate open/close windows (per gate profile)</p>
                        <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
                          Configure each gate profile schedule here. Security override still works on top, but default gate behavior follows these times.
                        </p>
                      </div>
                      <button
                        onClick={() => router.push('/v2/pickup-admin?view=kiosks')}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10"
                      >
                        Open TV Kiosks editor
                      </button>
                    </div>

                    {kiosksLoading ? (
                      <div className="text-xs text-slate-400">Loading gate profiles…</div>
                    ) : kioskProfiles.length === 0 ? (
                      <div className="text-xs text-slate-400">No kiosk profiles yet. Create one in TV Kiosks first.</div>
                    ) : (
                      <div className="space-y-3">
                        {kioskProfiles.map((p) => {
                          const d = kioskDrafts[p.id] || { windowOpen: '', windowClose: '', suppressOutOfWindow: true };
                          const saving = !!kioskBusy[p.id];
                          return (
                            <div key={p.id} className="rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3">
                              <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
                                <div>
                                  <div className="text-sm font-semibold text-white">{p.name}</div>
                                  <div className="text-[11px] text-slate-500 mt-0.5">
                                    Gates: {(p.gates || []).length ? p.gates.join(', ') : 'All gates'}
                                  </div>
                                </div>
                                <button
                                  disabled={saving}
                                  onClick={() => saveGateHours(p.id)}
                                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-500/20 border border-brand-500/40 text-brand-200 hover:bg-brand-500/30 disabled:opacity-50"
                                >
                                  {saving ? 'Saving…' : 'Save'}
                                </button>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">Opens at</label>
                                  <input
                                    type="time"
                                    value={d.windowOpen || ''}
                                    onChange={(e) => updateKioskDraft(p.id, { windowOpen: e.target.value })}
                                    className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">Closes at</label>
                                  <input
                                    type="time"
                                    value={d.windowClose || ''}
                                    onChange={(e) => updateKioskDraft(p.id, { windowClose: e.target.value })}
                                    className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                                  />
                                </div>
                              </div>

                              <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={d.suppressOutOfWindow !== false}
                                  onChange={(e) => updateKioskDraft(p.id, { suppressOutOfWindow: e.target.checked })}
                                  className="accent-brand-500"
                                />
                                Suppress events outside window
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
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
                  onUploadStudentPhoto={uploadStudentPhoto}
                  onUploadChaperonePhoto={uploadChaperonePhoto}
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

// ─── Terminal Gate Control card (Pickup Settings) ──────────────────────────
//
// Surfaces the live, per-Hikvision-terminal gate state (manual override + WIB
// schedule) on the Pickup Settings page so admins can open/close pickup
// without leaving the dashboard. Shares the same `/api/pickup/admin/terminals`
// endpoint that /v2/terminals uses, so any change here is reflected everywhere
// (including the backend gate enforcer that pushes RemoteControl to the door
// relay only on state transitions).
function TerminalGateControlCard() {
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});
  const [now, setNow] = useState(() => new Date());
  // Per-terminal local schedule edit drafts, keyed by terminal id.
  const [drafts, setDrafts] = useState({});

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/terminals', { credentials: 'include' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setTerminals((j.terminals || []).filter((t) => t.enabled !== false));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // Refresh every 15s so the live state stays close to reality without
  // hammering Firestore.
  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [reload]);
  // Tick clock every 30s so in-window/out-of-window pills auto-update.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const setOverride = async (id, val) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateOverride: val }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      await reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const saveSchedule = async (id) => {
    const d = drafts[id];
    if (!d) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          windowOpen:  d.windowOpen ?? null,
          windowClose: d.windowClose ?? null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setDrafts((prev) => { const n = { ...prev }; delete n[id]; return n; });
      await reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  // Compute effective gate state mirroring lib/terminal-gate.js so the UI is
  // accurate without an extra round-trip.
  const effective = (t) => {
    const override = t.gateOverride === 'open' || t.gateOverride === 'closed' ? t.gateOverride : null;
    const parse = (s) => /^\d{2}:\d{2}$/.test(s || '') ? (parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3), 10)) : null;
    const o = parse(t.windowOpen), c = parse(t.windowClose);
    const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const cur = wib.getUTCHours() * 60 + wib.getUTCMinutes();
    let scheduledOpen = true, configured = false;
    if (o != null && c != null) {
      configured = true;
      scheduledOpen = o <= c ? (cur >= o && cur <= c) : (cur >= o || cur <= c);
    }
    if (override === 'closed') return { open: false, reason: 'manual-closed', override, configured, scheduledOpen };
    if (override === 'open')   return { open: true,  reason: 'manual-open',   override, configured, scheduledOpen };
    if (configured)            return { open: scheduledOpen, reason: scheduledOpen ? 'in-window' : 'out-of-window', override: null, configured, scheduledOpen };
    return { open: true, reason: 'always-open', override: null, configured: false, scheduledOpen: true };
  };

  const openCount = terminals.filter((t) => effective(t).open).length;
  const closedCount = terminals.length - openCount;

  return (
    <div className="rounded-2xl bg-white/5 border border-slate-800 px-5 py-4">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center">
            <i className="ph ph-door-open text-xl text-brand-300"></i>
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Pickup gate control</p>
            <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
              Open or close the pickup gate per terminal. Manual override always wins over the schedule;
              choose <span className="text-slate-200 font-semibold">Auto</span> to follow the schedule (or stay always-open if no schedule is set).
            </p>
          </div>
        </div>
        <div className="text-xs text-slate-300 bg-slate-950/50 border border-slate-700 rounded-lg px-3 py-1.5">
          Open: <span className="text-emerald-300 font-semibold">{openCount}</span>
          <span className="mx-2 text-slate-600">|</span>
          Closed: <span className="text-rose-300 font-semibold">{closedCount}</span>
        </div>
      </div>

      {err && (
        <div className="mb-3 p-2 rounded bg-red-950/60 border border-red-500/40 text-red-200 text-xs">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-slate-400 text-sm">Loading terminals…</div>
      ) : terminals.length === 0 ? (
        <div className="text-slate-400 text-sm">
          No active terminals registered yet. Start the Pandora listener (run_listeners.py) to auto-register.
        </div>
      ) : (
        <div className="space-y-2">
          {terminals.map((t) => {
            const eff = effective(t);
            const draft = drafts[t.id] || {};
            const winOpen  = draft.windowOpen  !== undefined ? draft.windowOpen  : (t.windowOpen  || '');
            const winClose = draft.windowClose !== undefined ? draft.windowClose : (t.windowClose || '');
            const dirty = draft.windowOpen !== undefined || draft.windowClose !== undefined;
            const isBusy = !!busy[t.id];
            return (
              <div
                key={t.id}
                className={`rounded-xl border px-4 py-3 ${
                  eff.open
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : 'border-rose-500/30 bg-rose-500/5'
                }`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <i className={`ph ${eff.open ? 'ph-door-open text-emerald-300' : 'ph-door text-rose-300'}`}></i>
                      <span className="font-semibold text-white">{t.name}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-bold ${
                        eff.open ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                      }`}>
                        {eff.open ? 'Open' : 'Closed'}
                      </span>
                      {eff.override && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          Manual
                        </span>
                      )}
                      <span className="text-[10px] text-slate-500">{eff.reason}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {t.gateLabel || t.gradeLabel || t.id}
                      {t.ip && <span className="text-slate-600"> · {t.ip}</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Schedule: {eff.configured ? `${t.windowOpen} – ${t.windowClose} WIB` : 'No schedule (always open unless manually closed)'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={isBusy || t.gateOverride === 'open'}
                      onClick={() => setOverride(t.id, 'open')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-500/30 hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      <i className="ph ph-door-open mr-1"></i>Open
                    </button>
                    <button
                      disabled={isBusy || !t.gateOverride}
                      onClick={() => setOverride(t.id, null)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 text-slate-300 border border-slate-700 hover:bg-white/10 disabled:opacity-50"
                    >
                      Auto
                    </button>
                    <button
                      disabled={isBusy || t.gateOverride === 'closed'}
                      onClick={() => setOverride(t.id, 'closed')}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-200 border border-rose-500/30 hover:bg-rose-500/30 disabled:opacity-50"
                    >
                      <i className="ph ph-door mr-1"></i>Close
                    </button>
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-[auto_auto_auto_1fr] gap-3 items-end">
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Opens at (WIB)</label>
                    <input
                      type="time"
                      value={winOpen}
                      onChange={(e) => setDrafts((p) => ({ ...p, [t.id]: { ...(p[t.id] || {}), windowOpen: e.target.value || null } }))}
                      className="bg-slate-950/60 border border-slate-700 rounded-md px-3 py-1.5 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Closes at (WIB)</label>
                    <input
                      type="time"
                      value={winClose}
                      onChange={(e) => setDrafts((p) => ({ ...p, [t.id]: { ...(p[t.id] || {}), windowClose: e.target.value || null } }))}
                      className="bg-slate-950/60 border border-slate-700 rounded-md px-3 py-1.5 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <button
                      disabled={!dirty || isBusy}
                      onClick={() => saveSchedule(t.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                        dirty
                          ? 'bg-brand-500/20 text-brand-200 border-brand-500/40 hover:bg-brand-500/30'
                          : 'bg-slate-900 text-slate-500 border-slate-800'
                      }`}
                    >
                      {isBusy ? 'Saving…' : 'Save schedule'}
                    </button>
                  </div>
                  <div className="text-[11px] text-slate-500 sm:text-right">
                    {(winOpen && winClose)
                      ? <>Auto: gate opens at <b className="text-slate-300">{winOpen}</b> and closes at <b className="text-slate-300">{winClose}</b>.</>
                      : <>No schedule — gate stays open unless manually closed.</>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-500">
        Backend gate enforcer pushes <code className="text-slate-300">alwaysOpen</code> / <code className="text-slate-300">alwaysClose</code> / <code className="text-slate-300">resume</code> to the door relay only on state transitions, so the relay isn't fired on every face scan.
      </p>
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
    onPhoto, onPrint, onUploadStudentPhoto, onUploadChaperonePhoto,
    busy, rejecting, rejectReason, setRejectReason, showSelect,
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
              {rec.formNumber && (
                <span
                  title="Submission ID — use this for audit & reports"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold border bg-brand-500/15 text-brand-200 border-brand-500/40"
                >
                  <i className="ph ph-hash"></i>{rec.formNumber}
                </span>
              )}
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
            <SectionHeader icon="ph-graduation-cap" label={`Students on this form (${enrichedStudents.length})`} />
            {enrichedStudents.length > 1 && (
              <p className="text-[11px] text-slate-500 -mt-1 mb-3">
                <i className="ph ph-info mr-1"></i>
                {enrichedStudents.length} siblings on a single submission — upload a photo for each child below.
              </p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {enrichedStudents.map((s, i) => (
                <StudentTile
                  key={s.id}
                  s={s}
                  index={i}
                  total={enrichedStudents.length}
                  onPhoto={onPhoto}
                  onUpload={onUploadStudentPhoto ? (file) => onUploadStudentPhoto(s.id, file) : null}
                />
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
                    enrichedStudents={enrichedStudents} onPhoto={onPhoto}
                    onUpload={onUploadChaperonePhoto && allocated
                      ? (file, opts) => onUploadChaperonePhoto(allocated.chaperoneId, file, opts)
                      : null} />
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
                <div className="flex items-center gap-2">
                  <a
                    href="/v2/pickup-enroll"
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-500/10 border border-brand-500/30 text-brand-300 hover:bg-brand-500/20"
                    title="Push these chaperones to the right grade-level Hikvision terminal"
                  >
                    <i className="ph ph-fingerprint mr-1"></i>Open Enrolment board
                  </a>
                  <button onClick={onReenroll} disabled={!!busy}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800/60 border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    title="Quick re-push of just this form's chaperones (uses each chaperone's grade scope)">
                    {busy === 'reenroll' ? 'Re-enrolling…' : (
                      <><i className="ph ph-arrows-clockwise mr-1"></i>Quick re-push</>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StudentTile({ s, index, total, onPhoto, onUpload }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(async (file) => {
    if (!file || !onUpload) return;
    setBusy(true);
    try { await onUpload(file); } finally { setBusy(false); }
  }, [onUpload]);

  const onChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    await handleFile(file);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    await handleFile(file);
  };

  const hasPhoto = !!s.photoUrl;
  const isSibling = total > 1;

  return (
    <div
      onDragOver={(e) => { if (onUpload) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`group relative rounded-xl border bg-gradient-to-br from-white/5 to-white/[0.02] overflow-hidden transition-all ${
        dragOver ? 'border-brand-400 ring-2 ring-brand-500/40 bg-brand-500/5' : 'border-slate-800 hover:border-slate-700'
      }`}
    >
      {/* Status bar */}
      <div className={`px-3 py-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider border-b ${
        hasPhoto
          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
          : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
      }`}>
        <span className="flex items-center gap-1.5">
          <i className={`ph ${hasPhoto ? 'ph-check-circle-fill' : 'ph-warning-circle-fill'}`}></i>
          {hasPhoto ? 'Photo on file' : 'Photo required'}
        </span>
        {isSibling && (
          <span className="text-slate-400" title="Sibling number on this form">
            Child {index + 1}/{total}
          </span>
        )}
      </div>

      <div className="p-4 flex gap-4">
        {/* Photo zone */}
        <div className="relative flex-shrink-0">
          {hasPhoto ? (
            <button
              type="button"
              onClick={() => onPhoto(s.photoUrl, `${s.name} · ID ${s.id}${s.homeroom ? ` · ${s.homeroom}` : ''}`)}
              className="block w-24 h-24 rounded-xl overflow-hidden border-2 border-slate-700 hover:border-brand-400 transition-colors cursor-zoom-in"
              title="View full size"
            >
              <img src={s.photoUrl} alt={s.name} className="w-full h-full object-cover" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onUpload && inputRef.current?.click()}
              disabled={!onUpload || busy}
              className="w-24 h-24 rounded-xl border-2 border-dashed border-slate-700 hover:border-brand-400 hover:bg-brand-500/5 transition-colors flex flex-col items-center justify-center gap-1 text-slate-500 hover:text-brand-300 disabled:opacity-50"
              title="Click or drop a photo"
            >
              <i className="ph ph-image-square text-3xl"></i>
              <span className="text-[9px] uppercase tracking-wider font-bold">No photo</span>
            </button>
          )}

          {onUpload && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              title={hasPhoto ? 'Replace photo' : 'Upload photo'}
              className="absolute -bottom-2 -right-2 w-8 h-8 rounded-full bg-brand-500 hover:bg-brand-400 text-white flex items-center justify-center border-2 border-slate-900 shadow-lg disabled:opacity-50"
            >
              {busy
                ? <i className="ph ph-spinner-gap animate-spin"></i>
                : <i className={`ph ${hasPhoto ? 'ph-pencil-simple' : 'ph-plus'}`}></i>}
            </button>
          )}

          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onChange}
          />
        </div>

        {/* Info zone */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
          <div className="text-base font-bold text-white leading-tight truncate" title={s.name}>
            {s.name || '—'}
          </div>

          {s.dbName && s.dbName !== s.name && (
            <div className="text-[10px] text-amber-400 -mt-0.5" title="Name on file in BINUS DB differs from form">
              <i className="ph ph-warning mr-0.5"></i>DB: {s.dbName}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800/60 border border-slate-700 text-[10px] font-mono text-slate-300"
              title="BINUS Student ID"
            >
              <i className="ph ph-identification-card text-slate-500"></i>
              {s.id}
            </span>
            {s.homeroom ? (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-brand-500/15 border border-brand-500/30 text-[10px] font-bold text-brand-200"
                title="Homeroom class"
              >
                <i className="ph ph-chalkboard-teacher"></i>
                {s.homeroom}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800/40 border border-slate-700/50 text-[10px] text-slate-500 italic">
                no class
              </span>
            )}
          </div>

          {onUpload && (
            <div className="text-[10px] text-slate-500 mt-1 leading-snug">
              {hasPhoto
                ? <span><i className="ph ph-info mr-0.5"></i>Click photo to view · pencil to replace</span>
                : <span><i className="ph ph-arrow-down mr-0.5"></i>Drop a photo here or click <b className="text-brand-300">+</b> to upload</span>}
              <div className="text-slate-600 mt-0.5">JPEG / PNG / WebP, ≤ 800 KB</div>
            </div>
          )}
        </div>
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 bg-brand-500/20 border-2 border-dashed border-brand-400 rounded-xl flex items-center justify-center pointer-events-none">
          <div className="text-brand-200 font-bold text-sm flex items-center gap-2">
            <i className="ph ph-upload-simple text-2xl"></i>Drop to upload
          </div>
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

function ChaperoneRow({ c, index, allocated, enrol, enrichedStudents, onPhoto, onUpload }) {
  const addInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const faces = c.faceUrls || [];
  const MAX_FACES = 8;
  const slots = Array.from({ length: MAX_FACES }, (_, i) => faces[i] || null);
  const filled = faces.length;
  const canUpload = !!onUpload && !!allocated;

  const handleAdd = async (file) => {
    if (!file || !onUpload) return;
    setBusy(true);
    try { await onUpload(file, { replace: false }); } finally { setBusy(false); }
  };
  const handleReplace = async (file) => {
    if (!file || !onUpload) return;
    if (!confirm(`Replace ALL ${filled} existing photo(s) for ${c.name}?`)) return;
    setBusy(true);
    try { await onUpload(file, { replace: true }); } finally { setBusy(false); }
  };
  const onDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleAdd(file);
  };

  const authorizedNames = (c.authorizedStudentIds || []).map((sid) => {
    const s = enrichedStudents.find((x) => x.id === sid);
    return { id: sid, name: s?.name || sid };
  });

  return (
    <div
      onDragOver={(e) => { if (canUpload) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`relative rounded-xl border bg-gradient-to-br from-white/5 to-white/[0.02] overflow-hidden transition-all ${
        dragOver ? 'border-orange-400 ring-2 ring-orange-500/40' : 'border-slate-800 hover:border-slate-700'
      }`}
    >
      {/* Header strip */}
      <div className="px-4 py-2.5 flex items-center justify-between gap-2 flex-wrap border-b border-slate-800 bg-slate-900/40">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-full bg-orange-500/20 text-orange-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
            {index + 1}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-white truncate">{c.name}</span>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                {REL_LABEL[c.relation] || c.relation}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {allocated ? (
            <span
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
              title="Allocated chaperone employee number"
            >
              <i className="ph ph-hash mr-0.5"></i>{allocated.employeeNo}
            </span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">
              Pending approval
            </span>
          )}
          {allocated && enrol && (enrol.ok ? (
            <span
              className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
              title={(enrol.devices || []).map((d) => `${d.name}: ${d.ok ? 'ok' : d.error}`).join('\n')}
            >
              <i className="ph ph-fingerprint mr-0.5"></i>enrolled
            </span>
          ) : (
            <span
              className="text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30"
              title={(enrol.devices || []).map((d) => `${d.name}: ${d.ok ? 'ok' : d.error}`).join('\n') || enrol.error || ''}
            >
              <i className="ph ph-warning mr-0.5"></i>enroll failed
            </span>
          ))}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Contact row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          {c.phone && (<span><i className="ph ph-phone text-slate-500 mr-1"></i>{c.phone}</span>)}
          {c.email && (<span><i className="ph ph-envelope text-slate-500 mr-1"></i>{c.email}</span>)}
          {c.idNumber && (<span><i className="ph ph-identification-card text-slate-500 mr-1"></i>{c.idNumber}</span>)}
        </div>

        {/* Authorized to pick up */}
        {authorizedNames.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              <i className="ph ph-graduation-cap mr-1"></i>Authorized to pick up
            </div>
            <div className="flex flex-wrap gap-1.5">
              {authorizedNames.map((a) => (
                <span key={a.id}
                  className="text-[11px] inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-200 border border-brand-500/30">
                  <i className="ph ph-check-circle"></i>{a.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Face photo grid */}
        <div>
          <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              <i className="ph ph-camera mr-1"></i>Face photos
              <span className={`ml-2 font-mono normal-case tracking-normal ${
                filled === 0 ? 'text-amber-400' : 'text-slate-300'
              }`}>
                {filled}/{MAX_FACES}
              </span>
            </div>
            {canUpload && (
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => addInputRef.current?.click()}
                  disabled={busy || filled >= MAX_FACES}
                  title={filled >= MAX_FACES ? `Max ${MAX_FACES} photos` : 'Add another photo'}
                  className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-orange-500/15 text-orange-200 border border-orange-500/30 hover:bg-orange-500/25 disabled:opacity-40"
                >
                  {busy ? <i className="ph ph-spinner-gap animate-spin"></i> : <i className="ph ph-plus"></i>}
                  Add
                </button>
                {filled > 0 && (
                  <button
                    type="button"
                    onClick={() => replaceInputRef.current?.click()}
                    disabled={busy}
                    title="Replace all photos with one new photo"
                    className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-800/60 text-slate-300 border border-slate-700 hover:bg-slate-800 disabled:opacity-40"
                  >
                    <i className="ph ph-arrows-clockwise"></i>Replace all
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {slots.map((url, j) => url ? (
              <button
                key={j}
                type="button"
                onClick={() => onPhoto(url, `${c.name} · face ${j + 1}/${filled}`)}
                className="relative aspect-square rounded-lg overflow-hidden border-2 border-orange-500/40 hover:border-orange-300 transition-colors cursor-zoom-in group/face"
                title={`Click to view face ${j + 1}`}
              >
                <img src={url} alt={`${c.name} ${j + 1}`} className="w-full h-full object-cover" />
                <span className="absolute top-0.5 left-0.5 text-[9px] font-mono px-1 py-0 rounded bg-black/60 text-white">
                  {j + 1}
                </span>
              </button>
            ) : (
              <button
                key={j}
                type="button"
                onClick={() => canUpload && j === filled && addInputRef.current?.click()}
                disabled={!canUpload || j !== filled}
                className={`aspect-square rounded-lg border-2 border-dashed flex items-center justify-center text-slate-600 ${
                  canUpload && j === filled
                    ? 'border-orange-500/40 hover:border-orange-300 hover:bg-orange-500/5 cursor-pointer text-orange-400'
                    : 'border-slate-800 cursor-default'
                }`}
                title={canUpload && j === filled ? 'Add photo here' : 'Empty slot'}
              >
                {canUpload && j === filled ? <i className="ph ph-plus text-lg"></i> : <i className="ph ph-image-square text-base opacity-30"></i>}
              </button>
            ))}
          </div>

          {filled === 0 && (
            <div className="mt-2 text-[11px] text-amber-400/90 flex items-center gap-1.5">
              <i className="ph ph-warning-circle"></i>
              No face photos {canUpload
                ? <>— add at least one so the chaperone can be recognised at the gate.</>
                : <>— admin can upload after the form is approved.</>}
            </div>
          )}
          {!allocated && onUpload && (
            <div className="mt-2 text-[11px] text-slate-500">
              <i className="ph ph-info mr-1"></i>Approve the form first to enable photo uploads.
            </div>
          )}
          {canUpload && filled > 0 && (
            <div className="mt-2 text-[10px] text-slate-600">
              JPEG / PNG / WebP, ≤ 800 KB. Each upload re-enrols the chaperone on all configured Hikvision devices.
            </div>
          )}
        </div>

        {/* Per-device enrollment status */}
        {enrol && enrol.devices && enrol.devices.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
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

      {/* Hidden inputs */}
      <input
        ref={addInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          await handleAdd(f);
        }}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          await handleReplace(f);
        }}
      />

      {dragOver && canUpload && (
        <div className="absolute inset-0 bg-orange-500/20 border-2 border-dashed border-orange-400 rounded-xl flex items-center justify-center pointer-events-none">
          <div className="text-orange-200 font-bold text-sm flex items-center gap-2">
            <i className="ph ph-upload-simple text-2xl"></i>Drop to add face photo
          </div>
        </div>
      )}
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
          <div className="text-xs text-slate-500">Filled-form preview · BINUS Pickup System</div>
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
              <div className="text-2xl font-bold mt-1">Pickup System Authorization Form</div>
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
          BINUS School Simprug · Pickup System · Generated {fmtTime(new Date().toISOString())}
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

// ─── Invite Links Manager ───────────────────────────────────────────────────
//
// Open-ended onboarding link administration. One link can serve any number
// of parents — what matters is the data inside the form. Admins can:
//   • Generate new named links with optional TTL / max-uses / description
//   • Preview the form (opens in new tab)
//   • Copy URL, copy short token, show QR
//   • Pause / resume / revoke
//   • See live useCount + last-used time
//
// All changes are immediate and applied tenant-wide.
function InviteLinksManager({ pushToast }) {
  const [items, setItems] = useState(null);   // null = loading
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [previewInvite, setPreviewInvite] = useState(null); // {invite, qr}
  const [confirmRevoke, setConfirmRevoke] = useState(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/invite-links', { credentials: 'include' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setItems(j.invites || []);
    } catch (e) {
      pushToast('error', e.message, 'Could not load invite links');
      setItems([]);
    }
  }, [pushToast]);

  useEffect(() => { reload(); }, [reload]);

  async function createInvite(form) {
    setBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/invite-links', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setShowCreate(false);
      setPreviewInvite({ invite: j.invite, qr: j.invite.qrDataUrl || null });
      pushToast('success', `“${j.invite.name}” is ready to share.`, 'Invite link created');
      await reload();
    } catch (e) {
      pushToast('error', e.message, 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  async function patchInvite(id, patch) {
    try {
      const r = await fetch(`/api/pickup/admin/invite-links?id=${encodeURIComponent(id)}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await reload();
      return j.invite;
    } catch (e) {
      pushToast('error', e.message, 'Update failed');
      return null;
    }
  }

  async function revokeInvite(id) {
    try {
      const r = await fetch(`/api/pickup/admin/invite-links?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      pushToast('success', 'Link revoked. Existing tokens will be rejected on next use.', 'Done');
      setConfirmRevoke(null);
      await reload();
    } catch (e) {
      pushToast('error', e.message, 'Revoke failed');
    }
  }

  async function showQr(invite) {
    if (invite.qrDataUrl) {
      setPreviewInvite({ invite, qr: invite.qrDataUrl });
      return;
    }
    try {
      const r = await fetch(`/api/pickup/admin/invite-links?id=${encodeURIComponent(invite.id)}&qr=1`, { credentials: 'include' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPreviewInvite({ invite: j.invite, qr: j.invite.qrDataUrl || null });
    } catch (e) {
      pushToast('error', e.message, 'Could not load QR');
    }
  }

  function copyText(text, label) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => pushToast('success', label || 'Copied to clipboard', 'Copied'),
      () => pushToast('error', 'Clipboard blocked. Select the URL manually.', 'Copy failed'),
    );
  }

  const stats = useMemo(() => {
    const list = items || [];
    return {
      total: list.length,
      active: list.filter((i) => i.enabled && !i.revoked).length,
      revoked: list.filter((i) => i.revoked || !i.enabled).length,
      uses: list.reduce((acc, i) => acc + Number(i.useCount || 0), 0),
    };
  }, [items]);

  return (
    <div className="max-w-6xl">
      <div className="flex items-end justify-between flex-wrap gap-3 mb-5">
        <div>
          <h2 className="text-lg font-semibold text-white mb-1">Onboarding Invite Links</h2>
          <p className="text-sm text-slate-400 max-w-2xl">
            One link can be sent to every parent. Each submission is identified by the form
            data — not the link itself — so you don&apos;t need to mint a per-parent URL.
            Use multiple links to track campaigns (e.g. <em>Grade 4 Newsletter</em>,
            <em> WhatsApp Broadcast</em>) and revoke any of them instantly.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={reload}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
            <i className="ph ph-arrows-clockwise mr-1"></i>Refresh
          </button>
          <button onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-500 to-emerald-500 hover:from-brand-400 hover:to-emerald-400 text-white shadow-lg shadow-emerald-900/30">
            <i className="ph ph-plus-circle mr-1.5"></i>New invite link
          </button>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total links" value={stats.total} icon="ph-link" tone="slate" />
        <StatCard label="Active" value={stats.active} icon="ph-check-circle" tone="emerald" />
        <StatCard label="Revoked / paused" value={stats.revoked} icon="ph-pause-circle" tone="rose" />
        <StatCard label="Total submissions" value={stats.uses} icon="ph-paper-plane-tilt" tone="amber" />
      </div>

      {items === null ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-white/5 px-8 py-14 text-center">
          <i className="ph ph-link-simple text-4xl text-slate-500"></i>
          <p className="mt-3 text-slate-300 font-medium">No invite links yet.</p>
          <p className="text-xs text-slate-500 mt-1 mb-4">
            Create one and share it with all parents — the link is reusable.
          </p>
          <button onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-500 hover:bg-brand-400 text-white">
            <i className="ph ph-plus-circle mr-1.5"></i>Create first link
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((inv) => (
            <InviteLinkCard
              key={inv.id}
              invite={inv}
              onCopy={copyText}
              onShowQr={() => showQr(inv)}
              onPreview={() => window.open(inv.url, '_blank', 'noopener')}
              onToggle={(enabled) => patchInvite(inv.id, { enabled })}
              onRevoke={() => setConfirmRevoke(inv)}
              onRename={(name) => patchInvite(inv.id, { name })}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateInviteModal
          busy={busy}
          onCancel={() => setShowCreate(false)}
          onSubmit={createInvite}
        />
      )}

      {previewInvite && (
        <InvitePreviewModal
          invite={previewInvite.invite}
          qr={previewInvite.qr}
          onClose={() => setPreviewInvite(null)}
          onCopy={copyText}
        />
      )}

      {confirmRevoke && (
        <div className="fixed inset-0 z-[1000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
             onClick={() => setConfirmRevoke(null)}>
          <div className="bg-slate-900 border border-rose-500/40 rounded-xl max-w-md w-full p-6"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-rose-500/20 flex items-center justify-center flex-shrink-0">
                <i className="ph ph-warning text-rose-400 text-xl"></i>
              </div>
              <div>
                <h3 className="text-white font-semibold">Revoke invite link?</h3>
                <p className="text-sm text-slate-400 mt-1">
                  &ldquo;<span className="text-white">{confirmRevoke.name}</span>&rdquo; will stop accepting
                  new submissions immediately. Existing approved chaperones are not affected.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRevoke(null)}
                className="px-4 py-2 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-white">Cancel</button>
              <button onClick={() => revokeInvite(confirmRevoke.id)}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-rose-600 hover:bg-rose-500 text-white">
                <i className="ph ph-prohibit mr-1.5"></i>Revoke link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InviteLinkCard({ invite, onCopy, onShowQr, onPreview, onToggle, onRevoke, onRename }) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(invite.name);
  useEffect(() => { setDraftName(invite.name); }, [invite.name]);

  const status = invite.revoked
    ? { label: 'Revoked', tone: 'bg-rose-500/15 text-rose-300 border-rose-500/30', dot: 'bg-rose-400' }
    : !invite.enabled
    ? { label: 'Paused',  tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400' }
    : invite.expiresAt && invite.expiresAt < Date.now()
    ? { label: 'Expired', tone: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30', dot: 'bg-zinc-400' }
    : invite.maxUses != null && invite.useCount >= invite.maxUses
    ? { label: 'Full',    tone: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30', dot: 'bg-zinc-400' }
    : { label: 'Active',  tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', dot: 'bg-emerald-400' };

  const expIso = invite.expiresAt ? new Date(invite.expiresAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : null;
  const lastUsedAgo = invite.lastUsedAt ? timeAgo(new Date(invite.lastUsedAt).toISOString()) : null;
  const usageLabel = invite.maxUses != null
    ? `${invite.useCount} / ${invite.maxUses} uses`
    : `${invite.useCount} use${invite.useCount === 1 ? '' : 's'}`;

  return (
    <div className="rounded-2xl bg-gradient-to-br from-slate-900/80 to-slate-950/80 border border-slate-800 hover:border-slate-700 transition p-5 flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <input value={draftName} onChange={(e) => setDraftName(e.target.value)}
                autoFocus
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { onRename(draftName.trim()); setEditingName(false); }
                  if (e.key === 'Escape') { setDraftName(invite.name); setEditingName(false); }
                }} />
              <button onClick={() => { onRename(draftName.trim()); setEditingName(false); }}
                className="p-1.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300">
                <i className="ph ph-check"></i>
              </button>
              <button onClick={() => { setDraftName(invite.name); setEditingName(false); }}
                className="p-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300">
                <i className="ph ph-x"></i>
              </button>
            </div>
          ) : (
            <button onClick={() => setEditingName(true)}
              className="text-base font-semibold text-white truncate text-left hover:text-brand-300 transition flex items-center gap-1.5 w-full">
              {invite.name}
              <i className="ph ph-pencil-simple text-xs text-slate-500 opacity-0 group-hover:opacity-100"></i>
            </button>
          )}
          <div className="text-xs text-slate-500 mt-0.5 font-mono">{invite.id}</div>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-full border ${status.tone}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
          {status.label}
        </span>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-white/5 rounded-lg py-2">
          <div className="text-xs text-slate-500">Submissions</div>
          <div className="text-sm font-bold text-white mt-0.5">{usageLabel}</div>
        </div>
        <div className="bg-white/5 rounded-lg py-2">
          <div className="text-xs text-slate-500">Last used</div>
          <div className="text-sm font-bold text-white mt-0.5">{lastUsedAgo || '—'}</div>
        </div>
        <div className="bg-white/5 rounded-lg py-2">
          <div className="text-xs text-slate-500">Expires</div>
          <div className="text-sm font-bold text-white mt-0.5">{expIso || 'Never'}</div>
        </div>
      </div>

      {/* URL preview */}
      <div className="bg-black/40 border border-slate-800 rounded-lg p-2.5 flex items-center gap-2 group">
        <i className="ph ph-link text-slate-500"></i>
        <code className="flex-1 text-[11px] text-slate-300 truncate font-mono">{invite.url}</code>
        <button onClick={() => onCopy(invite.url, 'Invite URL copied')}
          title="Copy URL"
          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-white/10">
          <i className="ph ph-copy"></i>
        </button>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => onCopy(invite.url, 'Invite URL copied')}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-500 hover:bg-brand-400 text-white">
          <i className="ph ph-copy mr-1"></i>Copy link
        </button>
        <button onClick={onPreview}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-200 hover:bg-white/10">
          <i className="ph ph-arrow-square-out mr-1"></i>Preview
        </button>
        <button onClick={onShowQr}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-200 hover:bg-white/10">
          <i className="ph ph-qr-code mr-1"></i>QR
        </button>
        <div className="ml-auto flex items-center gap-2">
          {!invite.revoked && (
            <button
              onClick={() => onToggle(!invite.enabled)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                invite.enabled
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20'
                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
              }`}
              title={invite.enabled ? 'Pause new submissions' : 'Resume submissions'}>
              <i className={`ph ${invite.enabled ? 'ph-pause' : 'ph-play'} mr-1`}></i>
              {invite.enabled ? 'Pause' : 'Resume'}
            </button>
          )}
          {!invite.revoked && (
            <button onClick={onRevoke}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20">
              <i className="ph ph-prohibit mr-1"></i>Revoke
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateInviteModal({ busy, onCancel, onSubmit }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ttlDays, setTtlDays] = useState(90);
  const [maxUses, setMaxUses] = useState('');

  const canSubmit = name.trim().length >= 2 && !busy;

  return (
    <div className="fixed inset-0 z-[1000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
         onClick={onCancel}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-6 shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center">
            <i className="ph ph-link-simple text-brand-300 text-xl"></i>
          </div>
          <div>
            <h3 className="text-white font-semibold">New onboarding invite link</h3>
            <p className="text-xs text-slate-400">One URL — share it with as many parents as you like.</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              maxLength={80} autoFocus
              placeholder="e.g. Grade 4 — March 2026 broadcast"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
            <p className="text-[11px] text-slate-500 mt-1">Internal label only — never shown to parents.</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Description (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              maxLength={280}
              placeholder="Notes for your team — channel, audience, etc."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Valid for</label>
              <select value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>1 year</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Max submissions</label>
              <input type="number" min="1" value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="Unlimited"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500" />
            </div>
          </div>

          <div className="rounded-lg bg-slate-800/50 border border-slate-700 px-3 py-2.5 text-xs text-slate-400 leading-relaxed">
            <i className="ph ph-info text-slate-500 mr-1"></i>
            The link is signed and tracked individually — you can revoke or pause it
            at any time. Per-IP rate limits guard the form against abuse.
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onCancel} disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-white disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => onSubmit({
              name: name.trim(),
              description: description.trim(),
              ttlDays: Number(ttlDays),
              maxUses: maxUses === '' ? null : Number(maxUses),
            })}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-brand-500 to-emerald-500 hover:from-brand-400 hover:to-emerald-400 text-white disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Generating…</> : <><i className="ph ph-link-simple mr-1.5"></i>Generate link</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvitePreviewModal({ invite, qr, onClose, onCopy }) {
  return (
    <div className="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full shadow-2xl my-8"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <i className="ph ph-check-circle text-emerald-300 text-lg"></i>
            </div>
            <div>
              <h3 className="text-white font-semibold leading-tight">{invite.name}</h3>
              <p className="text-xs text-slate-400">Ready to share with parents</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl"><i className="ph ph-x"></i></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Big copyable URL */}
          <div>
            <div className="text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Invite URL</div>
            <div className="bg-black/50 border border-slate-700 rounded-lg p-3 flex items-center gap-2">
              <code className="flex-1 text-xs text-emerald-300 break-all font-mono">{invite.url}</code>
              <button onClick={() => onCopy(invite.url, 'Invite URL copied')}
                className="px-3 py-2 text-xs font-semibold rounded bg-brand-500 hover:bg-brand-400 text-white whitespace-nowrap">
                <i className="ph ph-copy mr-1"></i>Copy
              </button>
            </div>
          </div>

          {/* QR */}
          {qr && (
            <div className="flex flex-col items-center gap-2">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Scan to open</div>
              <div className="bg-white p-3 rounded-xl">
                <img src={qr} alt="Invite QR code" className="w-56 h-56" />
              </div>
              <a href={qr} download={`invite-${invite.id}.png`}
                className="text-xs text-brand-300 hover:text-brand-200">
                <i className="ph ph-download-simple mr-1"></i>Download PNG
              </a>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-white/5 rounded-lg py-2">
              <div className="text-[10px] text-slate-500 uppercase">Expires</div>
              <div className="text-sm font-bold text-white mt-0.5">
                {invite.expiresAt ? new Date(invite.expiresAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : 'Never'}
              </div>
            </div>
            <div className="bg-white/5 rounded-lg py-2">
              <div className="text-[10px] text-slate-500 uppercase">Cap</div>
              <div className="text-sm font-bold text-white mt-0.5">
                {invite.maxUses != null ? `${invite.maxUses} max` : 'Unlimited'}
              </div>
            </div>
            <div className="bg-white/5 rounded-lg py-2">
              <div className="text-[10px] text-slate-500 uppercase">Uses</div>
              <div className="text-sm font-bold text-white mt-0.5">{invite.useCount || 0}</div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <a href={invite.url} target="_blank" rel="noopener"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-200 hover:bg-white/10">
              <i className="ph ph-arrow-square-out mr-1.5"></i>Open in new tab
            </a>
            <button onClick={onClose}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
