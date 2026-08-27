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
import PageGuard from '../../components/v2/PageGuard';
import { compressImageToJpegDataUrl } from '../../lib/client-image';
import gradeUtils from '../../lib/grade-utils';

const { deriveGradeBucket, normalizeClassLabel } = gradeUtils;

const TABS = [
  { key: 'pending',  label: 'Pending',  badge: true },
  { key: 'changes_requested', label: 'Awaiting parent' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'archived', label: 'Archived' },
];

// Statuses where the form is still pre-approval and fully editable by ACOP.
const EDITABLE_ONBOARDING_STATUSES = ['pending', 'changes_requested'];

const REL_LABEL = {
  mother: 'Mother', father: 'Father', parent: 'Parent',
  guardian: 'Guardian', driver: 'Driver', nanny: 'Nanny',
  grandparent: 'Grandparent', sibling: 'Sibling',
  emergency: 'Emergency contact', other: 'Other',
};

const REL_INITIALS = {
  mother: 'M', father: 'F', guardian: 'G', driver: 'D',
};

const VALID_RELATIONS = Object.keys(REL_INITIALS);

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'most-chaperones', label: 'Most chaperones' },
  { key: 'most-students', label: 'Most students' },
  { key: 'name-az', label: 'Guardian A → Z' },
];

const ACADEMIC_YEAR_LABEL = '2026/2027';
// Temporary cost-control switch: disable TV-feed tile in pickup-admin.
const ENABLE_PICKUP_TV_TILE = false;
const EY_GRADE_OPTIONS = ['EY1', 'EY2', 'EY3'];
const NUMERIC_GRADE_OPTIONS = ['1', '2', '3', '4', '5'];
const GRADE_SELECTION_OPTIONS = [...EY_GRADE_OPTIONS, ...NUMERIC_GRADE_OPTIONS];

async function parseApiPayload(res) {
  const raw = await res.text();
  try {
    return { raw, json: raw ? JSON.parse(raw) : {} };
  } catch {
    return { raw, json: {} };
  }
}

function explainNonJsonApiFailure(status, raw) {
  if (/<!doctype html>/i.test(raw || '')) {
    if (status === 401 || status === 403) {
      return `HTTP ${status}: session expired or unauthorized. Please log in again.`;
    }
    return `HTTP ${status}: server returned HTML instead of JSON.`;
  }
  const snippet = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

function askReasonOrFallback(message, fallbackValue) {
  if (typeof window === 'undefined') return null;
  try {
    if (typeof window.prompt === 'function') {
      return window.prompt(message, fallbackValue);
    }
  } catch {
    // Continue to fallback confirmation below when prompt is unsupported.
  }
  const useFallback = window.confirm(
    `${message}\n\nThis browser does not support text prompts. Use default reason: "${fallbackValue}"?`,
  );
  return useFallback ? fallbackValue : null;
}

function isTemporaryStudentId(value) {
  return String(value || '').startsWith('tmp-');
}

function getStoredStudentId(student) {
  const studentId = String(student?.studentId || '').trim();
  if (studentId) return studentId;
  const id = String(student?.id || '').trim();
  return isTemporaryStudentId(id) ? '' : id;
}

function deriveGradeSelectionFromStudent(student) {
  const bucket = deriveGradeBucket({
    gradeSelection: student?.gradeSelection,
    grade: student?.grade,
    className: student?.className,
    homeroom: student?.effectiveHomeroom || student?.dbHomeroom || student?.homeroom,
  });
  return bucket === 'UNASSIGNED' ? '' : bucket;
}

function derivePathwayFromStudent(student) {
  return '';
}

function buildStudentDisplayName(student) {
  const firstName = String(student?.firstName || '').trim();
  const nickname = String(student?.nickname || '').trim();
  if (firstName && nickname) return `${firstName} (${nickname})`;
  return firstName || nickname || student?.name || '—';
}

function formatStudentGradeBadge(student) {
  const selection = deriveGradeSelectionFromStudent(student);
  if (!selection) return '—';
  return selection;
}

function formatStudentFinalClass(student) {
  const label = normalizeClassLabel({
    className: student?.className,
    homeroom: student?.effectiveHomeroom || student?.dbHomeroom || student?.homeroom,
    gradeSelection: student?.gradeSelection,
    grade: student?.grade,
  });
  return label === 'UNASSIGNED' ? null : label;
}

function compareClassLabel(a, b) {
  const A = String(a || '').toUpperCase();
  const B = String(b || '').toUpperCase();
  const eyA = /^EY(\d+)$/.exec(A);
  const eyB = /^EY(\d+)$/.exec(B);
  if (eyA && eyB) return Number(eyA[1]) - Number(eyB[1]);
  if (eyA) return -1;
  if (eyB) return 1;
  const numA = /^(\d+)([A-Z]*)$/.exec(A);
  const numB = /^(\d+)([A-Z]*)$/.exec(B);
  if (numA && numB) {
    const n = Number(numA[1]) - Number(numB[1]);
    if (n !== 0) return n;
    return numA[2].localeCompare(numB[2]);
  }
  return A.localeCompare(B);
}

function summarizeClassSubmissions(records = []) {
  const bucket = new Map();
  records.forEach((rec) => {
    const parentName = String(rec?.guardian?.name || 'Unknown parent').trim() || 'Unknown parent';
    const parentEmail = String(rec?.guardian?.email || '').trim();
    const parentPhone = String(rec?.guardian?.phone || '').trim();
    const status = String(rec?.status || 'pending');
    const submittedAt = rec?.submittedAt || null;
    const recordId = String(rec?.id || `${parentName}-${rec?.submittedAt || ''}`);
    (rec.students || []).forEach((student) => {
      const classLabel = (
        formatStudentFinalClass(student)
        || deriveGradeSelectionFromStudent(student)
        || String(student?.homeroom || '').trim().toUpperCase()
        || 'UNASSIGNED'
      );
      const studentName = buildStudentDisplayName(student);
      const studentId = getStoredStudentId(student) || null;
      const studentKey = studentId || `${studentName.toLowerCase()}::${classLabel}`;
      const pairKey = `${recordId}::${studentKey}::${parentName.toLowerCase()}`;

      if (!bucket.has(classLabel)) {
        bucket.set(classLabel, {
          classLabel,
          forms: new Set(),
          studentKeys: new Set(),
          pairKeys: new Set(),
          statusCounts: {
            pending: 0,
            changes_requested: 0,
            approved: 0,
            rejected: 0,
          },
          entries: [],
        });
      }
      const row = bucket.get(classLabel);
      row.forms.add(recordId);
      row.studentKeys.add(studentKey);
      if (Object.prototype.hasOwnProperty.call(row.statusCounts, status)) {
        row.statusCounts[status] += 1;
      }
      if (!row.pairKeys.has(pairKey)) {
        row.pairKeys.add(pairKey);
        row.entries.push({
          classLabel,
          recordId,
          studentName,
          studentId,
          parentName,
          parentEmail,
          parentPhone,
          status,
          submittedAt,
        });
      }
    });
  });

  return [...bucket.values()]
    .map((row) => ({
      classLabel: row.classLabel,
      formsCount: row.forms.size,
      studentsCount: row.studentKeys.size,
      statusCounts: row.statusCounts,
      entries: row.entries.sort((a, b) => {
        const ta = Date.parse(a.submittedAt || 0);
        const tb = Date.parse(b.submittedAt || 0);
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && tb !== ta) return tb - ta;
        return a.studentName.localeCompare(b.studentName);
      }),
    }))
    .sort((a, b) => compareClassLabel(a.classLabel, b.classLabel));
}

// Rebuild onboarding-record shapes from the flat per-student rows returned by
// the grade-workbook endpoint (?format=json) so the class tracker can cover
// ALL forms across every status, not just the currently open tab.
function recordsFromFlatRows(flatRows = []) {
  const map = new Map();
  flatRows.forEach((r) => {
    const id = String(r.submissionId || '');
    if (!id) return;
    if (!map.has(id)) {
      map.set(id, {
        id,
        status: r.statusRaw || r.status || 'pending',
        submittedAt: r.submittedAt || null,
        guardian: { name: r.guardianName || '', email: r.guardianEmail || '', phone: r.guardianPhone || '' },
        students: [],
      });
    }
    map.get(id).students.push({
      id: r.studentId || null,
      name: r.studentName || '',
      homeroom: r.sourceHomeroom || '',
      effectiveHomeroom: r.effectiveHomeroom || '',
    });
  });
  return [...map.values()];
}

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
  const [counts, setCounts] = useState({ pending: 0, changes_requested: 0, approved: 0, rejected: 0, archived: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [working, setWorking] = useState({});       // recordId -> 'approve'|'reject'|'reenroll'
  const [selectedId, setSelectedId] = useState(null); // recordId currently open in detail drawer
  // When set, the detail drawer opens with the AddChaperonePanel pre-expanded
  // so the admin lands directly on the new-chaperone form.
  const [autoAddChaperone, setAutoAddChaperone] = useState(false);
  const [rejectingId, setRejectingId] = useState(null);  // inline reject form
  const [rejectReason, setRejectReason] = useState('');
  const [messagingId, setMessagingId] = useState(null);  // inline "message parent" form
  const [messageText, setMessageText] = useState('');
  const [lightbox, setLightbox] = useState(null);
  const [thumbnails, setThumbnails] = useState({});
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'card'

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('pickup_admin_view_mode');
      if (saved === 'card' || saved === 'list') {
        setViewMode(saved);
      }
    }
  }, []);

  const changeViewMode = (mode) => {
    setViewMode(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('pickup_admin_view_mode', mode);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const [selected, setSelected] = useState({});     // recordId -> bool
  const [bulkBusy, setBulkBusy] = useState(false);
  const [printRec, setPrintRec] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [submissionTracker, setSubmissionTracker] = useState([]);

  // Top-level view switch.
  // Driven by the sidebar query; no in-page toggle.
  const router = useRouter();
  const [view, setView] = useState('onboarding');
  useEffect(() => {
    if (!router.isReady) return;
    const v = String(router.query.view || '').toLowerCase();
    setView(v === 'settings' ? 'settings' : v === 'invites' ? 'invites' : 'onboarding');
  }, [router.isReady, router.query.view]);

  // ─── Pickup settings state ──────────────────────────────────────────────
  const [pickupSettings, setPickupSettings] = useState(null);  // null = loading
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [pickupScheduleDraft, setPickupScheduleDraft] = useState({
    defaultOpen: '',
    defaultClose: '',
    friOpen: '',
    friClose: '',
  });
  const [scheduleGroups, setScheduleGroups] = useState([]);
  const [scheduleGroupsLoading, setScheduleGroupsLoading] = useState(false);
  const [poleSchedules, setPoleSchedules] = useState([]);
  const [poleSchedulesLoading, setPoleSchedulesLoading] = useState(false);

  useEffect(() => {
    if (view !== 'settings') return;
    fetch('/api/pickup/admin/settings', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) return;
        const settings = j.settings || {};
        setPickupSettings(settings);
        setPickupScheduleDraft({
          defaultOpen: settings?.pickupWindow?.start || '10:00',
          defaultClose: settings?.pickupWindow?.end || '13:00',
          friOpen: settings?.pickupWindowByDay?.fri?.start || settings?.pickupWindow?.start || '10:00',
          friClose: settings?.pickupWindowByDay?.fri?.end || settings?.pickupWindow?.end || '13:00',
        });
      })
      .catch(() => {});
  }, [view]);

  useEffect(() => {
    if (view !== 'settings') return;
    setScheduleGroupsLoading(true);
    fetch('/api/pickup/admin/release-groups', { credentials: 'include' })
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        setScheduleGroups(Array.isArray(j.groups) ? j.groups : []);
      })
      .catch(() => setScheduleGroups([]))
      .finally(() => setScheduleGroupsLoading(false));
  }, [view]);

  useEffect(() => {
    if (view !== 'settings') return;
    setPoleSchedulesLoading(true);
    fetch('/api/pickup/admin/terminals', { credentials: 'include' })
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok || !j?.terminals) throw new Error(j?.error || `HTTP ${r.status}`);
        const map = new Map();
        (j.terminals || [])
          .filter((t) => t && t.enabled !== false)
          .forEach((t) => {
            const pole = String(t.gateLabel || '').trim();
            if (!/^Pole\s+[1-5]$/i.test(pole)) return;
            const open = String(t.windowOpen || '').trim();
            const close = String(t.windowClose || '').trim();
            const key = `${open}-${close}`;
            if (!map.has(pole)) {
              map.set(pole, {
                pole,
                schedules: new Set(),
                terminals: 0,
              });
            }
            const row = map.get(pole);
            row.terminals += 1;
            if (open && close) row.schedules.add(key);
          });

        const ordered = [1, 2, 3, 4, 5].map((n) => {
          const pole = `Pole ${n}`;
          const row = map.get(pole);
          if (!row) return { pole, terminals: 0, configured: false, open: null, close: null, drift: false };
          const list = [...row.schedules];
          const first = list[0] || '';
          const [open, close] = first ? first.split('-') : [null, null];
          return {
            pole,
            terminals: row.terminals,
            configured: Boolean(open && close),
            open,
            close,
            drift: list.length > 1,
          };
        });
        setPoleSchedules(ordered);
      })
      .catch(() => setPoleSchedules([]))
      .finally(() => setPoleSchedulesLoading(false));
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

  async function savePickupSchedule() {
    const { defaultOpen, defaultClose, friOpen, friClose } = pickupScheduleDraft;
    const valid = (v) => /^\d{2}:\d{2}$/.test(String(v || ''));
    if (!valid(defaultOpen) || !valid(defaultClose) || !valid(friOpen) || !valid(friClose)) {
      pushToast('error', 'Please provide valid HH:MM values for all schedule fields.');
      return;
    }
    setSettingsBusy(true);
    try {
      const payload = {
        pickupWindow: { start: defaultOpen, end: defaultClose },
        pickupWindowByDay: {
          ...((pickupSettings && pickupSettings.pickupWindowByDay) || {}),
          fri: { start: friOpen, end: friClose, closedAllDay: false },
        },
      };
      const r = await fetch('/api/pickup/admin/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'schedule update failed');
      setPickupSettings((s) => ({
        ...(s || {}),
        pickupWindow: payload.pickupWindow,
        pickupWindowByDay: payload.pickupWindowByDay,
      }));
      pushToast('success', 'Pickup schedule saved and synced to all terminals.');
    } catch (e) {
      pushToast('error', e.message || 'Failed to save pickup schedule');
    } finally {
      setSettingsBusy(false);
    }
  }

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

  const fetchList = useCallback(async (status, queryText = '') => {
    const params = new URLSearchParams({ status, limit: queryText ? '150' : '100' });
    if (queryText) params.set('q', queryText);
    const r = await fetch(`/api/pickup/admin/onboarding-list?${params.toString()}`, {
      credentials: 'include',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || j.message || 'fetch failed');
    return j.records || [];
  }, []);

  const fetchCounts = useCallback(async () => {
    const r = await fetch('/api/pickup/admin/forms-summary', { credentials: 'include' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || j.message || 'count fetch failed');
    const c = j.counts || {};
    return {
      pending: Number(c.pending || 0),
      changes_requested: Number(c.changes_requested || 0),
      approved: Number(c.approved || 0),
      rejected: Number(c.rejected || 0),
      archived: Number(c.archived || 0),
    };
  }, []);

  const fetchTracker = useCallback(async () => {
    const r = await fetch('/api/pickup/admin/onboarding-grade-workbook?status=all&format=json', {
      credentials: 'include',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || j.message || 'tracker fetch failed');
    return j.rows || [];
  }, []);

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [tabRows, nextCounts, trackerRows] = await Promise.all([
        fetchList(tab, debouncedSearch).catch(() => []),
        fetchCounts().catch(() => null),
        fetchTracker().catch(() => null),
      ]);

      if (nextCounts) setCounts(nextCounts);
      setRecords(tabRows);
      // Prefer the all-status tracker; fall back to current tab rows if it fails.
      setSubmissionTracker(summarizeClassSubmissions(
        trackerRows ? recordsFromFlatRows(trackerRows) : tabRows,
      ));
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [tab, debouncedSearch, fetchList, fetchCounts, fetchTracker]);

  useEffect(() => { reload(); }, [reload]);

  // Refresh pending count badge every 15s
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const nextCounts = await fetchCounts();
        setCounts(nextCounts);
        if (tab === 'pending') {
          const list = await fetchList('pending', debouncedSearch);
          setRecords(list);
          // NOTE: do NOT rebuild the tracker from pending-only rows — it covers
          // all statuses and is refreshed by reload().
        }
      } catch {}
    }, 15000);
    return () => clearInterval(t);
  }, [tab, debouncedSearch, fetchList, fetchCounts]);

  // Clear selection when tab changes
  useEffect(() => { setSelected({}); setRejectingId(null); setMessagingId(null); }, [tab]);

  // ─── Detail drawer URL sync (?pkp=<id>) ─────────────────────────────────
  useEffect(() => {
    if (!router.isReady) return;
    const p = router.query.pkp;
    if (typeof p === 'string' && p) setSelectedId(p);
    else setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.pkp]);

  // Push selectedId into URL (shallow, no scroll)
  useEffect(() => {
    if (!router.isReady) return;
    if (view !== 'onboarding') return;
    const cur = router.query.pkp;
    if ((cur || '') === (selectedId || '')) return;
    const next = { ...router.query };
    if (selectedId) next.pkp = selectedId;
    else delete next.pkp;
    router.replace({ pathname: router.pathname, query: next }, undefined, { shallow: true, scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, view, router.isReady]);

  // Esc closes drawer
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e) => { if (e.key === 'Escape') setSelectedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const selectedRecord = useMemo(
    () => (selectedId ? records.find((r) => r.id === selectedId) || null : null),
    [selectedId, records]
  );

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
    if (file.size > 8 * 1024 * 1024) {
      pushToast('error', 'Photo must be ≤ 8 MB.');
      return;
    }
    // Compress to ≤190KB — Hikvision terminals reject face photos >200KB.
    let dataUrl;
    try {
      dataUrl = await compressImageToJpegDataUrl(file, { maxDim: 1024, maxBytes: 190 * 1024 });
    } catch (e) {
      pushToast('error', `Could not process image: ${e.message}`);
      return;
    }
    try {
      const r = await fetch('/api/pickup/admin/chaperone-photos', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          chaperoneId,
          replace,
          photos: [{ imageBase64: dataUrl }],
        }),
      });
      const { raw, json } = await parseApiPayload(r);
      if (!r.ok) {
        throw new Error(
          json.message
          || json.error
          || explainNonJsonApiFailure(r.status, raw)
        );
      }
      if (json.enrollmentOk) {
        pushToast('success', `Chaperone photo ${replace ? 'replaced' : 'added'} and enrolled on terminals.`);
      } else {
        pushToast('warn', `Chaperone photo ${replace ? 'replaced' : 'added'}, but enrollment needs attention. Open Pickup Enroll and retry.`);
      }
      reload();
    } catch (e) {
      pushToast('error', `Upload failed: ${e.message}`);
    }
  }, [reload]);

  const deleteChaperonePhoto = useCallback(async (chaperoneId, photoPath, { all = false } = {}) => {
    if (!chaperoneId || (!photoPath && !all)) return false;
    try {
      const r = await fetch('/api/pickup/admin/chaperone-photos', {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({ chaperoneId, photoPath, all }),
      });
      const { raw, json } = await parseApiPayload(r);
      if (!r.ok) {
        throw new Error(json.message || json.error || explainNonJsonApiFailure(r.status, raw));
      }
      pushToast('success', all ? 'All chaperone photos removed.' : 'Chaperone photo removed.');
      reload();
      return true;
    } catch (e) {
      pushToast('error', `Delete failed: ${e.message}`);
      return false;
    }
  }, [reload]);

  // Edit / delete chaperone or student inside a pending onboarding record.
  // Used by the per-section Edit / Delete action buttons.
  const submitOnboardingEdit = useCallback(async (payload) => {
    if (payload?.action === 'delete-approved-chaperone') {
      try {
        const reason = String(payload.reason || '').trim();
        const chaperoneId = String(payload.chaperoneId || '').trim();
        if (!reason || !chaperoneId) {
          throw new Error('missing delete reason or chaperone id');
        }
        const r = await fetch('/api/pickup/admin/chaperone-delete', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chaperoneId, reason }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || j.error || 'delete failed');
        const failedDevices = (j.deviceRemoval?.devices || []).filter((d) => d.ok === false);
        if (failedDevices.length > 0) {
          pushToast('warn', `Chaperone deleted, but ${failedDevices.length} terminal(s) reported unenroll errors.`);
        } else {
          pushToast('success', 'Chaperone deleted and removed from terminals.');
        }
        reload();
        return true;
      } catch (e) {
        pushToast('error', `Delete failed: ${e.message}`);
        return false;
      }
    }
    try {
      const r = await fetch('/api/pickup/admin/onboarding-edit', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || 'edit failed');
      const targetLabel = payload.target === 'chaperone' ? 'Chaperone'
        : payload.target === 'record' ? 'Chaperone'
        : 'Student';
      const verb = payload.action === 'delete' ? 'removed'
        : payload.action === 'delete-face' ? 'photo removed'
        : payload.action === 'add-chaperone' ? 'added'
        : 'updated';
      pushToast('success', `${targetLabel} ${verb}.`);
      reload();
      return true;
    } catch (e) {
      pushToast('error', `Edit failed: ${e.message}`);
      return false;
    }
  }, [reload]);

  // Admin uploads a NEW face photo into a still-pending chaperone (no allocated
  // chaperoneId yet, so the regular chaperone-photos endpoint can't be used).
  // Pre-approval flow only — uses onboarding-edit's `add-face` action.
  const uploadPendingChaperoneFace = useCallback(async ({ recordId, tempId, file }) => {
    if (!file) return false;
    if (!/^image\/(jpe?g|png|webp)$/i.test(file.type)) {
      pushToast('error', 'Photo must be JPEG, PNG or WebP.');
      return false;
    }
    if (file.size > 8 * 1024 * 1024) {
      pushToast('error', 'Photo must be ≤ 8 MB.');
      return false;
    }
    try {
      // Compress to ≤190KB — Hikvision terminals reject face photos >200KB.
      const dataUrl = await compressImageToJpegDataUrl(file, { maxDim: 1024, maxBytes: 190 * 1024 });
      const r = await fetch('/api/pickup/admin/onboarding-edit', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recordId, target: 'chaperone', tempId,
          action: 'add-face', imageBase64: dataUrl,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || 'upload failed');
      pushToast('success', 'Face photo added to pending submission.');
      reload();
      return true;
    } catch (e) {
      pushToast('error', `Photo upload failed: ${e.message}`);
      return false;
    }
  }, [reload]);

  // ─── Filtered + sorted view ─────────────────────────────────────────────
  const visibleRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = records;
    if (q) {
      list = list.filter((r) => {
        const hay = [
          r.id,
          r.formNumber,
          r.guardian?.name, r.guardian?.email, r.guardian?.phone,
          ...(r.students || []).flatMap((s) => [s.name, s.firstName, s.nickname, s.dbName, s.id, s.studentId, s.homeroom, deriveGradeSelectionFromStudent(s), formatStudentFinalClass(s)]),
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

  // J/K to navigate between records when drawer is open
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'J' && e.key !== 'K') return;
      const idx = visibleRecords.findIndex((r) => r.id === selectedId);
      if (idx < 0) return;
      const dir = (e.key === 'j' || e.key === 'J') ? 1 : -1;
      const next = visibleRecords[idx + dir];
      if (next) setSelectedId(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, visibleRecords]);

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
      `This only approves and allocates ${rec.chaperones.length} chaperone employeeNo(s) (9XXXXXXXXX).\n` +
      `It does not push to terminals automatically.\n\n` +
      `Next step: use Chaperone Enrolment to push chaperones to terminals.`)) return;
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
      pushToast(
        'success',
        `Approved and allocated ${allocated} chaperone(s). Next: open Chaperone Enrolment to push them to terminals.`,
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

  // Ask the parent for a fix (new photo, corrected details) WITHOUT reopening
  // the form — parent replies to the ACOP inbox / WhatsApp, ACOP applies the
  // change with the onboarding editor. No re-submission, no duplicate docs.
  async function submitRequestChanges(rec) {
    const message = messageText.trim();
    if (message.length < 4) return pushToast('warn', 'Message must be at least 4 characters.');
    setWorking((w) => ({ ...w, [rec.id]: 'message' }));
    try {
      const r = await fetch('/api/pickup/admin/request-changes', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: rec.id, message }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'request failed');
      pushToast('success',
        `Email queued to ${j.to}. Their reply goes to the ACOP inbox — apply it on this form, no re-submission needed.`,
        'Message sent to parent');
      setMessagingId(null); setMessageText('');
      await reload();
    } catch (e) { pushToast('error', e.message, 'Message failed'); }
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
  // Photos are no longer required at the student level — chaperone photos
  // are the only biometric the gate uses for verification.
  const blockedSelectedIds = [];
  const bulkApproveBlocked = false;

  async function bulkApprove() {
    if (selectedIds.length === 0) return;
    if (bulkApproveBlocked) return;
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
    const reason = prompt(`Reject ${selectedIds.length} submission(s)?\n\n` +
      `Rejection note (min 4 chars) — this is attached to the email sent to each parent:`);
    if (reason === null) return; // cancelled
    if (reason.trim().length < 4) {
      return pushToast('warn', 'A rejection note (min 4 characters) is required — it is emailed to the parents.');
    }
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

  // Archive = soft hide. Keeps all data; admin can restore from Archived tab.
  async function bulkArchive() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Archive ${selectedIds.length} submission(s)?\n\n` +
      `They will move to the Archived tab and can be restored anytime. ` +
      `Approved chaperones already pushed to terminals stay enrolled.`)) return;
    setBulkBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/bulk-action', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive', recordIds: selectedIds }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'bulk archive failed');
      const okN = (j.results || []).filter((x) => x.ok).length;
      const failN = (j.results || []).filter((x) => !x.ok).length;
      pushToast(failN > 0 ? 'warn' : 'success',
        `${okN} archived, ${failN} failed.`, 'Bulk archive complete');
      setSelected({});
      await reload();
    } catch (e) { pushToast('error', e.message, 'Bulk archive failed'); }
    finally { setBulkBusy(false); }
  }

  async function bulkUnarchive() {
    if (selectedIds.length === 0) return;
    if (!confirm(`Restore ${selectedIds.length} submission(s) to their previous status?`)) return;
    setBulkBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/bulk-action', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unarchive', recordIds: selectedIds }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'bulk restore failed');
      const okN = (j.results || []).filter((x) => x.ok).length;
      const failN = (j.results || []).filter((x) => !x.ok).length;
      pushToast(failN > 0 ? 'warn' : 'success',
        `${okN} restored, ${failN} failed.`, 'Bulk restore complete');
      setSelected({});
      await reload();
    } catch (e) { pushToast('error', e.message, 'Bulk restore failed'); }
    finally { setBulkBusy(false); }
  }

  // Hard delete — only allowed from Archived tab as a safety gate.
  // Requires the user to type DELETE to confirm.
  async function bulkDelete() {
    if (selectedIds.length === 0) return;
    const typed = prompt(
      `PERMANENTLY DELETE ${selectedIds.length} submission(s)?\n\n` +
      `This cannot be undone. Staged photos will be wiped.\n` +
      `Already-allocated chaperones on Hikvision terminals are NOT removed — ` +
      `manage those from the chaperone admin page if needed.\n\n` +
      `Type DELETE (uppercase) to confirm:`
    );
    if (typed !== 'DELETE') {
      if (typed != null) pushToast('warn', 'Deletion cancelled (must type DELETE).');
      return;
    }
    setBulkBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/bulk-action', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', recordIds: selectedIds }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'bulk delete failed');
      const okN = (j.results || []).filter((x) => x.ok).length;
      const failN = (j.results || []).filter((x) => !x.ok).length;
      pushToast(failN > 0 ? 'warn' : 'success',
        `${okN} deleted, ${failN} failed.`, 'Bulk delete complete');
      setSelected({});
      await reload();
    } catch (e) { pushToast('error', e.message, 'Bulk delete failed'); }
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
        <PageGuard feature="pickup_admin" action="view" what="open pickup admin">
        <ToastHost toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />

        <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[90rem] mx-auto">
          {/* Page header (shared) */}
          <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-r from-brand-500/[0.12] via-slate-900/70 to-slate-950/70 px-5 py-5 mb-6">
            <div className="pointer-events-none absolute -top-20 -right-16 w-64 h-64 rounded-full bg-brand-500/10 blur-3xl" aria-hidden></div>
            <div className="relative flex items-end justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4 min-w-0">
                <span className="w-12 h-12 rounded-2xl bg-brand-500/20 border border-brand-500/30 text-brand-300 flex items-center justify-center text-2xl flex-shrink-0">
                  <i className="ph ph-hand-waving"></i>
                </span>
                <div className="min-w-0">
                  <h1 className="text-2xl font-bold text-white tracking-tight">
                    Pickup System Admin
                  </h1>
                  <p className="text-sm text-slate-400 mt-0.5">
                    {view === 'invites'
                      ? 'Generate and manage open-ended onboarding links to share with parents.'
                      : 'Review parent-submitted authorizations. Approve to allocate a chaperone ID and push the face to all pickup terminals.'}
                  </p>
                </div>
              </div>
              {view === 'onboarding' && (
                <div className="flex items-center gap-2">
                  <button onClick={reload}
                    className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-white/5 border border-slate-700 text-slate-200 hover:bg-white/10 hover:border-slate-500 transition-colors">
                    <i className="ph ph-arrows-clockwise mr-1.5"></i>Refresh
                  </button>
                </div>
              )}
            </div>
          </div>

          {view === 'invites' ? (
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

                  <div className="rounded-xl bg-white/5 border border-slate-800 px-5 py-4">
                    <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
                      <div>
                        <p className="text-sm font-medium text-white">Pickup time settings (single source)</p>
                        <p className="text-xs text-slate-400 mt-0.5 max-w-xl">
                          Mon-Thu uses grade-specific windows from Release Groups first. Friday uses one global window for all poles/gates.
                          The default fallback below is only used when a release group has no grade window for that class.
                          Values shown come from Firestore and stay active until an admin saves an override.
                        </p>
                      </div>
                      <button
                        disabled={settingsBusy}
                        onClick={savePickupSchedule}
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-500/20 border border-brand-500/40 text-brand-200 hover:bg-brand-500/30 disabled:opacity-50"
                      >
                        {settingsBusy ? 'Saving…' : 'Save pickup schedule'}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3">
                        <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Default fallback (Mon-Thu only, if no grade window exists for that class)</p>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">Open (WIB)</label>
                            <input
                              type="time"
                              value={pickupScheduleDraft.defaultOpen || ''}
                              onChange={(e) => setPickupScheduleDraft((s) => ({ ...s, defaultOpen: e.target.value }))}
                              className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">Close (WIB)</label>
                            <input
                              type="time"
                              value={pickupScheduleDraft.defaultClose || ''}
                              onChange={(e) => setPickupScheduleDraft((s) => ({ ...s, defaultClose: e.target.value }))}
                              className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3">
                        <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Friday global override (all gates)</p>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">Open (WIB)</label>
                            <input
                              type="time"
                              value={pickupScheduleDraft.friOpen || ''}
                              onChange={(e) => setPickupScheduleDraft((s) => ({ ...s, friOpen: e.target.value }))}
                              className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">Close (WIB)</label>
                            <input
                              type="time"
                              value={pickupScheduleDraft.friClose || ''}
                              onChange={(e) => setPickupScheduleDraft((s) => ({ ...s, friClose: e.target.value }))}
                              className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-emerald-700/30 bg-emerald-900/10 px-4 py-3">
                      <p className="text-[11px] uppercase tracking-wider text-emerald-300 font-semibold">Currently active in Firestore</p>
                      <p className="text-xs text-emerald-100/90 mt-1">
                        Default fallback (used only when no grade window exists): {(pickupSettings?.pickupWindow?.start || '--:--')} - {(pickupSettings?.pickupWindow?.end || '--:--')} WIB
                      </p>
                      <p className="text-xs text-emerald-100/90 mt-0.5">
                        Friday global: {(pickupSettings?.pickupWindowByDay?.fri?.start || pickupSettings?.pickupWindow?.start || '--:--')} - {(pickupSettings?.pickupWindowByDay?.fri?.end || pickupSettings?.pickupWindow?.end || '--:--')} WIB
                      </p>
                    </div>

                    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3">
                      <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Mon-Thu live pole schedule (terminal docs)</p>
                      <p className="text-xs text-slate-400 mt-1">
                        This is the actual schedule currently applied per pole in terminal records.
                      </p>
                      {poleSchedulesLoading ? (
                        <div className="text-xs text-slate-500 mt-2">Loading pole schedules…</div>
                      ) : poleSchedules.length === 0 ? (
                        <div className="text-xs text-slate-500 mt-2">No pole schedule data found.</div>
                      ) : (
                        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                          {poleSchedules.map((p) => (
                            <div key={p.pole} className="rounded border border-slate-800 px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-xs font-semibold text-slate-200">{p.pole}</div>
                                <div className="text-[10px] text-slate-500">{p.terminals} terminal(s)</div>
                              </div>
                              <div className="text-[11px] mt-1 text-slate-300">
                                {p.configured ? `${p.open}-${p.close} WIB` : 'Not configured'}
                              </div>
                              {p.drift ? (
                                <div className="text-[10px] mt-1 text-amber-300">Warning: terminals in this pole are not aligned.</div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Mon-Thu grade windows (Release Groups)</p>
                          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
                            Grade-level pickup windows are managed per pole in Release Groups and are used before fallback windows.
                            ACOP should edit those windows there.
                          </p>
                          <p className="text-[11px] text-slate-500 mt-1">
                            Friday shown in each pole below is the same global Friday window from Firestore.
                          </p>
                        </div>
                        <a
                          href="/v2/release-groups"
                          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white/5 border border-slate-700 text-slate-200 hover:bg-white/10"
                        >
                          Open Release Groups
                        </a>
                      </div>
                      {scheduleGroupsLoading ? (
                        <div className="text-xs text-slate-500 mt-2">Loading group windows…</div>
                      ) : scheduleGroups.length === 0 ? (
                        <div className="text-xs text-slate-500 mt-2">No release groups found.</div>
                      ) : (
                        <div className="mt-2 space-y-2">
                          {scheduleGroups.map((g) => {
                            const gw = (g && g.gradeWindowByLabel && typeof g.gradeWindowByLabel === 'object') ? g.gradeWindowByLabel : {};
                            const keys = Object.keys(gw);
                            const fallbackOpen = pickupSettings?.pickupWindow?.start || '--:--';
                            const fallbackClose = pickupSettings?.pickupWindow?.end || '--:--';
                            const friOpen = pickupSettings?.pickupWindowByDay?.fri?.start || pickupSettings?.pickupWindow?.start || '--:--';
                            const friClose = pickupSettings?.pickupWindowByDay?.fri?.end || pickupSettings?.pickupWindow?.end || '--:--';
                            return (
                              <div key={g.id} className="rounded border border-slate-800 px-3 py-2">
                                <div className="text-xs font-semibold text-slate-200">{g.name || g.id}</div>
                                <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-2">
                                  <div className="rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5">
                                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Mon-Thu effective</div>
                                    {keys.length === 0 ? (
                                      <div className="text-[11px] text-slate-400 mt-1">
                                        Uses fallback for all classes: {fallbackOpen}-{fallbackClose}
                                      </div>
                                    ) : (
                                      <div className="text-[11px] text-slate-400 mt-1">
                                        Grade windows apply for listed classes. Any missing class uses fallback {fallbackOpen}-{fallbackClose}.
                                      </div>
                                    )}
                                  </div>
                                  <div className="rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5">
                                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Friday (all classes)</div>
                                    <div className="text-[11px] text-slate-300 mt-1">{friOpen}-{friClose}</div>
                                  </div>
                                </div>
                                {keys.length === 0 ? (
                                  <div className="text-[11px] text-slate-500 mt-1">No grade-specific windows (uses fallback).</div>
                                ) : (
                                  <div className="text-[11px] text-slate-400 mt-1 flex flex-wrap gap-2">
                                    {keys.sort().map((k) => (
                                      <span key={`${g.id}-${k}`} className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700">
                                        {k}: {gw[k]?.open || '--:--'}-{gw[k]?.close || '--:--'}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
          <>

            {/* TV feed tile intentionally disabled for now (cost optimization). */}
            {ENABLE_PICKUP_TV_TILE ? <LiveGateTile /> : null}

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

          <SubmissionTrackerPanel rows={submissionTracker} onToast={pushToast} />

          {/* Tabs + search + sort row */}
          <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
            <div className="flex gap-1 bg-slate-900/70 backdrop-blur p-1 rounded-xl border border-slate-800">
              {TABS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all relative ${
                    tab === t.key
                      ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                  }`}>
                  {t.label}
                  <span className={`ml-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold ${
                    tab === t.key ? 'bg-white/20 text-white' :
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
                  className="w-full bg-slate-900/70 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500/60 focus:ring-2 focus:ring-brand-500/20 transition-shadow" />
                {search && (
                  <button onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                    <i className="ph ph-x"></i>
                  </button>
                )}
              </div>
              <select value={sort} onChange={(e) => setSort(e.target.value)}
                className="bg-slate-900/70 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-brand-500/60">
                {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              <div className="flex items-center gap-1 p-1 bg-slate-900/70 backdrop-blur border border-slate-800 rounded-xl">
                <button
                  onClick={() => changeViewMode('list')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                    viewMode === 'list'
                      ? 'bg-brand-500 text-white shadow-sm font-semibold'
                      : 'text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                  title="List View (Data Table)"
                >
                  <i className="ph ph-rows text-base"></i>
                  <span className="hidden sm:inline">List</span>
                </button>
                <button
                  onClick={() => changeViewMode('card')}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                    viewMode === 'card'
                      ? 'bg-brand-500 text-white shadow-sm font-semibold'
                      : 'text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                  title="Grid View (Cards)"
                >
                  <i className="ph ph-squares-four text-base"></i>
                  <span className="hidden sm:inline">Grid</span>
                </button>
              </div>
            </div>
          </div>

          {/* Bulk action bar — visible on all tabs; buttons are contextual */}
          <div className="flex items-center gap-3 mb-4 px-4 py-2.5 rounded-xl bg-slate-900/60 backdrop-blur border border-slate-800">
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
                {/* Pending-tab actions */}
                {tab === 'pending' && (
                  <>
                    <button onClick={bulkReject} disabled={bulkBusy}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 disabled:opacity-50">
                      {bulkBusy ? 'Working…' : <><i className="ph ph-x mr-1"></i>Reject {selectedIds.length}</>}
                    </button>
                    <button onClick={bulkApprove} disabled={bulkBusy || bulkApproveBlocked}
                      title={bulkApproveBlocked
                        ? `${blockedSelectedIds.length} selected submission(s) are missing student photos.`
                        : 'Approve and allocate chaperone IDs for all selected submissions'}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
                      {bulkBusy ? 'Approving…' : <><i className="ph ph-check mr-1"></i>Approve {selectedIds.length}</>}
                    </button>
                  </>
                )}
                {/* Archive — available on pending / approved / rejected */}
                {tab !== 'archived' && (
                  <button onClick={bulkArchive} disabled={bulkBusy}
                    title="Move selected submissions to the Archived tab (can be restored)"
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-500/15 border border-slate-500/40 text-slate-200 hover:bg-slate-500/25 disabled:opacity-50">
                    {bulkBusy ? 'Working…' : <><i className="ph ph-archive mr-1"></i>Archive {selectedIds.length}</>}
                  </button>
                )}
                {/* Archived-tab actions: restore + permanent delete */}
                {tab === 'archived' && (
                  <>
                    <button onClick={bulkUnarchive} disabled={bulkBusy}
                      title="Restore selected submissions to their previous status"
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-500/15 border border-sky-500/40 text-sky-200 hover:bg-sky-500/25 disabled:opacity-50">
                      {bulkBusy ? 'Working…' : <><i className="ph ph-arrow-counter-clockwise mr-1"></i>Restore {selectedIds.length}</>}
                    </button>
                    <button onClick={bulkDelete} disabled={bulkBusy}
                      title="Permanently delete the selected submissions (irreversible)"
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-500/15 border border-red-500/50 text-red-200 hover:bg-red-500/25 disabled:opacity-50">
                      {bulkBusy ? 'Working…' : <><i className="ph ph-trash mr-1"></i>Delete {selectedIds.length}</>}
                    </button>
                  </>
                )}
              </>
            )}
          </div>

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
            <div className="text-center py-16 bg-gradient-to-b from-slate-900/40 to-slate-950/40 rounded-2xl border border-slate-800/80">
              <span className="inline-flex w-14 h-14 rounded-2xl bg-slate-800/60 border border-slate-700/60 items-center justify-center text-slate-500 text-3xl mb-3">
                <i className="ph ph-tray"></i>
              </span>
              <p className="text-slate-400 text-sm">
                {search ? `No results for "${search}".` : `No ${tab === 'changes_requested' ? 'awaiting-parent' : tab} submissions.`}
              </p>
            </div>
          ) : viewMode === 'card' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visibleRecords.map((rec) => (
                <RecordCardGrid
                  key={rec.id}
                  rec={rec}
                  thumbnails={thumbnails}
                  selected={!!selected[rec.id]}
                  onToggleSelect={() => setSelected((s) => ({ ...s, [rec.id]: !s[rec.id] }))}
                  isActive={selectedId === rec.id}
                  onOpen={() => { setAutoAddChaperone(false); setSelectedId(rec.id); }}
                  onApprove={() => approve(rec)}
                  onStartReject={() => { setRejectingId(rec.id); setRejectReason(''); setSelectedId(rec.id); }}
                  onPrint={() => setPrintRec(rec)}
                  onAddChaperone={() => { setAutoAddChaperone(true); setSelectedId(rec.id); }}
                  busy={working[rec.id]}
                  showSelect={true}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleRecords.map((rec) => (
                <RecordCard
                  key={rec.id}
                  rec={rec}
                  thumbnails={thumbnails}
                  selected={!!selected[rec.id]}
                  onToggleSelect={() => setSelected((s) => ({ ...s, [rec.id]: !s[rec.id] }))}
                  isActive={selectedId === rec.id}
                  onOpen={() => { setAutoAddChaperone(false); setSelectedId(rec.id); }}
                  onApprove={() => approve(rec)}
                  onStartReject={() => { setRejectingId(rec.id); setRejectReason(''); setSelectedId(rec.id); }}
                  onPrint={() => setPrintRec(rec)}
                  onAddChaperone={() => { setAutoAddChaperone(true); setSelectedId(rec.id); }}
                  busy={working[rec.id]}
                  showSelect={true}
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

        {/* Detail drawer (right slide-in) */}
        <DetailDrawer
          open={view === 'onboarding' && !!selectedRecord}
          rec={selectedRecord}
          thumbnails={thumbnails}
          onClose={() => { setSelectedId(null); setRejectingId(null); setMessagingId(null); setAutoAddChaperone(false); }}
          onApprove={selectedRecord ? () => approve(selectedRecord) : undefined}
          onStartReject={selectedRecord ? () => { setRejectingId(selectedRecord.id); setRejectReason(''); setMessagingId(null); } : undefined}
          onCancelReject={() => { setRejectingId(null); setRejectReason(''); }}
          onSubmitReject={selectedRecord ? () => submitReject(selectedRecord) : undefined}
          onStartMessage={selectedRecord ? () => { setMessagingId(selectedRecord.id); setMessageText(''); setRejectingId(null); } : undefined}
          onCancelMessage={() => { setMessagingId(null); setMessageText(''); }}
          onSubmitMessage={selectedRecord ? () => submitRequestChanges(selectedRecord) : undefined}
          onReenroll={selectedRecord ? () => reenroll(selectedRecord) : undefined}
          onPhoto={(url, caption) => setLightbox({ url, caption })}
          onPrint={selectedRecord ? () => setPrintRec(selectedRecord) : undefined}
          onUploadStudentPhoto={uploadStudentPhoto}
          onUploadChaperonePhoto={uploadChaperonePhoto}
          onDeleteChaperonePhoto={deleteChaperonePhoto}
          onUploadPendingChaperoneFace={uploadPendingChaperoneFace}
          onOnboardingEdit={submitOnboardingEdit}
          autoOpenAddChaperone={autoAddChaperone}
          onAddChaperoneHandled={() => setAutoAddChaperone(false)}
          busy={selectedRecord ? working[selectedRecord.id] : null}
          rejecting={selectedRecord ? rejectingId === selectedRecord.id : false}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          messaging={selectedRecord ? messagingId === selectedRecord.id : false}
          messageText={messageText}
          setMessageText={setMessageText}
          // siblings for prev/next nav
          prevId={(() => {
            if (!selectedRecord) return null;
            const i = visibleRecords.findIndex((r) => r.id === selectedRecord.id);
            return i > 0 ? visibleRecords[i - 1].id : null;
          })()}
          nextId={(() => {
            if (!selectedRecord) return null;
            const i = visibleRecords.findIndex((r) => r.id === selectedRecord.id);
            return i >= 0 && i < visibleRecords.length - 1 ? visibleRecords[i + 1].id : null;
          })()}
          onJump={(id) => setSelectedId(id)}
        />

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
        </PageGuard>
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
    let fallbackTimer = null;
    let stream = null;
    let reconnectTimer = null;
    let recycleTimer = null;

    const mergeEvent = (nextEvent) => {
      setEvents((prev) => {
        const next = [nextEvent, ...prev.filter((e) => e.id !== nextEvent.id)];
        return next.slice(0, 6);
      });
    };

    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const r = await fetch('/api/pickup/tv/feed?limit=6');
        const j = await r.json();
        if (stop) return;
        if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
        setErr(null);
        setEvents(Array.isArray(j.events) ? j.events.slice(0, 6) : []);
      } catch (e) {
        if (!stop) setErr(e.message);
      }
    };

    const closeStream = () => {
      if (stream) {
        stream.close();
        stream = null;
      }
    };

    const scheduleReconnect = () => {
      if (stop) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectStream();
      }, 5000);
    };

    const connectStream = () => {
      if (stop) return;
      closeStream();

      try {
        stream = new EventSource('/api/pickup/admin/admin-event-stream');
      } catch {
        scheduleReconnect();
        return;
      }

      stream.addEventListener('pickup_event', (ev) => {
        if (stop) return;
        try {
          const data = JSON.parse(ev.data || '{}');
          if (!data || !data.id) return;
          mergeEvent(data);
          setErr(null);
        } catch {}
      });

      stream.onerror = () => {
        if (stop) return;
        scheduleReconnect();
      };

      // Recycle before serverless stream timeout to avoid silent stalls.
      clearTimeout(recycleTimer);
      recycleTimer = setTimeout(() => {
        if (stop) return;
        connectStream();
      }, 4 * 60 * 1000);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        load();
        connectStream();
      } else {
        closeStream();
      }
    };

    load();
    connectStream();
    document.addEventListener('visibilitychange', onVisible);

    // Safety-net hydration in case events are missed during reconnects.
    fallbackTimer = setInterval(load, 30000);
    const tickInt = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      stop = true;
      clearInterval(tickInt);
      clearInterval(fallbackTimer);
      clearTimeout(reconnectTimer);
      clearTimeout(recycleTimer);
      document.removeEventListener('visibilitychange', onVisible);
      closeStream();
    };
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
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 flex items-center justify-center text-base flex-shrink-0">
            <i className="ph ph-broadcast"></i>
          </span>
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
  const [zoom, setZoom] = useState(false);
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

  // FR signal display
  const fr = ev.fr || {};
  const conf = typeof fr.confidence === 'number' ? Math.round(fr.confidence * 100) : null;
  const confTone = conf == null ? 'text-slate-500'
    : conf >= 90 ? 'text-emerald-300'
    : conf >= 70 ? 'text-amber-300' : 'text-red-300';
  const liveBad = fr.spoof === true || fr.livenessPassed === false;
  const showThumb = !!ev.capturePath;

  const card = (
    <div
      onClick={() => (showThumb || ev.enrolledPhotoUrl) && setZoom(true)}
      className={`flex items-center gap-3 rounded-lg border ${ring} px-3 py-2 ${(showThumb || ev.enrolledPhotoUrl) ? 'cursor-pointer hover:brightness-110' : ''}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot} flex-shrink-0`}></span>
      {showThumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ev.capturePath} alt="" className="w-8 h-8 rounded object-cover border border-slate-700 flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white font-medium truncate">
          {ev.chaperone?.name || '—'}
        </div>
        <div className="text-[11px] text-slate-400 truncate">
          {stuNames || ev.decision} · {ev.gate}
        </div>
        {(conf != null || liveBad) && (
          <div className="flex items-center gap-1.5 mt-0.5">
            {conf != null && (
              <span className={`text-[9px] font-mono font-semibold ${confTone}`}>{conf}%</span>
            )}
            {fr.livenessPassed === true && (
              <span className="text-[9px] font-semibold text-emerald-400/80 inline-flex items-center gap-0.5"><i className="ph ph-check-circle text-[10px]"></i>live</span>
            )}
            {liveBad && (
              <span className="text-[9px] font-semibold text-red-400 inline-flex items-center gap-0.5"><i className="ph ph-shield-warning text-[10px]"></i>spoof</span>
            )}
            {typeof fr.retries === 'number' && fr.retries > 1 && (
              <span className="text-[9px] text-slate-500">×{fr.retries}</span>
            )}
          </div>
        )}
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[10px] text-slate-500 tabular-nums">{agoStr}</div>
        {ev.overrideCode && !ev.officerOverride && (
          <div className="text-[11px] font-mono font-bold text-amber-300 tabular-nums">{ev.overrideCode}</div>
        )}
      </div>
    </div>
  );

  if (!zoom) return card;

  return (
    <>
      {card}
      <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setZoom(false)}>
        <div className="max-w-3xl w-full glass-panel rounded-2xl border border-slate-700 p-6" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-white font-semibold text-lg">{ev.chaperone?.name || 'Unknown'}</h3>
              <p className="text-xs text-slate-400">{ev.gate} · {agoStr}</p>
            </div>
            <button onClick={() => setZoom(false)} className="text-slate-400 hover:text-white"><i className="ph ph-x text-xl"></i></button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Enrolled</p>
              {ev.enrolledPhotoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ev.enrolledPhotoUrl} alt="" className="w-full aspect-square object-cover rounded-lg border border-emerald-500/30" />
              ) : (
                <div className="w-full aspect-square rounded-lg border border-slate-700 bg-slate-800 flex items-center justify-center text-slate-500 text-xs">No enrolled photo</div>
              )}
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">Captured at gate</p>
              {ev.capturePath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ev.capturePath} alt="" className={`w-full aspect-square object-cover rounded-lg border ${liveBad ? 'border-red-500/50' : 'border-sky-500/30'}`} />
              ) : (
                <div className="w-full aspect-square rounded-lg border border-slate-700 bg-slate-800 flex items-center justify-center text-slate-500 text-xs">No capture</div>
              )}
            </div>
          </div>
          {(conf != null || fr.livenessPassed != null || fr.spoof != null) && (
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              {conf != null && <span className={`px-2 py-1 rounded border border-slate-700 bg-slate-900/60 ${confTone}`}>Confidence <strong>{conf}%</strong></span>}
              {fr.livenessPassed != null && (
                <span className={`px-2 py-1 rounded border ${fr.livenessPassed ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10' : 'border-red-500/30 text-red-300 bg-red-500/10'}`}>
                  Liveness <strong>{fr.livenessPassed ? 'PASS' : 'FAIL'}</strong>
                  {typeof fr.liveness === 'number' && ` (${(fr.liveness * 100).toFixed(0)}%)`}
                </span>
              )}
              {fr.spoof === true && <span className="px-2 py-1 rounded border border-red-500/40 text-red-300 bg-red-500/10">SPOOF FLAGGED</span>}
              {fr.engine && <span className="px-2 py-1 rounded border border-slate-700 bg-slate-900/60 text-slate-400">engine: {fr.engine}</span>}
            </div>
          )}
        </div>
      </div>
    </>
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

  // Compute effective gate state mirroring lib/terminal-gate.js so the UI is
  // accurate without an extra round-trip.
  const effective = (t) => {
    const override = t.gateOverride === 'open' || t.gateOverride === 'closed' ? t.gateOverride : null;
    const parse = (s) => /^\d{2}:\d{2}$/.test(s || '') ? (parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3), 10)) : null;
    const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayKey = dayKeys[wib.getUTCDay()];
    const cur = wib.getUTCHours() * 60 + wib.getUTCMinutes();

    const dayWindow = (t.weeklyWindowByDay && typeof t.weeklyWindowByDay === 'object')
      ? t.weeklyWindowByDay[dayKey]
      : null;

    const sourceOpen = dayWindow && typeof dayWindow === 'object'
      ? (dayWindow.start || dayWindow.open || t.windowOpen)
      : t.windowOpen;
    const sourceClose = dayWindow && typeof dayWindow === 'object'
      ? (dayWindow.end || dayWindow.close || t.windowClose)
      : t.windowClose;
    const o = parse(sourceOpen);
    const c = parse(sourceClose);

    let scheduledOpen = true, configured = false;
    if (dayWindow && dayWindow.closedAllDay === true) {
      configured = true;
      scheduledOpen = false;
    } else if (o != null && c != null) {
      configured = true;
      scheduledOpen = o <= c ? (cur >= o && cur <= c) : (cur >= o || cur <= c);
    }

    const daySuffix = dayWindow && typeof dayWindow === 'object' ? ` (${dayKey.toUpperCase()})` : '';
    const scheduleLabel = configured
      ? `${sourceOpen || '--:--'} – ${sourceClose || '--:--'} WIB${daySuffix}`
      : 'No schedule (always open unless manually closed)';

    if (override === 'closed') return { open: false, reason: 'manual-closed', override, configured, scheduledOpen };
    if (override === 'open')   return { open: true,  reason: 'manual-open',   override, configured, scheduledOpen };
    if (configured)            return { open: scheduledOpen, reason: scheduledOpen ? 'in-window' : 'out-of-window', override: null, configured, scheduledOpen, scheduleLabel };
    return { open: true, reason: 'always-open', override: null, configured: false, scheduledOpen: true, scheduleLabel };
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
                      Schedule: {eff.scheduleLabel}
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

                <div className="mt-3 pt-3 border-t border-slate-800/80 text-[11px] text-slate-500">
                  Schedule is centrally managed in <span className="text-slate-300 font-semibold">Pickup time settings</span> above.
                  Use manual <span className="text-slate-300">Open/Auto/Close</span> here only for operational overrides.
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
    slate:   { card: 'from-slate-800/40 to-slate-950/60 border-slate-700/60',     chip: 'bg-slate-700/40 text-slate-300 border-slate-600/40',   value: 'text-white' },
    amber:   { card: 'from-amber-500/[0.14] to-slate-950/60 border-amber-500/30', chip: 'bg-amber-500/20 text-amber-300 border-amber-500/30',   value: 'text-amber-200' },
    emerald: { card: 'from-emerald-500/[0.12] to-slate-950/60 border-emerald-500/30', chip: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', value: 'text-emerald-200' },
    red:     { card: 'from-red-500/[0.14] to-slate-950/60 border-red-500/30',     chip: 'bg-red-500/20 text-red-300 border-red-500/30',         value: 'text-red-200' },
    brand:   { card: 'from-brand-500/[0.14] to-slate-950/60 border-brand-500/30', chip: 'bg-brand-500/20 text-brand-300 border-brand-500/30',   value: 'text-brand-200' },
  };
  const t = tones[tone] || tones.slate;
  return (
    <div className={`bg-gradient-to-br ${t.card} border rounded-2xl px-4 py-3.5 transition-transform duration-150 hover:-translate-y-0.5`}>
      <div className="flex items-center gap-3">
        {icon && (
          <span className={`w-10 h-10 rounded-xl border flex items-center justify-center text-lg flex-shrink-0 ${t.chip}`}>
            <i className={`ph ${icon}`}></i>
          </span>
        )}
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold truncate">{label}</div>
          <div className={`text-2xl font-bold leading-tight ${t.value}`}>{value}</div>
          {hint && <div className="text-[11px] text-slate-500 truncate">{hint}</div>}
        </div>
      </div>
    </div>
  );
}

function SubmissionTrackerPanel({ onToast }) {
  const [downloadingWb, setDownloadingWb] = useState(false);

  const downloadWorkbook = async () => {
    if (downloadingWb) return;
    setDownloadingWb(true);
    try {
      const r = await fetch('/api/pickup/admin/onboarding-grade-workbook?status=all', { credentials: 'include' });
      if (!r.ok) {
        let msg = `export failed (${r.status})`;
        try { const j = await r.json(); msg = j.message || j.error || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await r.blob();
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1] : 'BINUS-pickup-forms-by-class.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      onToast?.({ kind: 'ok', text: 'Workbook downloaded — one sheet per class.' });
    } catch (e) {
      onToast?.({ kind: 'err', text: e.message });
    } finally {
      setDownloadingWb(false);
    }
  };

  return (
    <div className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/45 backdrop-blur p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-white">Centralized Workbook Export</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Download all classes and names in one Excel file.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadWorkbook}
          disabled={downloadingWb}
          className="text-[11px] px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30 font-semibold disabled:opacity-50 whitespace-nowrap"
        >
          <i className={`ph ${downloadingWb ? 'ph-circle-notch animate-spin' : 'ph-microsoft-excel-logo'} mr-1`}></i>
          {downloadingWb ? 'Preparing…' : 'Download All (Excel)'}
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    pending:  ['bg-amber-500/15 text-amber-300 border-amber-500/30',  'ph-clock'],
    changes_requested: ['bg-orange-500/15 text-orange-300 border-orange-500/30', 'ph-chat-circle-dots'],
    approved: ['bg-emerald-500/15 text-emerald-300 border-emerald-500/30', 'ph-check-circle'],
    rejected: ['bg-red-500/15 text-red-300 border-red-500/30',        'ph-x-circle'],
  };
  const label = status === 'changes_requested' ? 'awaiting parent' : status;
  const [cls, icon] = map[status] || map.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${cls}`}>
      <i className={`ph ${icon}`}></i>{label}
    </span>
  );
}

// ─── Record card (slim, clickable list row) ────────────────────────────────
function RecordCard(props) {
  const {
    rec, selected, onToggleSelect, isActive, onOpen,
    onApprove, onPrint, onAddChaperone, busy, showSelect,
  } = props;

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

  const handleRowClick = (e) => {
    if (e.target.closest('button,a,input,label,kbd')) return;
    onOpen();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } }}
      className={`group relative glass-panel rounded-xl overflow-hidden transition-all cursor-pointer ${
        isActive
          ? 'border-brand-500/60 ring-2 ring-brand-500/30'
          : selected
          ? 'border-brand-500/40 ring-1 ring-brand-500/20'
          : 'hover:border-slate-600'
      }`}
    >
      {isActive && (
        <span className="absolute left-0 top-0 bottom-0 w-1 bg-brand-400 rounded-r" aria-hidden></span>
      )}

      <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        {/* Left: identity */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {showSelect && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus:ring-brand-500/40 flex-shrink-0"
            />
          )}
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500/30 to-brand-500/10 text-brand-200 border border-brand-500/30 flex items-center justify-center font-bold flex-shrink-0 shadow-sm">
            {(rec.guardian?.name || '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-100 truncate flex items-center gap-2 flex-wrap">
              {rec.guardian?.name || '—'}
              <StatusPill status={rec.status} />
              {rec.formNumber && (
                <span
                  title="Submission ID — use this for audit & reports"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold border bg-brand-500/15 text-brand-300 border-brand-500/40"
                >
                  <i className="ph ph-hash"></i>{rec.formNumber}
                </span>
              )}
              {enrollSummary && <EnrollPill summary={enrollSummary} />}
            </div>
            <div className="text-xs text-slate-400 truncate mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{rec.guardian?.email || rec.guardian?.phone || 'No contact'}</span>
              <span className="text-slate-600">·</span>
              <span title={fmtTime(rec.submittedAt)}>{timeAgo(rec.submittedAt)}</span>
              {(rec.students || []).length > 0 && (
                <>
                  <span className="text-slate-600">·</span>
                  <div className="inline-flex flex-wrap items-center gap-1">
                    {(rec.students || []).map((s, idx) => (
                      <span key={idx} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-900/60 text-slate-200 border border-slate-800">
                        <i className="ph ph-student text-brand-400"></i>
                        <span>{s.name || s.firstName || 'Student'}</span>
                        {s.homeroom && <span className="text-[10px] text-brand-300 font-mono">({s.homeroom})</span>}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: counts + quick actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-300 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-800" title="Students">
            <i className="ph ph-graduation-cap mr-1 text-slate-400"></i>{rec.students?.length || 0}
          </span>
          <span className="text-xs text-slate-300 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-800" title="Chaperones">
            <i className="ph ph-users mr-1 text-slate-400"></i>{rec.chaperones?.length || 0}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onPrint(); }}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 transition"
            title="Open printable form view"
            aria-label="Print form"
          >
            <i className="ph ph-printer"></i>
          </button>
          {onAddChaperone && (EDITABLE_ONBOARDING_STATUSES.includes(rec.status) || rec.status === 'approved') && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddChaperone(); }}
              disabled={(rec.chaperones?.length || 0) >= 5}
              title={(rec.chaperones?.length || 0) >= 5
                ? 'Maximum 5 chaperones reached'
                : 'Add a new chaperone to this form'}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-brand-500/15 border border-brand-500/40 text-brand-300 hover:bg-brand-500/25 disabled:opacity-40 disabled:cursor-not-allowed font-semibold"
              aria-label="Add chaperone"
            >
              <i className="ph ph-user-plus mr-1"></i>Add chaperone
            </button>
          )}
          {rec.status === 'pending' && (
            <button
              onClick={(e) => { e.stopPropagation(); onApprove(); }}
              disabled={!!busy}
              title="Approve and allocate chaperone IDs"
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-semibold hover:bg-emerald-400 disabled:opacity-50 transition"
            >
              {busy === 'approve' ? '…' : <><i className="ph ph-check mr-1"></i>Approve</>}
            </button>
          )}
          {rec.status === 'changes_requested' && (
            <span className="text-[11px] text-orange-300 px-2.5 py-1 rounded-lg bg-orange-500/15 border border-orange-500/30"
              title={rec.changesRequestedMessage || ''}>
              <i className="ph ph-envelope-simple mr-1"></i>parent emailed
            </span>
          )}
          <i className="ph ph-caret-right text-slate-500 group-hover:text-slate-200 transition-colors" aria-hidden></i>
        </div>
      </div>
    </div>
  );
}

// ─── Record card (Grid / Card View component) ──────────────────────────────
function RecordCardGrid(props) {
  const {
    rec, selected, onToggleSelect, isActive, onOpen,
    onApprove, onPrint, onAddChaperone, busy, showSelect,
  } = props;

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

  const handleCardClick = (e) => {
    if (e.target.closest('button,a,input,label,kbd')) return;
    onOpen();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(); } }}
      className={`group relative glass-panel rounded-2xl p-5 overflow-hidden transition-all cursor-pointer flex flex-col justify-between ${
        isActive
          ? 'border-brand-500/60 ring-2 ring-brand-500/30'
          : selected
          ? 'border-brand-500/40 ring-1 ring-brand-500/20'
          : 'hover:border-slate-600'
      }`}
    >
      {isActive && (
        <span className="absolute left-0 top-0 bottom-0 w-1.5 bg-brand-400 rounded-r" aria-hidden></span>
      )}

      <div>
        {/* Top bar */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-3 min-w-0">
            {showSelect && (
              <input
                type="checkbox"
                checked={selected}
                onChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
                className="mt-1 w-4 h-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus:ring-brand-500/40 shrink-0"
              />
            )}
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500/30 to-brand-500/10 text-brand-200 border border-brand-500/30 flex items-center justify-center font-bold text-base shrink-0 shadow-sm">
              {(rec.guardian?.name || '?').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-100 truncate group-hover:text-cyan-300 transition">
                {rec.guardian?.name || '—'}
              </h3>
              <p className="text-xs text-slate-400 truncate mt-0.5">
                {rec.guardian?.email || rec.guardian?.phone || 'No contact'}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 shrink-0">
            <StatusPill status={rec.status} />
            {rec.formNumber && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border bg-brand-500/15 text-brand-300 border-brand-500/40">
                <i className="ph ph-hash"></i>{rec.formNumber}
              </span>
            )}
          </div>
        </div>

        {/* Middle Section: Students List */}
        <div className="my-3 py-2.5 border-y border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1">
              <i className="ph ph-graduation-cap"></i> Students ({rec.students?.length || 0})
            </span>
            <span className="text-slate-500">{timeAgo(rec.submittedAt)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(rec.students || []).map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-900/70 text-slate-200 border border-slate-800">
                <span className="font-semibold text-slate-100">{s.name || s.firstName || 'Student'}</span>
                {s.homeroom && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/15 text-brand-300 font-mono">
                    {s.homeroom}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* Chaperones & Enrollment info */}
        <div className="flex items-center justify-between text-xs text-slate-400 mb-4">
          <span className="flex items-center gap-1.5">
            <i className="ph ph-users text-slate-400"></i>
            <span>Chaperones: <strong className="text-slate-200">{rec.chaperones?.length || 0}</strong></span>
          </span>
          {enrollSummary ? (
            <EnrollPill summary={enrollSummary} />
          ) : (
            <span className="text-[10px] text-slate-500">{rec.status}</span>
          )}
        </div>
      </div>

      {/* Footer Action Bar */}
      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onPrint(); }}
            className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition"
            title="Open printable form view"
          >
            <i className="ph ph-printer text-sm"></i>
          </button>
          {onAddChaperone && (EDITABLE_ONBOARDING_STATUSES.includes(rec.status) || rec.status === 'approved') && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddChaperone(); }}
              disabled={(rec.chaperones?.length || 0) >= 5}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-brand-500/15 border border-brand-500/40 text-brand-300 hover:bg-brand-500/25 disabled:opacity-40"
              title="Add chaperone"
            >
              <i className="ph ph-user-plus mr-1"></i>Add
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {rec.status === 'pending' && (
            <button
              onClick={(e) => { e.stopPropagation(); onApprove(); }}
              disabled={!!busy}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition"
            >
              {busy === 'approve' ? '…' : <><i className="ph ph-check mr-1"></i>Approve</>}
            </button>
          )}
          <button
            onClick={onOpen}
            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center gap-1"
          >
            <span>Details</span>
            <i className="ph ph-caret-right text-xs"></i>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Detail body (used inside DetailDrawer) ────────────────────────────────
function RecordDetail(props) {
  const {
    rec, thumbnails,
    onPhoto, onUploadStudentPhoto, onUploadChaperonePhoto, onDeleteChaperonePhoto,
    onUploadPendingChaperoneFace, onOnboardingEdit,
    autoOpenAddChaperone, onAddChaperoneHandled,
  } = props;
  if (!rec) return null;

  const enrichedStudents = (rec.students || []).map((s) => ({
    ...s,
    photoUrl: s.photoUrl || (thumbnails || {})[s.id] || (thumbnails || {})[`name:${s.name}`] || null,
  }));

  return (
    <div className="px-5 py-5 space-y-5">
      {/* Awaiting-parent banner */}
      {rec.status === 'changes_requested' && (
        <div className="px-3 py-2.5 rounded-lg bg-orange-500/10 border border-orange-500/30 flex items-start gap-3">
          <i className="ph ph-chat-circle-dots text-orange-400 mt-0.5"></i>
          <div className="flex-1 text-xs">
            <div className="text-orange-300 font-semibold">Waiting for parent reply</div>
            <div className="text-orange-200/80 mt-0.5 whitespace-pre-line">{rec.changesRequestedMessage || '—'}</div>
            <div className="text-orange-300/60 mt-1">
              Sent {rec.changesRequestedAt ? fmtTime(rec.changesRequestedAt) : '—'} by{' '}
              <span className="font-mono">{rec.changesRequestedBy || '—'}</span>
              {' — '}apply their reply directly on this form, then approve. No re-submission needed.
            </div>
          </div>
        </div>
      )}

      {/* Admin: add a brand-new chaperone to this form (pinned at top) */}
      {(EDITABLE_ONBOARDING_STATUSES.includes(rec.status) || rec.status === 'approved') && !!onOnboardingEdit && (
        <AddChaperonePanel
          recordId={rec.id}
          recordStatus={rec.status}
          enrichedStudents={enrichedStudents}
          existingCount={rec.chaperones?.length || 0}
          autoOpen={!!autoOpenAddChaperone}
          onAutoOpenConsumed={onAddChaperoneHandled}
          onSubmit={(chaperone) => onOnboardingEdit({
            recordId: rec.id, target: 'record', action: 'add-chaperone', chaperone,
          })}
        />
      )}

      {/* Submission metadata grid */}
      <div className="grid grid-cols-2 gap-3 text-xs">
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
            <i className="ph ph-info mr-1"></i>{enrichedStudents.length} siblings on a single submission.
          </p>
        )}
        <div className="grid grid-cols-1 gap-3">
          {enrichedStudents.map((s, i) => (
            <StudentTile
              key={s.id}
              s={s}
              index={i}
              total={enrichedStudents.length}
              canEdit={EDITABLE_ONBOARDING_STATUSES.includes(rec.status) && !!onOnboardingEdit}
              canDelete={EDITABLE_ONBOARDING_STATUSES.includes(rec.status) && !!onOnboardingEdit && enrichedStudents.length > 1}
              onEdit={(patch) => onOnboardingEdit({ recordId: rec.id, target: 'student', id: s.id, action: 'update', patch })}
              onDelete={() => onOnboardingEdit({ recordId: rec.id, target: 'student', id: s.id, action: 'delete' })}
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
            const editable = EDITABLE_ONBOARDING_STATUSES.includes(rec.status) && !!onOnboardingEdit;
            const approvedDelete = rec.status === 'approved' && !!allocated?.chaperoneId && !!onOnboardingEdit;
            return (
              <ChaperoneRow
                key={c.tempId || i}
                c={c}
                index={i}
                allocated={allocated}
                enrol={enrol}
                enrichedStudents={enrichedStudents}
                onPhoto={onPhoto}
                onUpload={onUploadChaperonePhoto && allocated
                  ? (file, opts) => onUploadChaperonePhoto(allocated.chaperoneId, file, opts)
                  : null}
                onUploadPendingFace={editable && onUploadPendingChaperoneFace
                  ? (file) => onUploadPendingChaperoneFace({ recordId: rec.id, tempId: c.tempId, file })
                  : null}
                canEdit={editable}
                onEdit={editable ? (patch) => onOnboardingEdit({ recordId: rec.id, target: 'chaperone', tempId: c.tempId, action: 'update', patch }) : null}
                onDelete={editable
                  ? () => onOnboardingEdit({ recordId: rec.id, target: 'chaperone', tempId: c.tempId, action: 'delete' })
                  : approvedDelete
                    ? (reason) => onOnboardingEdit({
                      action: 'delete-approved-chaperone',
                      chaperoneId: allocated.chaperoneId,
                      reason,
                    })
                    : null}
                onDeleteFace={allocated && onDeleteChaperonePhoto
                  ? (facePath) => onDeleteChaperonePhoto(allocated.chaperoneId, facePath)
                  : editable
                    ? (facePath) => onOnboardingEdit({ recordId: rec.id, target: 'chaperone', tempId: c.tempId, action: 'delete-face', facePath })
                    : null}
              />
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

      {/* Internal admin notes (never emailed to the guardian) */}
      <AdminNotesPanel rec={rec} />

      {/* Decision metadata (post-review) */}
      {(rec.status === 'approved' || rec.status === 'rejected') && (
        <div className="text-xs text-slate-500 pt-1 border-t border-slate-800">
          <div className="mt-3">
            {rec.status === 'approved' ? 'Approved' : 'Rejected'} {fmtTime(rec.reviewedAt)} by{' '}
            <span className="font-mono text-slate-400">{rec.reviewedBy || '—'}</span>
            {rec.rejectionReason && <div className="mt-1 text-red-400">Reason: {rec.rejectionReason}</div>}
            {rec.approvalNotes && <div className="mt-1 text-emerald-400">Notes: {rec.approvalNotes}</div>}
            {rec.lastReenrollAt && <div className="mt-1 text-slate-500">Last re-push: {fmtTime(rec.lastReenrollAt)}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Right slide-in detail drawer ──────────────────────────────────────────
// Replaces the old inline expand-in-place pattern. Sticky header with quick
// nav (J/K + Esc shortcuts), scrollable body, sticky footer with primary
// approve/reject actions. Locks body scroll while open.
function DetailDrawer(props) {
  const {
    open, onClose, rec, prevId, nextId, onJump,
    onApprove, onStartReject, onCancelReject, onSubmitReject, onReenroll,
    onStartMessage, onCancelMessage, onSubmitMessage,
    onPrint, busy, rejecting, rejectReason, setRejectReason,
    messaging, messageText, setMessageText,
  } = props;

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 transition-opacity duration-200 bg-black/50 backdrop-blur-sm ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={rec ? `Submission ${rec.formNumber || rec.id}` : 'Submission detail'}
        className={`fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[560px] lg:w-[640px] bg-slate-950 border-l border-slate-800 shadow-2xl shadow-black/60 flex flex-col transform transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {!rec ? null : (
          <>
            {/* Sticky header */}
            <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800 bg-slate-950/95 backdrop-blur-md">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <StatusPill status={rec.status} />
                  {rec.formNumber && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold border bg-brand-500/15 text-brand-200 border-brand-500/40">
                      <i className="ph ph-hash"></i>{rec.formNumber}
                    </span>
                  )}
                  <span className="text-[11px] text-slate-500" title={fmtTime(rec.submittedAt)}>
                    {timeAgo(rec.submittedAt)}
                  </span>
                </div>
                <div className="text-base font-bold text-white truncate" title={rec.guardian?.name}>
                  {rec.guardian?.name || '—'}
                </div>
                <div className="text-xs text-slate-500 truncate mt-0.5">
                  {rec.guardian?.email}{rec.guardian?.phone ? ` · ${rec.guardian?.phone}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => prevId && onJump(prevId)}
                  disabled={!prevId}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Previous (K)" aria-label="Previous submission"
                >
                  <i className="ph ph-caret-up"></i>
                </button>
                <button
                  onClick={() => nextId && onJump(nextId)}
                  disabled={!nextId}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Next (J)" aria-label="Next submission"
                >
                  <i className="ph ph-caret-down"></i>
                </button>
                <span className="w-px h-5 bg-slate-800 mx-1" aria-hidden></span>
                <button
                  onClick={onPrint}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
                  title="Open printable form view" aria-label="Print form"
                >
                  <i className="ph ph-printer"></i>
                </button>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
                  title="Close (Esc)" aria-label="Close drawer"
                >
                  <i className="ph ph-x text-lg"></i>
                </button>
              </div>
            </header>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto">
              <RecordDetail {...props} />
            </div>

            {/* Sticky footer with primary actions */}
            <footer className="border-t border-slate-800 bg-slate-950/95 backdrop-blur-md px-5 py-3">
              {EDITABLE_ONBOARDING_STATUSES.includes(rec.status) ? (
                rejecting ? (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-red-300 block">
                      Rejection note (required — attached to the email sent to the parent):
                    </label>
                    <textarea
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      rows={2}
                      placeholder="e.g. Chaperone face photos are blurry — please re-upload."
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-red-500/50"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={onCancelReject}
                        disabled={!!busy}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={onSubmitReject}
                        disabled={!!busy || rejectReason.trim().length < 4}
                        className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-40"
                      >
                        {busy === 'reject' ? 'Rejecting…' : 'Confirm rejection'}
                      </button>
                    </div>
                  </div>
                ) : messaging ? (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-orange-300 block">
                      Message to parent (emailed — they simply reply with the photo/details, no re-submission):
                    </label>
                    <textarea
                      value={messageText}
                      onChange={(e) => setMessageText(e.target.value)}
                      rows={2}
                      placeholder="e.g. The driver's face photo is blurry — please reply to this email with a clearer photo."
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-orange-500/50"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={onCancelMessage}
                        disabled={!!busy}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={onSubmitMessage}
                        disabled={!!busy || messageText.trim().length < 4}
                        className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40"
                      >
                        {busy === 'message' ? 'Sending…' : 'Send to parent'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-2 flex-wrap">
                    <button
                      onClick={onStartMessage}
                      disabled={!!busy}
                      title="Email the parent asking for a fix (new photo, corrected details) — they reply to the ACOP inbox, no re-submission"
                      className="px-4 py-2 text-sm font-semibold rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-300 hover:bg-orange-500/20 disabled:opacity-50"
                    >
                      <i className="ph ph-chat-circle-dots mr-1"></i>Message parent
                    </button>
                    <button
                      onClick={onStartReject}
                      disabled={!!busy}
                      className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                    >
                      <i className="ph ph-x mr-1"></i>Reject
                    </button>
                    <button
                      onClick={onApprove}
                      disabled={!!busy}
                      title="Approve submission"
                      className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
                    >
                      {busy === 'approve' ? 'Approving…' : <><i className="ph ph-check mr-1"></i>Approve</>}
                    </button>
                    <div className="w-full text-[11px] text-amber-300/90 mt-1">
                      After approval, use Chaperone Enrolment to push chaperones to terminals.
                    </div>
                  </div>
                )
              ) : (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-[11px] text-slate-500">
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono text-[10px]">J</kbd>
                    {' / '}
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono text-[10px]">K</kbd>
                    {' next/prev '}
                    <kbd className="ml-2 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono text-[10px]">Esc</kbd>
                    {' close'}
                  </div>
                  {rec.status === 'approved' && rec.allocatedChaperones?.length > 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={onReenroll}
                        disabled={!!busy}
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10 disabled:opacity-50"
                        title="Re-push these chaperones to all configured Hikvision devices"
                      >
                        {busy === 'reenroll' ? '…' : <><i className="ph ph-arrows-clockwise mr-1"></i>Re-push</>}
                      </button>
                      <a
                        href="/v2/pickup-enroll"
                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-500/10 border border-brand-500/30 text-brand-300 hover:bg-brand-500/20"
                        title="Push these chaperones to the right grade-level Hikvision terminal"
                      >
                        <i className="ph ph-fingerprint mr-1"></i>Enrolment board
                      </a>
                    </div>
                  )}
                </div>
              )}
            </footer>
          </>
        )}
      </aside>
    </>
  );
}

function AdminNotesPanel({ rec }) {
  const [notes, setNotes] = useState(() => (Array.isArray(rec.adminNotes) ? rec.adminNotes : []));
  const [draft, setDraft] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // Re-sync when navigating between records in the drawer
  useEffect(() => {
    setNotes(Array.isArray(rec.adminNotes) ? rec.adminNotes : []);
    setDraft(''); setOpenForm(false); setErr(null);
  }, [rec.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true); setErr(null);
    try {
      const r = await fetch('/api/pickup/admin/onboarding-note', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: rec.id, note: text }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'save failed');
      setNotes((n) => [...n, j.note]);
      setDraft(''); setOpenForm(false);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="rounded-lg bg-slate-900 border border-slate-800">
      <div className="px-3 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <i className="ph ph-note-pencil text-brand-400"></i>
          Internal notes ({notes.length})
          <span className="text-[10px] font-normal text-slate-500">— ACOP only, never sent to the parent</span>
        </div>
        {!openForm && (
          <button onClick={() => setOpenForm(true)}
            className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
            <i className="ph ph-plus mr-1"></i>Add note
          </button>
        )}
      </div>
      {notes.length > 0 && (
        <div className="px-3 pb-2 space-y-1.5">
          {notes.map((n, i) => (
            <div key={i} className="text-xs bg-slate-950/60 border border-slate-800 rounded-lg px-2.5 py-1.5">
              <div className="text-slate-200 whitespace-pre-line break-words">{n.text}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                {(n.by?.name || n.by?.email || '—')} · {n.at ? fmtTime(n.at) : ''}
              </div>
            </div>
          ))}
        </div>
      )}
      {openForm && (
        <div className="px-3 pb-3 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="e.g. Called guardian 15:20 — will WhatsApp a new driver photo tonight."
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-brand-500/50"
          />
          {err && <div className="text-[11px] text-red-400"><i className="ph ph-warning mr-1"></i>{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => { setOpenForm(false); setDraft(''); setErr(null); }} disabled={saving}
              className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">
              Cancel
            </button>
            <button onClick={submit} disabled={saving || !draft.trim()}
              className="px-3 py-1 text-[11px] font-semibold rounded-lg bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40">
              {saving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StudentTile({ s, index, total, canEdit, canDelete, onEdit, onDelete }) {
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    id: getStoredStudentId(s),
    firstName: s.firstName || '',
    nickname: s.nickname || '',
    gradeSelection: deriveGradeSelectionFromStudent(s),
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const submitEdit = async () => {
    if (!onEdit) return;
    const patch = {};
    const nextId = (editForm.id || '').trim();
    const currentId = getStoredStudentId(s);
    if (nextId && nextId !== currentId) {
      patch.id = nextId;
      patch.studentId = nextId;
    }
    if ((editForm.firstName || '').trim() !== (s.firstName || '')) patch.firstName = (editForm.firstName || '').trim();
    if ((editForm.nickname || '').trim() !== (s.nickname || '')) patch.nickname = (editForm.nickname || '').trim();
    if ((editForm.gradeSelection || '').trim() !== deriveGradeSelectionFromStudent(s)) patch.gradeSelection = (editForm.gradeSelection || '').trim();
    if (Object.keys(patch).length === 0) { setEditOpen(false); return; }
    setSavingEdit(true);
    try {
      const ok = await onEdit(patch);
      if (ok) setEditOpen(false);
    } finally { setSavingEdit(false); }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!confirm(`Remove ${s.name || s.id} from this onboarding submission?\n\nThis cannot be undone before approval.`)) return;
    await onDelete();
  };

  const isSibling = total > 1;

  return (
    <div className="relative rounded-xl border border-slate-800 hover:border-slate-700 bg-gradient-to-br from-white/5 to-white/[0.02] overflow-hidden transition-all">
      {/* Status bar */}
      <div className="px-3 py-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider border-b bg-slate-900/40 border-slate-800 text-slate-400">
        <span className="flex items-center gap-1.5">
          <i className="ph ph-graduation-cap text-brand-400"></i>
          Student
        </span>
        <div className="flex items-center gap-2">
          {isSibling && (
            <span className="text-slate-400" title="Sibling number on this form">
              Child {index + 1}/{total}
            </span>
          )}
          {canEdit && (
            <button type="button" onClick={() => setEditOpen((v) => !v)}
              className="text-slate-300 hover:text-white px-1.5 py-0.5 rounded bg-slate-800/60 hover:bg-slate-700"
              title="Edit student details">
              <i className="ph ph-pencil-simple"></i>
            </button>
          )}
          {canDelete && (
            <button type="button" onClick={handleDelete}
              className="text-red-300 hover:text-red-200 px-1.5 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 border border-red-500/30"
              title="Remove student from this submission">
              <i className="ph ph-trash"></i>
            </button>
          )}
        </div>
      </div>

      {editOpen && canEdit && (
        <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/60 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Edit student</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">BINUS Student ID</div>
              <input value={editForm.id} onChange={(e) => setEditForm((f) => ({ ...f, id: e.target.value }))}
                placeholder={isTemporaryStudentId(s.id) ? 'Enter BINUS Student ID' : ''}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono" />
            </label>
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">First name</div>
              <input value={editForm.firstName} onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
            </label>
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">Nickname</div>
              <input value={editForm.nickname} onChange={(e) => setEditForm((f) => ({ ...f, nickname: e.target.value }))}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
            </label>
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">Class (from form)</div>
              <input
                value={formatStudentGradeBadge(s)}
                readOnly
                className="w-full bg-slate-900/60 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => {
              setEditOpen(false);
              setEditForm({
                id: getStoredStudentId(s),
                firstName: s.firstName || '',
                nickname: s.nickname || '',
                gradeSelection: deriveGradeSelectionFromStudent(s),
              });
            }}
              className="text-[11px] px-2 py-1 rounded bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">Cancel</button>
            <button onClick={submitEdit} disabled={savingEdit}
              className="text-[11px] px-3 py-1 rounded bg-brand-500 text-white hover:bg-brand-400 disabled:opacity-50">
              {savingEdit ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <div className="p-4 flex flex-col gap-1.5">
        <div className="text-base font-bold text-white leading-tight truncate" title={buildStudentDisplayName(s)}>
          {buildStudentDisplayName(s)}
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
            {getStoredStudentId(s) || 'BINUS ID pending'}
          </span>
          {s.nickname ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800/60 border border-slate-700 text-[10px] text-slate-300">
              <i className="ph ph-smiley text-slate-500"></i>
              Nickname {s.nickname}
            </span>
          ) : null}
          {deriveGradeSelectionFromStudent(s) ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800/60 border border-slate-700 text-[10px] text-slate-300">
              <i className="ph ph-number-circle-four text-slate-500"></i>
              {formatStudentGradeBadge(s)}
            </span>
          ) : null}
          {formatStudentFinalClass(s) ? (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-brand-500/15 border border-brand-500/30 text-[10px] font-bold text-brand-200"
              title="Homeroom class"
            >
              <i className="ph ph-chalkboard-teacher"></i>
              Final class {formatStudentFinalClass(s)}
            </span>
          ) : null}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">Academic Year {ACADEMIC_YEAR_LABEL}</div>
      </div>

      {/* Drag overlay (kept hidden – no upload) */}
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

// Admin affordance: append a brand-new chaperone to an onboarding record
// (e.g. parent asked the school to add a replacement after the form was
// already submitted/approved). Pending records just stash the new entry
// alongside the others; approved records also allocate a chaperoneId
// immediately so the new adult is a first-class citizen on /v2/pickup-enroll.
function AddChaperonePanel({ recordId, recordStatus, enrichedStudents, existingCount, onSubmit, autoOpen, onAutoOpenConsumed }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (autoOpen && !open) {
      setOpen(true);
      if (onAutoOpenConsumed) onAutoOpenConsumed();
    }
  }, [autoOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '', relation: 'parent', email: '',
    idNumber: '', authorizedStudentIds: [],
  });
  const reset = () => setForm({
    name: '', relation: 'parent', email: '',
    idNumber: '', authorizedStudentIds: [],
  });
  const toggle = (sid) => setForm((f) => ({
    ...f,
    authorizedStudentIds: f.authorizedStudentIds.includes(sid)
      ? f.authorizedStudentIds.filter((x) => x !== sid)
      : [...f.authorizedStudentIds, sid],
  }));
  const valid =
    form.name.trim().length >= 2 &&
    form.authorizedStudentIds.length > 0;
  const atCap = existingCount >= 5;
  const isApproved = recordStatus === 'approved';

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    const ok = await onSubmit({
      name: form.name.trim(),
      relation: form.relation,
      email: form.email.trim() || null,
      idNumber: form.idNumber.trim() || null,
      authorizedStudentIds: form.authorizedStudentIds,
    });
    setSaving(false);
    if (ok) { reset(); setOpen(false); }
  };

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-500/40 bg-brand-500/10 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <i className="ph ph-user-plus text-brand-300 text-lg"></i>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white">Add chaperone</div>
            <div className="text-[10px] text-slate-400 truncate">
              {atCap
                ? 'Maximum 5 chaperones reached — remove one first.'
                : isApproved
                  ? 'Allocates immediately. Upload photos on Pickup Enroll.'
                  : 'Append a brand-new chaperone to this submission.'}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={atCap}
          className="flex-shrink-0 text-xs font-semibold inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <i className="ph ph-plus"></i>Add
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-brand-500/30 bg-brand-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-brand-200 font-semibold">
          <i className="ph ph-user-plus mr-1"></i>New chaperone (admin)
        </div>
        <div className="text-[10px] text-slate-500">
          {isApproved
            ? 'Will be allocated immediately. Upload photos on /v2/pickup-enroll.'
            : 'Photos can be added after saving.'}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <div className="text-[10px] text-slate-500 mb-0.5">Name *</div>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
        </label>
        <label className="block">
          <div className="text-[10px] text-slate-500 mb-0.5">Relation *</div>
          <select value={form.relation} onChange={(e) => setForm((f) => ({ ...f, relation: e.target.value }))}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white">
              {VALID_RELATIONS.map((k) => (<option key={k} value={k}>{REL_INITIALS[k]} - {REL_LABEL[k]}</option>))}
          </select>
        </label>
        <label className="block">
          <div className="text-[10px] text-slate-500 mb-0.5">Email</div>
          <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
        </label>
      </div>
      {enrichedStudents.length > 0 && (
        <div>
          <div className="text-[10px] text-emerald-300 mb-1.5 uppercase tracking-wider font-semibold inline-flex items-center gap-1">
            <i className="ph ph-seal-check"></i>Authorized to pick up *
          </div>
          <div className="flex flex-wrap gap-1.5">
            {enrichedStudents.map((s) => {
              const on = form.authorizedStudentIds.includes(s.id);
              return (
                <button key={s.id} type="button" onClick={() => toggle(s.id)}
                  className={`text-[11px] px-2 py-1 rounded-lg border font-semibold inline-flex items-center ${on
                    ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-100'
                    : 'bg-slate-800/40 border-slate-700 text-slate-400'}`}>
                  <i className={`ph ${on ? 'ph-check-square' : 'ph-square'} mr-1`}></i>{s.name || s.id}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={() => { reset(); setOpen(false); }}
          className="text-[11px] px-2 py-1 rounded bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">Cancel</button>
        <button onClick={submit} disabled={!valid || saving}
          className="text-[11px] px-3 py-1 rounded bg-brand-500 text-white hover:bg-brand-400 disabled:opacity-50">
          {saving ? 'Adding…' : 'Add chaperone'}
        </button>
      </div>
    </div>
  );
}

function ChaperoneRow({ c, index, allocated, enrol, enrichedStudents, onPhoto, onUpload, onUploadPendingFace, canEdit, onEdit, onDelete, onDeleteFace }) {
  const addInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Upload-photo modal: { mode:'add'|'replace', replacePath?:string }
  const [photoModal, setPhotoModal] = useState(null);
  const [editForm, setEditForm] = useState({
    name: c.name || '', phone: c.phone || '', email: c.email || '',
    idNumber: c.idNumber || '', relation: c.relation || 'parent',
    authorizedStudentIds: c.authorizedStudentIds || [],
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const submitEdit = async () => {
    if (!onEdit) return;
    const patch = {
      name: editForm.name.trim(),
      phone: editForm.phone.trim(),
      email: editForm.email.trim(),
      idNumber: editForm.idNumber.trim(),
      relation: editForm.relation,
      authorizedStudentIds: editForm.authorizedStudentIds,
    };
    setSavingEdit(true);
    try {
      const ok = await onEdit(patch);
      if (ok) setEditOpen(false);
    } finally { setSavingEdit(false); }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (allocated?.chaperoneId) {
      const reason = askReasonOrFallback(
        `Reason for deleting approved chaperone ${c.name} (required):`,
        'Data correction requested by ACOP',
      );
      if (!reason || !String(reason).trim()) return;
      if (!confirm(
        `Delete approved chaperone "${c.name}"?\n\nThis removes gate enrollment, clears terminal assignment overrides, and hides this chaperone from Pickup Enroll.`,
      )) return;
      await onDelete(String(reason).trim());
      return;
    }
    if (!confirm(`Remove chaperone "${c.name}" from this submission?\n\nUploaded face photos will also be deleted. This cannot be undone before approval.`)) return;
    await onDelete();
  };

  const handleDeleteFace = async (path) => {
    if (!onDeleteFace) return false;
    if (!confirm(`Delete this face photo for ${c.name}?`)) return false;
    return await onDeleteFace(path);
  };

  const toggleAuthStudent = (sid) => {
    setEditForm((f) => {
      const has = f.authorizedStudentIds.includes(sid);
      return { ...f, authorizedStudentIds: has
        ? f.authorizedStudentIds.filter((x) => x !== sid)
        : [...f.authorizedStudentIds, sid] };
    });
  };

  const faces = c.faceUrls || [];
  // Admin-side cap: parents do not upload chaperone faces (Phase 2),
  // and the school only needs a couple of admin-supplied reference shots.
  const MAX_FACES = 2;
  const slots = Array.from({ length: MAX_FACES }, (_, i) => faces[i] || null);
  const filled = faces.length;
  // Post-approval upload uses the per-chaperone enrol endpoint; pre-approval
  // uses the onboarding-edit add-face action. Either path enables admin uploads.
  const canUpload = (!!onUpload && !!allocated) || !!onUploadPendingFace;
  const usePending = !allocated && !!onUploadPendingFace;

  const handleAdd = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      if (usePending) await onUploadPendingFace(file);
      else if (onUpload) await onUpload(file, { replace: false });
    } finally { setBusy(false); }
  };
  const handleReplace = async (file) => {
    if (!file || !onUpload) return;
    if (!confirm(`Replace ALL ${filled} existing photo(s) for ${c.name}?`)) return;
    setBusy(true);
    try { await onUpload(file, { replace: true }); } finally { setBusy(false); }
  };
  // Modal-driven flow: replace a single photo (delete then upload new).
  const handleModalSubmit = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      if (photoModal?.mode === 'replace' && photoModal.replacePath && onDeleteFace) {
        const ok = await onDeleteFace(photoModal.replacePath);
        if (ok === false) return;
      }
      await handleAdd(file);
    } finally {
      setBusy(false);
      setPhotoModal(null);
    }
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
              {VALID_RELATIONS.includes(c.relation) && (
                <span 
                  className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-200 border border-blue-500/40 inline-flex items-center justify-center min-w-7"
                  title={`${REL_LABEL[c.relation]}`}
                >
                  {REL_INITIALS[c.relation]}
                </span>
              )}
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
          {canEdit && (
            <button type="button" onClick={() => setEditOpen((v) => !v)}
              className="text-[10px] px-2 py-0.5 rounded border bg-slate-800/60 border-slate-700 text-slate-200 hover:bg-slate-700"
              title="Edit chaperone details">
              <i className="ph ph-pencil-simple mr-1"></i>Edit
            </button>
          )}
          {onDelete && (
            <button type="button" onClick={handleDelete}
              className="text-[10px] px-2 py-0.5 rounded border bg-red-500/15 border-red-500/30 text-red-300 hover:bg-red-500/25"
              title={allocated?.chaperoneId
                ? 'Delete this approved chaperone (also clears terminal assignments)'
                : 'Remove this chaperone from the submission'}>
              <i className="ph ph-trash mr-1"></i>Delete
            </button>
          )}
        </div>
      </div>

      {editOpen && canEdit && (
        <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/60 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Edit chaperone</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">Name</div>
              <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
            </label>
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">Relation</div>
              <select value={editForm.relation} onChange={(e) => setEditForm((f) => ({ ...f, relation: e.target.value }))}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white">
                    {VALID_RELATIONS.map((k) => (<option key={k} value={k}>{REL_INITIALS[k]} - {REL_LABEL[k]}</option>))}
              </select>
            </label>
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">Phone</div>
              <input value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
            </label>
            <label className="block">
              <div className="text-[10px] text-slate-500 mb-0.5">Email</div>
              <input value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
            </label>
          </div>
          {enrichedStudents.length > 0 && (
            <div>
              <div className="text-[10px] text-emerald-300 mb-1.5 uppercase tracking-wider font-semibold inline-flex items-center gap-1">
                <i className="ph ph-seal-check"></i>Authorized to pick up
              </div>
              <div className="flex flex-wrap gap-1.5">
                {enrichedStudents.map((s) => {
                  const on = editForm.authorizedStudentIds.includes(s.id);
                  return (
                    <button key={s.id} type="button" onClick={() => toggleAuthStudent(s.id)}
                      className={`text-[11px] px-2 py-1 rounded-lg border font-semibold inline-flex items-center ${on
                        ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-100'
                        : 'bg-slate-800/40 border-slate-700 text-slate-400'}`}>
                      <i className={`ph ${on ? 'ph-check-square' : 'ph-square'} mr-1`}></i>{s.name || s.id}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setEditOpen(false)}
              className="text-[11px] px-2 py-1 rounded bg-white/5 border border-slate-800 text-slate-300 hover:bg-white/10">Cancel</button>
            <button onClick={submitEdit} disabled={savingEdit || !editForm.name.trim()}
              className="text-[11px] px-3 py-1 rounded bg-brand-500 text-white hover:bg-brand-400 disabled:opacity-50">
              {savingEdit ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <div className="p-4 space-y-4">
        {/* Contact row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          {c.phone && (<span><i className="ph ph-phone text-slate-500 mr-1"></i>{c.phone}</span>)}
          {c.email && (<span><i className="ph ph-envelope text-slate-500 mr-1"></i>{c.email}</span>)}
        </div>

        {/* Authorized to pick up */}
        {authorizedNames.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold mb-1.5 inline-flex items-center gap-1">
              <i className="ph ph-seal-check"></i>Authorized to pick up
            </div>
            <div className="flex flex-wrap gap-1.5">
              {authorizedNames.map((a) => (
                <span key={a.id}
                  className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-100 border border-emerald-400/40 font-semibold">
                  <i className="ph ph-check-square"></i>{a.name}
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
                  onClick={() => setPhotoModal({ mode: 'add' })}
                  disabled={busy || filled >= MAX_FACES}
                  title={filled >= MAX_FACES ? `Max ${MAX_FACES} photos` : 'Add another photo'}
                  className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-orange-500/15 text-orange-200 border border-orange-500/30 hover:bg-orange-500/25 disabled:opacity-40"
                >
                  {busy ? <i className="ph ph-spinner-gap animate-spin"></i> : <i className="ph ph-plus"></i>}
                  Add
                </button>
                {filled > 0 && onUpload && allocated && (
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
              <div key={j} className="group/face relative aspect-square">
                <button
                  type="button"
                  onClick={() => onPhoto(url, `${c.name} · face ${j + 1}/${filled}`)}
                  className="relative w-full h-full rounded-lg overflow-hidden border-2 border-orange-500/40 hover:border-orange-300 transition-colors cursor-zoom-in"
                  title={`Click to view face ${j + 1}`}
                >
                  <img src={url} alt={`${c.name} ${j + 1}`} className="w-full h-full object-cover" />
                  <span className="absolute top-0.5 left-0.5 text-[9px] font-mono px-1 py-0 rounded bg-black/60 text-white">
                    {j + 1}
                  </span>
                </button>
                {onDeleteFace && (c.facePaths || [])[j] && (
                  <div className="absolute inset-x-0 bottom-0 p-1 flex justify-center gap-1 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover/face:opacity-100 transition-opacity pointer-events-none">
                    <button type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPhotoModal({ mode: 'replace', replacePath: (c.facePaths || [])[j] });
                      }}
                      className="pointer-events-auto w-6 h-6 rounded-full bg-blue-500 hover:bg-blue-400 text-white flex items-center justify-center shadow text-[10px]"
                      title="Replace this face photo">
                      <i className="ph ph-pencil-simple"></i>
                    </button>
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteFace((c.facePaths || [])[j]); }}
                      className="pointer-events-auto w-6 h-6 rounded-full bg-red-500 hover:bg-red-400 text-white flex items-center justify-center shadow text-[10px]"
                      title="Delete this face photo">
                      <i className="ph ph-trash"></i>
                    </button>
                  </div>
                )}
                {onDeleteFace && (c.facePaths || [])[j] && (
                  <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-900 text-slate-300 border border-slate-700 flex items-center justify-center text-[9px] pointer-events-none">
                    <i className="ph ph-pencil-simple"></i>
                  </span>
                )}
              </div>
            ) : (
              <button
                key={j}
                type="button"
                onClick={() => canUpload && j === filled && setPhotoModal({ mode: 'add' })}
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
          {!allocated && onUpload && !onUploadPendingFace && (
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

      {photoModal && (
        <ChaperonePhotoUploadModal
          mode={photoModal.mode}
          chaperoneName={c.name}
          busy={busy}
          onClose={() => setPhotoModal(null)}
          onSubmit={handleModalSubmit}
        />
      )}
    </div>
  );
}

// ─── Chaperone face upload modal ─────────────────────────────────────────────
// Used by ChaperoneRow for both adding a brand-new face and replacing an
// existing one (in which case the caller deletes the old face first).
function ChaperonePhotoUploadModal({ mode, chaperoneName, busy, onClose, onSubmit }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const validate = (f) => {
    if (!f) return 'No file chosen.';
    if (!/^image\/(jpe?g|png|webp)$/i.test(f.type)) return 'Photo must be JPEG, PNG or WebP.';
    if (f.size > 800 * 1024) return 'Photo must be ≤ 800 KB.';
    return '';
  };
  const pick = (f) => {
    const msg = validate(f);
    setError(msg);
    setFile(msg ? null : f);
  };

  const title = mode === 'replace' ? 'Replace face photo' : 'Add face photo';
  const ctaLabel = mode === 'replace' ? 'Replace photo' : 'Upload photo';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-base font-bold text-white">{title}</div>
            <div className="text-xs text-slate-400 mt-0.5">
              For chaperone <span className="text-slate-200 font-semibold">{chaperoneName}</span>
              {mode === 'replace' && <> · the existing photo will be deleted first.</>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-slate-500 hover:text-white text-lg leading-none disabled:opacity-50"
            title="Close"
          >×</button>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) pick(f);
          }}
          onClick={() => !busy && inputRef.current?.click()}
          className={`rounded-lg border-2 border-dashed cursor-pointer transition-colors flex flex-col items-center justify-center text-center p-4 min-h-[180px] ${
            dragOver ? 'border-orange-400 bg-orange-500/10' :
            previewUrl ? 'border-emerald-500/40 bg-emerald-500/5' :
            'border-slate-700 hover:border-slate-500 bg-slate-950/60'
          }`}
        >
          {previewUrl ? (
            <>
              <img src={previewUrl} alt="preview" className="max-h-40 rounded-md mb-2 object-contain" />
              <div className="text-[11px] text-slate-400">{file?.name} · {Math.round((file?.size || 0)/1024)} KB</div>
              <div className="text-[10px] text-slate-500 mt-1">Click to choose a different photo</div>
            </>
          ) : (
            <>
              <i className="ph ph-cloud-arrow-up text-3xl text-slate-500 mb-1"></i>
              <div className="text-sm text-slate-300 font-semibold">Drag photo here or click to browse</div>
              <div className="text-[11px] text-slate-500 mt-1">JPEG / PNG / WebP · ≤ 800 KB</div>
            </>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pick(f); }}
        />

        {error && (
          <div className="mt-2 text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
            <i className="ph ph-warning mr-1"></i>{error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10 disabled:opacity-50"
          >Cancel</button>
          <button
            type="button"
            onClick={() => file && onSubmit(file)}
            disabled={busy || !file}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-orange-500 text-white hover:bg-orange-400 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {busy && <i className="ph ph-spinner-gap animate-spin"></i>}
            {ctaLabel}
          </button>
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
          <Field label="Parent's name"  value={rec.guardian?.name} />
          <Field label="Email"      value={rec.guardian?.email} />
          {rec.guardian?.phone ? <Field label="Phone" value={rec.guardian?.phone} /> : null}
        </Section>

        {/* Section 2 — Students */}
        <Section title={`2. Students under guardian (${enrichedStudents.length})`}>
          <table className="w-full text-sm border border-slate-300">
            <thead className="bg-slate-100 text-xs uppercase">
              <tr>
                <th className="text-left p-2 border border-slate-300">#</th>
                <th className="text-left p-2 border border-slate-300">Photo</th>
                <th className="text-left p-2 border border-slate-300">First name</th>
                <th className="text-left p-2 border border-slate-300">Nickname</th>
                <th className="text-left p-2 border border-slate-300">BINUS ID</th>
                <th className="text-left p-2 border border-slate-300">Grade</th>
                <th className="text-left p-2 border border-slate-300">Final class</th>
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
                  <td className="p-2 border border-slate-300 align-top font-semibold">{s.firstName || s.name || '—'}</td>
                  <td className="p-2 border border-slate-300 align-top">{s.nickname || '—'}</td>
                  <td className="p-2 border border-slate-300 align-top font-mono text-xs">{getStoredStudentId(s) || 'Pending'}</td>
                  <td className="p-2 border border-slate-300 align-top">{formatStudentGradeBadge(s)}</td>
                  <td className="p-2 border border-slate-300 align-top">{formatStudentFinalClass(s) || 'Pending ACOP assignment'}</td>
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
                    {VALID_RELATIONS.includes(c.relation) && (
                      <span className="ml-2 text-xs font-mono font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded border border-blue-300">
                        {REL_INITIALS[c.relation]} ({REL_LABEL[c.relation]})
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-700 mt-1 space-y-0.5">
                    <div>Phone: <span className="font-mono">{c.phone}</span></div>
                    {c.email && <div>Email: <span className="font-mono">{c.email}</span></div>}
                  </div>
                  <div className="text-xs mt-1.5">
                    <span className="text-slate-600">Authorised to pick up: </span>
                    <strong>
                      {(c.authorizedStudentIds || []).length > 0
                        ? (c.authorizedStudentIds || [])
                          .map((sid) => `\u2713 ${enrichedStudents.find((x) => x.id === sid)?.name || sid}`)
                          .join(', ')
                        : '—'}
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
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sendInvite, setSendInvite] = useState(null);   // {invite, qr}
  const [showSettings, setShowSettings] = useState(false);
  const [editInvite, setEditInvite] = useState(null);   // invite being edited
  const [editBusy, setEditBusy] = useState(false);
  const [editResult, setEditResult] = useState(null);   // {invite, urlChanged}

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

  /**
   * Edit-modal save handler. Distinct from the inline patchInvite so we
   * can request a fresh QR (the URL may rotate if the admin extends
   * the expiration) and present the result back to the admin without
   * dismissing the modal silently.
   */
  async function saveEdit(patch) {
    if (!editInvite) return;
    setEditBusy(true);
    try {
      const r = await fetch(
        `/api/pickup/admin/invite-links?id=${encodeURIComponent(editInvite.id)}&qr=1`,
        {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const urlChanged = j.invite.url !== editInvite.url;
      await reload();
      setEditInvite(null);
      setEditResult({ invite: j.invite, urlChanged });
      pushToast(
        'success',
        urlChanged
          ? 'Updated. URL was rotated — re-share with parents.'
          : 'Invite link updated.',
        'Saved',
      );
    } catch (e) {
      pushToast('error', e.message, 'Update failed');
    } finally {
      setEditBusy(false);
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

  async function deleteInvite(id) {
    try {
      const r = await fetch(`/api/pickup/admin/invite-links?id=${encodeURIComponent(id)}&hard=1`, {
        method: 'DELETE', credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      pushToast('success', 'Link permanently deleted.', 'Done');
      setConfirmDelete(null);
      await reload();
    } catch (e) {
      pushToast('error', e.message, 'Delete failed');
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

  /** Open the send-invite modal for `invite`, fetching QR if needed. */
  async function openSend(invite) {
    if (invite.qrDataUrl) { setSendInvite({ invite, qr: invite.qrDataUrl }); return; }
    try {
      const r = await fetch(`/api/pickup/admin/invite-links?id=${encodeURIComponent(invite.id)}&qr=1`, { credentials: 'include' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSendInvite({ invite: j.invite, qr: j.invite.qrDataUrl || null });
    } catch (e) {
      pushToast('error', e.message, 'Could not open send dialog');
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
      active: list.filter((i) => i.enabled && !i.revoked && !i.archived).length,
      revoked: list.filter((i) => (i.revoked || !i.enabled) && !i.archived).length,
      archived: list.filter((i) => i.archived).length,
      uses: list.reduce((acc, i) => acc + Number(i.useCount || 0), 0),
    };
  }, [items]);

  const visibleItems = useMemo(() => {
    const list = items || [];
    return showArchived ? list.filter((i) => i.archived) : list.filter((i) => !i.archived);
  }, [items, showArchived]);

  return (
    <div className="max-w-6xl space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-r from-brand-500/[0.12] via-slate-900/70 to-slate-950/70 p-6 shadow-xl">
        <div className="flex items-end justify-between flex-wrap gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-400 mb-1">
              <i className="ph ph-link-simple text-base"></i> Onboarding Campaign Links
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight">Onboarding Invite Links</h2>
            <p className="text-sm text-slate-400 max-w-2xl mt-1.5 leading-relaxed">
              One link can be shared across channels. Each submission is identified by the guardian form
              data. Use multiple links to track campaigns (e.g. <em>Grade 4 Newsletter</em>,
              <em> WhatsApp Broadcast</em>) and revoke or pause any link anytime.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setShowArchived((v) => !v)}
              className={`px-3 py-2 text-xs font-semibold rounded-xl border transition-all ${
                showArchived
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                  : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:bg-slate-800'
              }`}
              title={showArchived ? 'Hide archived links' : 'Show archived links'}>
              <i className={`ph ${showArchived ? 'ph-eye-slash' : 'ph-archive'} mr-1.5 text-sm`}></i>
              {showArchived ? `Archive (${stats.archived})` : `Archive (${stats.archived})`}
            </button>
            <button onClick={() => setShowSettings(true)}
              className="px-3 py-2 text-xs font-semibold rounded-xl bg-slate-900/80 border border-slate-800 text-slate-300 hover:bg-slate-800 transition-all">
              <i className="ph ph-gear-six mr-1.5 text-sm"></i>Integrations
            </button>
            <button onClick={reload}
              className="px-3 py-2 text-xs font-semibold rounded-xl bg-slate-900/80 border border-slate-800 text-slate-300 hover:bg-slate-800 transition-all">
              <i className="ph ph-arrows-clockwise mr-1.5 text-sm"></i>Refresh
            </button>
            <button onClick={() => setShowCreate(true)}
              className="px-4 py-2.5 text-xs font-bold rounded-xl bg-gradient-to-r from-brand-500 to-emerald-500 hover:from-brand-400 hover:to-emerald-400 text-slate-950 shadow-lg shadow-brand-500/20 transition-all active:scale-95">
              <i className="ph ph-plus-circle mr-1.5 text-sm"></i>New invite link
            </button>
          </div>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total links" value={stats.total} icon="ph-link" tone="slate" />
        <StatCard label="Active" value={stats.active} icon="ph-check-circle" tone="emerald" />
        <StatCard label="Revoked / paused" value={stats.revoked} icon="ph-pause-circle" tone="rose" />
        <StatCard label="Total submissions" value={stats.uses} icon="ph-paper-plane-tilt" tone="amber" />
      </div>

      {items === null ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-white/5 px-8 py-14 text-center">
          <i className={`ph ${showArchived ? 'ph-archive' : 'ph-link-simple'} text-4xl text-slate-500`}></i>
          <p className="mt-3 text-slate-300 font-medium">
            {showArchived ? 'No archived links.' : 'No invite links yet.'}
          </p>
          <p className="text-xs text-slate-500 mt-1 mb-4">
            {showArchived
              ? 'Archived links are hidden from the main list but can be restored at any time.'
              : 'Create one and share it with all parents — the link is reusable.'}
          </p>
          {!showArchived && (
            <button onClick={() => setShowCreate(true)}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-500 hover:bg-brand-400 text-white">
              <i className="ph ph-plus-circle mr-1.5"></i>Create first link
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {visibleItems.map((inv) => (
            <InviteLinkCard
              key={inv.id}
              invite={inv}
              onCopy={copyText}
              onShowQr={() => showQr(inv)}
              onSend={() => openSend(inv)}
              onPreview={() => window.open(inv.url, '_blank', 'noopener')}
              onToggle={(enabled) => patchInvite(inv.id, { enabled })}
              onRevoke={() => setConfirmRevoke(inv)}
              onArchive={() => patchInvite(inv.id, { archived: !inv.archived })}
              onDelete={() => setConfirmDelete(inv)}
              onRename={(name) => patchInvite(inv.id, { name })}
              onEdit={() => setEditInvite(inv)}
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

      {editInvite && (
        <EditInviteModal
          invite={editInvite}
          busy={editBusy}
          onCancel={() => setEditInvite(null)}
          onSubmit={saveEdit}
        />
      )}

      {editResult && (
        <InvitePreviewModal
          invite={editResult.invite}
          qr={editResult.invite.qrDataUrl || null}
          urlChanged={editResult.urlChanged}
          onClose={() => setEditResult(null)}
          onCopy={copyText}
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

      {sendInvite && (
        <SendInviteModal
          invite={sendInvite.invite}
          qr={sendInvite.qr}
          onClose={() => setSendInvite(null)}
          onCopy={copyText}
          pushToast={pushToast}
        />
      )}

      {showSettings && (
        <IntegrationsSettingsModal
          onClose={() => setShowSettings(false)}
          pushToast={pushToast}
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

      {confirmDelete && (
        <div className="fixed inset-0 z-[1000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
             onClick={() => setConfirmDelete(null)}>
          <div className="bg-slate-900 border border-rose-500/40 rounded-xl max-w-md w-full p-6"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-rose-500/20 flex items-center justify-center flex-shrink-0">
                <i className="ph ph-trash text-rose-400 text-xl"></i>
              </div>
              <div>
                <h3 className="text-white font-semibold">Permanently delete invite link?</h3>
                <p className="text-sm text-slate-400 mt-1">
                  &ldquo;<span className="text-white">{confirmDelete.name}</span>&rdquo; and all of its
                  metadata (usage stats, QR cache, signed token) will be erased forever.
                  This cannot be undone. Consider <span className="text-amber-300">archiving</span> instead
                  if you want to keep the audit trail.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-white">Cancel</button>
              <button onClick={() => deleteInvite(confirmDelete.id)}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-rose-600 hover:bg-rose-500 text-white">
                <i className="ph ph-trash mr-1.5"></i>Delete forever
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InviteLinkCard({ invite, onCopy, onShowQr, onSend, onPreview, onToggle, onRevoke, onArchive, onDelete, onRename, onEdit }) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(invite.name);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setDraftName(invite.name); }, [invite.name]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  const now = Date.now();
  const status = invite.archived
    ? { label: 'Archived', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400' }
    : invite.revoked
    ? { label: 'Revoked', tone: 'bg-rose-500/15 text-rose-300 border-rose-500/30', dot: 'bg-rose-400' }
    : !invite.enabled
    ? { label: 'Paused',  tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400' }
    : invite.expiresAt && invite.expiresAt < now
    ? { label: 'Expired', tone: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30', dot: 'bg-zinc-400' }
    : invite.windowOpenAt && invite.windowOpenAt > now
    ? { label: 'Scheduled', tone: 'bg-sky-500/15 text-sky-300 border-sky-500/30', dot: 'bg-sky-400' }
    : invite.windowCloseAt && invite.windowCloseAt < now
    ? { label: 'Window closed', tone: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30', dot: 'bg-zinc-400' }
    : invite.maxUses != null && invite.useCount >= invite.maxUses
    ? { label: 'Full',    tone: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30', dot: 'bg-zinc-400' }
    : { label: 'Active',  tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', dot: 'bg-emerald-400' };

  const expIso = invite.expiresAt ? new Date(invite.expiresAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : null;
  const lastUsedAgo = invite.lastUsedAt ? timeAgo(new Date(invite.lastUsedAt).toISOString()) : null;
  const usageLabel = invite.maxUses != null
    ? `${invite.useCount} / ${invite.maxUses} uses`
    : `${invite.useCount} use${invite.useCount === 1 ? '' : 's'}`;

  return (
    <div className="glass-panel rounded-2xl p-5 border border-slate-800/80 shadow-[0_14px_40px_rgba(2,6,23,0.45)] hover:border-slate-700 transition flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <input value={draftName} onChange={(e) => setDraftName(e.target.value)}
                autoFocus
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-sm text-slate-100 font-medium"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { onRename(draftName.trim()); setEditingName(false); }
                  if (e.key === 'Escape') { setDraftName(invite.name); setEditingName(false); }
                }} />
              <button onClick={() => { onRename(draftName.trim()); setEditingName(false); }}
                className="p-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300">
                <i className="ph ph-check"></i>
              </button>
              <button onClick={() => { setDraftName(invite.name); setEditingName(false); }}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300">
                <i className="ph ph-x"></i>
              </button>
            </div>
          ) : (
            <button onClick={() => setEditingName(true)}
              className="text-base font-semibold text-slate-100 truncate text-left hover:text-cyan-300 transition flex items-center gap-1.5 w-full group">
              <span className="truncate">{invite.name}</span>
              <i className="ph ph-pencil-simple text-xs text-slate-500 group-hover:text-slate-300 shrink-0"></i>
            </button>
          )}
          <div className="text-xs text-slate-400 mt-0.5 font-mono">{invite.id}</div>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-full border ${status.tone}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
          {status.label}
        </span>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl py-2 px-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Submissions</div>
          <div className="text-sm font-bold text-slate-100 mt-0.5">{usageLabel}</div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl py-2 px-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Last used</div>
          <div className="text-sm font-bold text-slate-100 mt-0.5">{lastUsedAgo || '—'}</div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl py-2 px-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Expires</div>
          <div className="text-sm font-bold text-slate-100 mt-0.5">{expIso || 'Never'}</div>
        </div>
      </div>

      {/* Submission window (if set) */}
      {(invite.windowOpenAt || invite.windowCloseAt) && (
        <div className="grid grid-cols-2 gap-2 -mt-1">
          <div className="rounded-xl bg-sky-500/10 border border-sky-500/25 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-sky-300 flex items-center gap-1"><i className="ph ph-arrow-up-right"></i>Opens</div>
            <div className="text-xs font-semibold text-slate-100 mt-0.5">
              {invite.windowOpenAt ? new Date(invite.windowOpenAt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : 'Now'}
            </div>
          </div>
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300 flex items-center gap-1"><i className="ph ph-clock-countdown"></i>Closes</div>
            <div className="text-xs font-semibold text-slate-100 mt-0.5">
              {invite.windowCloseAt ? new Date(invite.windowCloseAt).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : 'Open-ended'}
            </div>
          </div>
        </div>
      )}

      {/* URL preview */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-2.5 flex items-center gap-2 group">
        <i className="ph ph-link text-slate-500 shrink-0"></i>
        <code className="flex-1 text-[11px] text-slate-200 truncate font-mono">{invite.url}</code>
        <button onClick={() => onCopy(invite.url, 'Invite URL copied')}
          title="Copy URL"
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition">
          <i className="ph ph-copy text-sm"></i>
        </button>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
        {/* Share / preview cluster */}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => onCopy(invite.url, 'Invite URL copied')}
            className="px-3 py-1.5 text-xs font-bold rounded-xl bg-brand-500 hover:bg-brand-400 text-slate-950 shadow-sm transition">
            <i className="ph ph-copy mr-1"></i>Copy link
          </button>
          <button onClick={onSend}
            className="px-3 py-1.5 text-xs font-bold rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-sm transition">
            <i className="ph ph-paper-plane-tilt mr-1"></i>Send
          </button>
          <button onClick={onPreview}
            className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-900 border border-slate-800 text-slate-200 hover:bg-slate-800 transition">
            <i className="ph ph-arrow-square-out mr-1"></i>Preview
          </button>
          <button onClick={onShowQr}
            className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-900 border border-slate-800 text-slate-200 hover:bg-slate-800 transition">
            <i className="ph ph-qr-code mr-1"></i>QR
          </button>
        </div>

        {/* Lifecycle cluster */}
        <div className="flex flex-wrap items-center gap-2">
          {onEdit && !invite.revoked && !invite.archived && (
            <button onClick={onEdit}
              className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-300 hover:bg-sky-500/25 transition"
              title="Edit details, extend expiration, change submission window">
              <i className="ph ph-pencil-simple mr-1"></i>Edit
            </button>
          )}
          {!invite.revoked && (
            <button
              onClick={() => onToggle(!invite.enabled)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-xl border transition ${
                invite.enabled
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25'
                  : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
              }`}
              title={invite.enabled ? 'Pause new submissions' : 'Resume submissions'}>
              <i className={`ph ${invite.enabled ? 'ph-pause' : 'ph-play'} mr-1`}></i>
              {invite.enabled ? 'Pause' : 'Resume'}
            </button>
          )}
          {!invite.revoked && !invite.archived && (
            <button onClick={onRevoke}
              className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 transition">
              <i className="ph ph-prohibit mr-1"></i>Revoke
            </button>
          )}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setMenuOpen((v) => !v)}
              className="px-2 py-1.5 text-xs font-semibold rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 transition"
              title="More actions">
              <i className="ph ph-dots-three-vertical"></i>
            </button>
            {menuOpen && (
              <div className="absolute right-0 bottom-full mb-1 w-48 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl py-1 z-20">
                <button onClick={() => { setMenuOpen(false); onArchive && onArchive(); }}
                  className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 flex items-center gap-2">
                  <i className={`ph ${invite.archived ? 'ph-arrow-counter-clockwise' : 'ph-archive'} text-amber-300`}></i>
                  {invite.archived ? 'Restore from archive' : 'Archive (hide from list)'}
                </button>
                <button onClick={() => { setMenuOpen(false); onDelete && onDelete(); }}
                  className="w-full text-left px-3 py-2 text-xs text-rose-300 hover:bg-rose-500/10 flex items-center gap-2">
                  <i className="ph ph-trash"></i>
                  Delete forever
                </button>
              </div>
            )}
          </div>
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
  const [windowOpenAt, setWindowOpenAt] = useState('');
  const [windowCloseAt, setWindowCloseAt] = useState('');

  const windowError = useMemo(() => {
    if (!windowOpenAt || !windowCloseAt) return null;
    return new Date(windowCloseAt).getTime() <= new Date(windowOpenAt).getTime()
      ? 'Close time must be after open time.'
      : null;
  }, [windowOpenAt, windowCloseAt]);

  const canSubmit = name.trim().length >= 2 && !busy && !windowError;

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

          {/* Submission window (optional) ------------------------------ */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <i className="ph ph-calendar-blank text-slate-400"></i>
                Submission window <span className="text-slate-500 font-normal">(optional)</span>
              </label>
              <button type="button"
                onClick={() => { setWindowOpenAt(''); setWindowCloseAt(''); }}
                className="text-[11px] text-slate-400 hover:text-white">Clear</button>
            </div>

            {/* Quick presets ─ one-tap date ranges, no calendar wrestling */}
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'Today', open: 'todayStart', close: 'todayEnd' },
                { label: 'Tomorrow', open: 'tomorrowStart', close: 'tomorrowEnd' },
                { label: 'This week', open: 'todayStart', close: 'weekEnd' },
                { label: 'Next 7 days', open: 'now', close: 'plus7' },
                { label: 'Next 30 days', open: 'now', close: 'plus30' },
              ].map((p) => (
                <button key={p.label} type="button"
                  onClick={() => {
                    const now = new Date();
                    const fmt = (d) => {
                      const pad = (n) => String(n).padStart(2, '0');
                      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    };
                    const presets = {
                      now: () => now,
                      todayStart: () => { const d = new Date(now); d.setHours(7,0,0,0); return d; },
                      todayEnd: () => { const d = new Date(now); d.setHours(18,0,0,0); return d; },
                      tomorrowStart: () => { const d = new Date(now); d.setDate(d.getDate()+1); d.setHours(7,0,0,0); return d; },
                      tomorrowEnd: () => { const d = new Date(now); d.setDate(d.getDate()+1); d.setHours(18,0,0,0); return d; },
                      weekEnd: () => { const d = new Date(now); d.setDate(d.getDate() + (7 - d.getDay())); d.setHours(18,0,0,0); return d; },
                      plus7: () => { const d = new Date(now); d.setDate(d.getDate()+7); return d; },
                      plus30: () => { const d = new Date(now); d.setDate(d.getDate()+30); return d; },
                    };
                    setWindowOpenAt(fmt(presets[p.open]()));
                    setWindowCloseAt(fmt(presets[p.close]()));
                  }}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 hover:border-slate-600">
                  {p.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  <i className="ph ph-arrow-up-right mr-1 text-emerald-400"></i>Opens
                </label>
                <input type="datetime-local" value={windowOpenAt}
                  onChange={(e) => setWindowOpenAt(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white
                             [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-brand-500/40
                             cursor-pointer hover:border-slate-600" />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  <i className="ph ph-clock-countdown mr-1 text-amber-400"></i>Closes
                </label>
                <input type="datetime-local" value={windowCloseAt}
                  min={windowOpenAt || undefined}
                  onChange={(e) => setWindowCloseAt(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white
                             [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-brand-500/40
                             cursor-pointer hover:border-slate-600" />
              </div>
            </div>
            {(windowOpenAt || windowCloseAt) && !windowError && (
              <div className="rounded-md bg-slate-900/60 border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 flex items-center gap-2">
                <i className="ph ph-info text-slate-400"></i>
                <span>
                  {windowOpenAt && <>Opens <strong className="text-emerald-300">{new Date(windowOpenAt).toLocaleString('en-GB', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}</strong></>}
                  {windowOpenAt && windowCloseAt && ' · '}
                  {windowCloseAt && <>Closes <strong className="text-amber-300">{new Date(windowCloseAt).toLocaleString('en-GB', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}</strong></>}
                </span>
              </div>
            )}
            {windowError && (
              <p className="text-[11px] text-rose-300"><i className="ph ph-warning mr-1"></i>{windowError}</p>
            )}
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Click a preset above for a one-tap date range, or use the calendar pickers
              for custom times. Outside this window the form refuses new submissions and
              shows parents the next opening time. Leave blank to allow any time before
              the link expires.
            </p>
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
              windowOpenAt:  windowOpenAt  ? new Date(windowOpenAt).toISOString()  : null,
              windowCloseAt: windowCloseAt ? new Date(windowCloseAt).toISOString() : null,
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

// Convert a millis-or-null timestamp into the `YYYY-MM-DDTHH:MM` shape
// that <input type="datetime-local"> requires. Returns '' for null.
function _toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditInviteModal({ invite, busy, onCancel, onSubmit }) {
  const [name, setName] = useState(invite.name || '');
  const [description, setDescription] = useState(invite.description || '');
  const [maxUses, setMaxUses] = useState(invite.maxUses != null ? String(invite.maxUses) : '');
  const [windowOpenAt, setWindowOpenAt] = useState(_toLocalInput(invite.windowOpenAt));
  const [windowCloseAt, setWindowCloseAt] = useState(_toLocalInput(invite.windowCloseAt));
  const [extendDays, setExtendDays] = useState('');         // "" = don't extend
  const [customExpiresAt, setCustomExpiresAt] = useState(''); // overrides extendDays if set

  const windowError = useMemo(() => {
    if (!windowOpenAt || !windowCloseAt) return null;
    return new Date(windowCloseAt).getTime() <= new Date(windowOpenAt).getTime()
      ? 'Close time must be after open time.'
      : null;
  }, [windowOpenAt, windowCloseAt]);

  const expiresMs = invite.expiresAt || null;
  const expiresLabel = expiresMs
    ? new Date(expiresMs).toLocaleString('en-GB', { weekday:'short', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
    : 'Never';
  const willRotateUrl = Boolean(extendDays || customExpiresAt);

  const canSubmit = name.trim().length >= 2 && !busy && !windowError;

  function submit() {
    // Build a patch with only the keys the admin actually changed.
    const patch = {};
    if (name.trim() !== (invite.name || '')) patch.name = name.trim();
    if (description.trim() !== (invite.description || '')) {
      patch.description = description.trim();
    }
    const curMax = invite.maxUses != null ? String(invite.maxUses) : '';
    if (maxUses !== curMax) {
      patch.maxUses = maxUses === '' ? null : Number(maxUses);
    }
    const curOpen = _toLocalInput(invite.windowOpenAt);
    const curClose = _toLocalInput(invite.windowCloseAt);
    if (windowOpenAt !== curOpen) {
      patch.windowOpenAt = windowOpenAt ? new Date(windowOpenAt).toISOString() : null;
    }
    if (windowCloseAt !== curClose) {
      patch.windowCloseAt = windowCloseAt ? new Date(windowCloseAt).toISOString() : null;
    }
    if (customExpiresAt) {
      patch.expiresAt = new Date(customExpiresAt).toISOString();
    } else if (extendDays) {
      patch.extendDays = Number(extendDays);
    }
    onSubmit(patch);
  }

  return (
    <div className="fixed inset-0 z-[1000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
         onClick={onCancel}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-6 shadow-2xl my-8"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-full bg-sky-500/20 flex items-center justify-center">
            <i className="ph ph-pencil-simple text-sky-300 text-xl"></i>
          </div>
          <div>
            <h3 className="text-white font-semibold">Edit invite link</h3>
            <p className="text-xs text-slate-400 font-mono">{invite.id}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280}
              placeholder="Notes for your team"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Max submissions</label>
            <input type="number" min="1" value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder="Unlimited"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500" />
            <p className="text-[11px] text-slate-500 mt-1">
              Already used <strong className="text-slate-300">{invite.useCount}</strong>.
              Leave blank for unlimited.
            </p>
          </div>

          {/* Expiration ---------------------------------------------- */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <i className="ph ph-clock-clockwise text-slate-400"></i>
                Extend expiration
              </label>
              <span className="text-[11px] text-slate-400">Currently expires: <strong className="text-slate-200">{expiresLabel}</strong></span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: '+7 days', days: 7 },
                { label: '+30 days', days: 30 },
                { label: '+90 days', days: 90 },
                { label: '+180 days', days: 180 },
                { label: '+1 year', days: 365 },
              ].map((p) => (
                <button key={p.days} type="button"
                  onClick={() => { setExtendDays(String(p.days)); setCustomExpiresAt(''); }}
                  className={`px-2.5 py-1 text-[11px] rounded-md border ${
                    String(extendDays) === String(p.days) && !customExpiresAt
                      ? 'bg-sky-500/20 border-sky-500/40 text-sky-200'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}>
                  {p.label}
                </button>
              ))}
              {(extendDays || customExpiresAt) && (
                <button type="button"
                  onClick={() => { setExtendDays(''); setCustomExpiresAt(''); }}
                  className="px-2.5 py-1 text-[11px] rounded-md bg-slate-800 border border-slate-700 text-slate-400 hover:text-white">
                  <i className="ph ph-x mr-1"></i>Don&apos;t change
                </button>
              )}
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-400 mb-1">…or pick an exact new expiry</label>
              <input type="datetime-local" value={customExpiresAt}
                min={_toLocalInput(Date.now() + 60_000)}
                onChange={(e) => { setCustomExpiresAt(e.target.value); setExtendDays(''); }}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white
                           [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-sky-500/40
                           cursor-pointer hover:border-slate-600" />
            </div>
            {willRotateUrl && (
              <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-200 leading-relaxed flex gap-2">
                <i className="ph ph-warning mt-0.5"></i>
                <span>
                  Extending expiration <strong>rotates the URL</strong> — the signed token
                  has to be re-issued. Old links keep working until their original expiry.
                  Re-share the new URL with parents after saving.
                </span>
              </div>
            )}
          </div>

          {/* Submission window --------------------------------------- */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <i className="ph ph-calendar-blank text-slate-400"></i>
                Submission window <span className="text-slate-500 font-normal">(optional)</span>
              </label>
              <button type="button"
                onClick={() => { setWindowOpenAt(''); setWindowCloseAt(''); }}
                className="text-[11px] text-slate-400 hover:text-white">Clear</button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  <i className="ph ph-arrow-up-right mr-1 text-emerald-400"></i>Opens
                </label>
                <input type="datetime-local" value={windowOpenAt}
                  onChange={(e) => setWindowOpenAt(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white
                             [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-brand-500/40
                             cursor-pointer hover:border-slate-600" />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">
                  <i className="ph ph-clock-countdown mr-1 text-amber-400"></i>Closes
                </label>
                <input type="datetime-local" value={windowCloseAt}
                  min={windowOpenAt || undefined}
                  onChange={(e) => setWindowCloseAt(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white
                             [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-brand-500/40
                             cursor-pointer hover:border-slate-600" />
              </div>
            </div>
            {windowError && (
              <p className="text-[11px] text-rose-300"><i className="ph ph-warning mr-1"></i>{windowError}</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onCancel} disabled={busy}
            className="px-4 py-2 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-white disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={!canSubmit}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-gradient-to-r from-sky-500 to-emerald-500 hover:from-sky-400 hover:to-emerald-400 text-white disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Saving…</> : <><i className="ph ph-check mr-1.5"></i>Save changes</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvitePreviewModal({ invite, qr, onClose, onCopy, urlChanged }) {
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
              <p className="text-xs text-slate-400">
                {urlChanged ? 'URL was rotated — re-share with parents' : 'Ready to share with parents'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl"><i className="ph ph-x"></i></button>
        </div>

        <div className="p-6 space-y-5">
          {urlChanged && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 text-xs text-amber-200 leading-relaxed flex gap-2">
              <i className="ph ph-warning mt-0.5"></i>
              <span>
                Because you extended the expiration, a new signed URL was issued.
                Please re-share the link / QR below. Old URLs will keep working
                until their original expiry date.
              </span>
            </div>
          )}
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

          {/* Submission window */}
          {(invite.windowOpenAt || invite.windowCloseAt) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-sky-500/5 border border-sky-500/20 px-3 py-2.5">
                <div className="text-[10px] text-sky-300/70 uppercase tracking-wider flex items-center gap-1">
                  <i className="ph ph-arrow-up-right"></i>Window opens
                </div>
                <div className="text-sm font-semibold text-white mt-0.5">
                  {invite.windowOpenAt
                    ? new Date(invite.windowOpenAt).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
                    : 'Now (no opening date)'}
                </div>
              </div>
              <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 px-3 py-2.5">
                <div className="text-[10px] text-amber-300/70 uppercase tracking-wider flex items-center gap-1">
                  <i className="ph ph-clock-countdown"></i>Window closes
                </div>
                <div className="text-sm font-semibold text-white mt-0.5">
                  {invite.windowCloseAt
                    ? new Date(invite.windowCloseAt).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
                    : 'Open-ended (until expiry)'}
                </div>
              </div>
            </div>
          )}

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

// ─────────────────────────────────────────────────────────────────────
// Send-invite modal: Email / WhatsApp / Toddle / QR tabs.
//
// Strategy: keep credentials out of the server. We pull the contact
// list and the integration settings from the API, then build:
//   • mailto:?bcc=…&subject=…&body=…   (opens admin's mail client)
//   • https://wa.me/<E.164>?text=…     (opens WhatsApp Web/app)
//   • Plain copy-text for Toddle / generic broadcast
//   • QR PNG (already on the invite payload)
// This avoids storing SMTP / WhatsApp Business creds in the repo and
// works with whatever account the admin is signed into locally.
// ─────────────────────────────────────────────────────────────────────
function SendInviteModal({ invite, qr, onClose, onCopy, pushToast }) {
  const CHANNELS = [
    { key: 'email',    label: 'Email',    icon: 'ph-envelope-simple', tone: 'sky' },
    { key: 'whatsapp', label: 'WhatsApp', icon: 'ph-whatsapp-logo',   tone: 'emerald' },
    { key: 'toddle',   label: 'Toddle',   icon: 'ph-graduation-cap',  tone: 'amber' },
    { key: 'qr',       label: 'QR Code',  icon: 'ph-qr-code',         tone: 'violet' },
  ];
  const [tab, setTab] = useState('email');
  const [contacts, setContacts] = useState(null);
  const [groups, setGroups] = useState([]);
  const [groupFilter, setGroupFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [settings, setSettings] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [cRes, sRes] = await Promise.all([
          fetch(`/api/pickup/admin/integrations?action=contacts&channel=${tab === 'whatsapp' ? 'whatsapp' : 'email'}`,
                { credentials: 'include' }),
          fetch('/api/pickup/admin/integrations?action=settings', { credentials: 'include' }),
        ]);
        const cJ = await cRes.json();
        const sJ = await sRes.json();
        if (cancel) return;
        if (cRes.ok && cJ.ok) { setContacts(cJ.contacts); setGroups(cJ.groups || []); }
        if (sRes.ok && sJ.ok) {
          setSettings(sJ.settings);
          if (!subject) setSubject(applyTemplate(sJ.settings.defaultEmailSubject, invite));
          if (!body)    setBody(applyTemplate(sJ.settings.defaultMessageBody, invite));
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancel = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function applyTemplate(t, inv) {
    if (!t) return '';
    const closeDate = inv.windowCloseAt
      ? new Date(inv.windowCloseAt).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
      : (inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—');
    return t
      .replace(/\{url\}/g, inv.url || '')
      .replace(/\{name\}/g, '{name}')                  // left for per-recipient if WA per-person
      .replace(/\{studentName\}/g, '{studentName}')
      .replace(/\{closeDate\}/g, closeDate)
      .replace(/\{ttl\}/g, inv.expiresAt ? `until ${new Date(inv.expiresAt).toLocaleDateString('en-GB')}` : '');
  }

  const filtered = useMemo(() => {
    if (!contacts) return [];
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => {
      if (groupFilter && (c.group || '') !== groupFilter) return false;
      if (q && !`${c.name} ${c.email || ''} ${c.phone || ''} ${c.studentName || ''}`.toLowerCase().includes(q)) return false;
      if (tab === 'email' && !c.email) return false;
      if (tab === 'whatsapp' && !c.phone) return false;
      return true;
    });
  }, [contacts, search, groupFilter, tab]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (filtered.every((c) => selected.has(c.id))) {
      setSelected((prev) => { const n = new Set(prev); filtered.forEach((c) => n.delete(c.id)); return n; });
    } else {
      setSelected((prev) => { const n = new Set(prev); filtered.forEach((c) => n.add(c.id)); return n; });
    }
  }

  const selectedContacts = useMemo(() =>
    (contacts || []).filter((c) => selected.has(c.id)),
    [contacts, selected]);

  // ── Email send ────────────────────────────────────────────────────
  function sendEmail() {
    const targets = selectedContacts.filter((c) => c.email);
    if (!targets.length) { pushToast('error', 'Select at least one contact with an email.', 'No recipients'); return; }
    if (targets.length > 200) { pushToast('error', 'Most mail clients cap at ~100 BCC. Send in batches.', 'Too many recipients'); return; }
    const bcc = targets.map((c) => c.email).join(',');
    const url = `mailto:?bcc=${encodeURIComponent(bcc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (url.length > 1900) { pushToast('error', 'Mail link too long — copy the body and use Compose manually.', 'Too long'); return; }
    window.location.href = url;
    pushToast('success', `Opening your mail app with ${targets.length} BCC recipient${targets.length===1?'':'s'}.`, 'Email');
  }

  async function sendEmailQueued() {
    const targets = selectedContacts.filter((c) => c.email);
    if (!targets.length) { pushToast('error', 'Select at least one contact with an email.', 'No recipients'); return; }

    try {
      const r = await fetch('/api/pickup/admin/integrations?action=campaign-email', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignName: `Invite ${invite.name || invite.id}`,
          contactIds: targets.map((c) => c.id),
          subject,
          message: body,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'queue enqueue failed');
      pushToast('success', `Queued ${j.queued || targets.length} email${(j.queued || targets.length) === 1 ? '' : 's'} for delivery.`, 'Campaign queued');
    } catch (e) {
      pushToast('error', e.message || 'Failed to enqueue campaign', 'Queue failed');
    }
  }

  // ── WhatsApp send (per-contact tab opener) ────────────────────────
  function sendWhatsApp() {
    const targets = selectedContacts.filter((c) => c.phone);
    if (!targets.length) { pushToast('error', 'Select at least one contact with a phone number.', 'No recipients'); return; }
    if (targets.length > 30) {
      if (!confirm(`This will open ${targets.length} WhatsApp tabs. Continue?`)) return;
    }
    targets.forEach((c, i) => {
      const personal = body.replace(/\{name\}/g, c.name).replace(/\{studentName\}/g, c.studentName || c.name);
      const phone = c.phone.replace(/\D/g, '');
      const url = `https://wa.me/${phone}?text=${encodeURIComponent(personal)}`;
      // Stagger so popup blocker doesn't kill them
      setTimeout(() => window.open(url, '_blank', 'noopener'), i * 250);
    });
    pushToast('success', `Opening ${targets.length} WhatsApp chat${targets.length===1?'':'s'}.`, 'WhatsApp');
  }

  // ── WhatsApp broadcast (single click → admin's WA Business URL) ──
  function openBroadcast() {
    const url = settings?.whatsappBroadcastUrl;
    if (!url) { pushToast('error', 'Set the WhatsApp broadcast URL in Integrations Settings first.', 'Not configured'); return; }
    window.open(url, '_blank', 'noopener');
  }

  // ── Toddle copy ───────────────────────────────────────────────────
  function copyForToddle() {
    const text = body.replace(/\{name\}/g, 'parents').replace(/\{studentName\}/g, 'your child');
    onCopy(text, 'Toddle message copied — paste into Announcements');
  }
  function openToddle() {
    const url = settings?.toddleAccountUrl;
    if (!url) { pushToast('error', 'Set your Toddle account URL in Integrations Settings.', 'Not configured'); return; }
    window.open(url, '_blank', 'noopener');
  }

  // ── Layout helpers ────────────────────────────────────────────────
  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  return (
    <div className="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full shadow-2xl my-8"
           onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <i className="ph ph-paper-plane-tilt text-emerald-300 text-lg"></i>
            </div>
            <div>
              <h3 className="text-white font-semibold leading-tight">Send invite</h3>
              <p className="text-xs text-slate-400">{invite.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl"><i className="ph ph-x"></i></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950/50 px-3">
          {CHANNELS.map((c) => {
            const active = tab === c.key;
            return (
              <button key={c.key} onClick={() => setTab(c.key)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition ${
                  active ? 'border-emerald-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}>
                <i className={`ph ${c.icon}`}></i>
                {c.label}
              </button>
            );
          })}
        </div>

        <div className="p-6 space-y-4">
          {/* QR tab — simple, no contacts */}
          {tab === 'qr' && (
            <div className="flex flex-col items-center gap-3">
              {qr ? (
                <>
                  <div className="bg-white p-4 rounded-xl"><img src={qr} alt="Invite QR" className="w-64 h-64" /></div>
                  <a href={qr} download={`invite-${invite.id}.png`}
                    className="px-4 py-2 text-sm font-semibold rounded-lg bg-violet-600 hover:bg-violet-500 text-white">
                    <i className="ph ph-download-simple mr-1.5"></i>Download PNG
                  </a>
                  <p className="text-xs text-slate-400 text-center max-w-md">
                    Print or display the QR. Parents scanning it land on the same secure invite URL.
                  </p>
                </>
              ) : (
                <div className="text-slate-400 text-sm">QR not available.</div>
              )}
            </div>
          )}

          {/* Toddle tab */}
          {tab === 'toddle' && (
            <div className="space-y-4">
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-100 leading-relaxed">
                <i className="ph ph-info mr-1"></i>
                Toddle doesn&apos;t expose a public send-API, so we generate a polished
                announcement you can paste into the <strong>Announcements</strong> module.
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 mb-1 block">Message</label>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono leading-relaxed" />
              </div>
              <div className="flex flex-wrap gap-2 justify-end">
                <button onClick={copyForToddle}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-900">
                  <i className="ph ph-copy mr-1.5"></i>Copy message
                </button>
                <button onClick={openToddle}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-700 hover:bg-slate-600 text-white">
                  <i className="ph ph-arrow-square-out mr-1.5"></i>Open Toddle
                </button>
              </div>
            </div>
          )}

          {/* Email + WhatsApp share most of the same UI */}
          {(tab === 'email' || tab === 'whatsapp') && (
            <div className="space-y-4">
              {/* Filter + select-all */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-[200px] flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3">
                  <i className="ph ph-magnifying-glass text-slate-500"></i>
                  <input value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name, email or phone…"
                    className="flex-1 bg-transparent py-2 text-sm text-white placeholder:text-slate-500 outline-none" />
                </div>
                {groups.length > 0 && (
                  <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                    <option value="">All groups</option>
                    {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                )}
                <button onClick={toggleAll} disabled={!filtered.length}
                  className="px-3 py-2 text-xs font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10 disabled:opacity-40">
                  {allFilteredSelected ? 'Deselect all' : 'Select all'} ({filtered.length})
                </button>
              </div>

              {/* Contact list */}
              <div className="border border-slate-800 rounded-lg max-h-56 overflow-y-auto bg-black/20">
                {contacts === null ? (
                  <div className="p-4 text-sm text-slate-400">Loading contacts…</div>
                ) : filtered.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">
                    No contacts {tab === 'email' ? 'with email' : 'with phone'} yet.{' '}
                    <span className="text-slate-500">Use Integrations Settings to import.</span>
                  </div>
                ) : (
                  filtered.map((c) => (
                    <label key={c.id}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-white/5 cursor-pointer border-b border-slate-800/50 last:border-0">
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)}
                        className="rounded text-emerald-500 focus:ring-emerald-400" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{c.name}</div>
                        <div className="text-xs text-slate-400 truncate">
                          {tab === 'email' ? c.email : c.phone}
                          {c.group && <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-700/60 text-[10px] text-slate-300">{c.group}</span>}
                          {c.studentName && <span className="ml-2 text-slate-500">· {c.studentName}</span>}
                        </div>
                      </div>
                    </label>
                  ))
                )}
              </div>
              <div className="text-xs text-slate-500">
                {selected.size} of {(contacts || []).length} contacts selected
              </div>

              {/* Subject (email only) */}
              {tab === 'email' && (
                <div>
                  <label className="text-xs font-semibold text-slate-300 mb-1 block">Subject</label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                </div>
              )}

              {/* Body */}
              <div>
                <label className="text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
                  <span>Message</span>
                  <span className="text-[10px] font-normal text-slate-500 font-mono">
                    placeholders: {'{url}'} {'{name}'} {'{studentName}'} {'{closeDate}'}
                  </span>
                </label>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono leading-relaxed" />
              </div>

              {/* Action row */}
              <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-slate-800">
                {tab === 'whatsapp' && settings?.whatsappBroadcastUrl && (
                  <button onClick={openBroadcast}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10">
                    <i className="ph ph-broadcast mr-1.5"></i>Open broadcast tool
                  </button>
                )}
                <button onClick={() => onCopy(body, 'Message copied')}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-200 hover:bg-white/10">
                  <i className="ph ph-copy mr-1.5"></i>Copy message
                </button>
                {tab === 'email' && (
                  <>
                    <button onClick={sendEmailQueued} disabled={!selected.size}
                      className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                      title="Send through server queue with delivery tracking">
                      <i className="ph ph-envelope-simple-open mr-1.5"></i>Queue email send ({selected.size})
                    </button>
                    <button onClick={sendEmail} disabled={!selected.size}
                      className="px-4 py-2 text-sm font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
                      title="Opens your local mail app with BCC list">
                      <i className="ph ph-paper-plane-tilt mr-1.5"></i>Open in mail app ({selected.size})
                    </button>
                  </>
                )}
                {tab === 'whatsapp' && (
                  <button onClick={sendWhatsApp} disabled={!selected.size}
                    className="px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">
                    <i className="ph ph-whatsapp-logo mr-1.5"></i>Send via WhatsApp ({selected.size})
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Integrations Settings modal — manages contacts (paste/CSV import)
// and per-tenant integration URLs (WhatsApp broadcast / Toddle).
// ─────────────────────────────────────────────────────────────────────
function IntegrationsSettingsModal({ onClose, pushToast }) {
  const TABS = [
    { key: 'contacts',     label: 'Contacts',     icon: 'ph-address-book' },
    { key: 'integrations', label: 'Integrations', icon: 'ph-plugs-connected' },
    { key: 'templates',    label: 'Templates',    icon: 'ph-text-aa' },
  ];
  const [tab, setTab] = useState('contacts');
  const [settings, setSettings] = useState(null);
  const [counts, setCounts] = useState(null);
  const [contacts, setContacts] = useState(null);
  const [groups, setGroups] = useState([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        fetch('/api/pickup/admin/integrations?action=settings', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/pickup/admin/integrations?action=contacts', { credentials: 'include' }).then((r) => r.json()),
      ]);
      if (s.ok) { setSettings(s.settings); setCounts(s.counts); }
      if (c.ok) { setContacts(c.contacts); setGroups(c.groups || []); }
    } catch (e) {
      pushToast('error', e.message, 'Load failed');
    }
  }, [pushToast]);
  useEffect(() => { reload(); }, [reload]);

  async function saveSettings() {
    setBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/integrations?action=settings', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      pushToast('success', 'Integration settings saved.', 'Saved');
      await reload();
    } catch (e) { pushToast('error', e.message, 'Save failed'); }
    finally { setBusy(false); }
  }

  async function importContacts() {
    if (!importText.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/integrations?action=import', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: importText }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      pushToast('success', `Added ${j.added}, skipped ${j.skipped}.`, 'Import done');
      setImportText(''); setShowImport(false);
      await reload();
    } catch (e) { pushToast('error', e.message, 'Import failed'); }
    finally { setBusy(false); }
  }

  async function deleteContact(id) {
    if (!confirm('Remove this contact?')) return;
    try {
      const r = await fetch(`/api/pickup/admin/integrations?action=contacts&id=${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await reload();
    } catch (e) { pushToast('error', e.message, 'Delete failed'); }
  }

  const filtered = useMemo(() => {
    if (!contacts) return [];
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      `${c.name} ${c.email || ''} ${c.phone || ''} ${c.group || ''} ${c.studentName || ''}`.toLowerCase().includes(q));
  }, [contacts, search]);

  return (
    <div className="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full shadow-2xl my-8"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-brand-500/20 flex items-center justify-center">
              <i className="ph ph-gear-six text-brand-300 text-lg"></i>
            </div>
            <div>
              <h3 className="text-white font-semibold leading-tight">Integrations Settings</h3>
              <p className="text-xs text-slate-400">Contacts, WhatsApp, Toddle &amp; message templates</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl"><i className="ph ph-x"></i></button>
        </div>

        <div className="flex border-b border-slate-800 bg-slate-950/50 px-3">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition ${
                tab === t.key ? 'border-brand-400 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}>
              <i className={`ph ${t.icon}`}></i>{t.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {/* CONTACTS */}
          {tab === 'contacts' && (
            <div className="space-y-4">
              {counts && (
                <div className="grid grid-cols-4 gap-2 text-center">
                  <div className="bg-white/5 rounded-lg py-2">
                    <div className="text-[10px] text-slate-500 uppercase">Total</div>
                    <div className="text-lg font-bold text-white">{counts.total}</div>
                  </div>
                  <div className="bg-sky-500/10 rounded-lg py-2">
                    <div className="text-[10px] text-sky-300 uppercase">Email</div>
                    <div className="text-lg font-bold text-white">{counts.email + counts.both}</div>
                  </div>
                  <div className="bg-emerald-500/10 rounded-lg py-2">
                    <div className="text-[10px] text-emerald-300 uppercase">WhatsApp</div>
                    <div className="text-lg font-bold text-white">{counts.whatsapp + counts.both}</div>
                  </div>
                  <div className="bg-violet-500/10 rounded-lg py-2">
                    <div className="text-[10px] text-violet-300 uppercase">Both</div>
                    <div className="text-lg font-bold text-white">{counts.both}</div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-[200px] flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3">
                  <i className="ph ph-magnifying-glass text-slate-500"></i>
                  <input value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search contacts…"
                    className="flex-1 bg-transparent py-2 text-sm text-white placeholder:text-slate-500 outline-none" />
                </div>
                <button onClick={() => setShowImport((v) => !v)}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-brand-500 hover:bg-brand-400 text-white">
                  <i className="ph ph-upload-simple mr-1"></i>Import
                </button>
              </div>

              {showImport && (
                <div className="rounded-xl border border-brand-500/30 bg-brand-500/5 p-4 space-y-3">
                  <div className="text-sm text-white font-semibold">Bulk import emails</div>
                  <div className="text-xs text-slate-400 leading-relaxed">
                    Paste any block of text containing email addresses — one per line, comma-separated, copied
                    from a sheet, or even <code className="text-slate-300">Name &lt;alice@x.com&gt;</code>.
                    Everything that isn&apos;t a valid email is ignored. Duplicates are skipped automatically.
                  </div>
                  <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={6}
                    placeholder={'alice@example.com\nbob@example.com, carol@example.com\nDavid Tan <david@example.com>'}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono" />
                  <div className="flex justify-end">
                    <button onClick={importContacts} disabled={busy || !importText.trim()}
                      className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-500 hover:bg-brand-400 text-white disabled:opacity-40">
                      {busy ? 'Importing…' : 'Import emails'}
                    </button>
                  </div>
                </div>
              )}

              <div className="border border-slate-800 rounded-lg max-h-72 overflow-y-auto bg-black/20">
                {contacts === null ? (
                  <div className="p-4 text-sm text-slate-400">Loading…</div>
                ) : filtered.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">No contacts yet.</div>
                ) : (
                  filtered.map((c) => (
                    <div key={c.id}
                      className="flex items-center gap-3 px-3 py-2 border-b border-slate-800/50 last:border-0 hover:bg-white/5">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate flex items-center gap-2">
                          {c.name}
                          {c.channel === 'both' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">EMAIL+WA</span>}
                          {c.channel === 'email' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-200">EMAIL</span>}
                          {c.channel === 'whatsapp' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">WA</span>}
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {c.email && <span className="mr-2">{c.email}</span>}
                          {c.phone && <span>{c.phone}</span>}
                          {c.group && <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-700/60 text-[10px]">{c.group}</span>}
                        </div>
                      </div>
                      <button onClick={() => deleteContact(c.id)}
                        className="p-1.5 text-slate-500 hover:text-rose-400">
                        <i className="ph ph-trash"></i>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* INTEGRATIONS */}
          {tab === 'integrations' && settings && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 mb-1 block flex items-center gap-1.5">
                  <i className="ph ph-whatsapp-logo text-emerald-400"></i>
                  WhatsApp broadcast URL
                </label>
                <input value={settings.whatsappBroadcastUrl}
                  onChange={(e) => setSettings({ ...settings, whatsappBroadcastUrl: e.target.value })}
                  placeholder="https://app.wati.io/… or https://business.facebook.com/…"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                <p className="text-[11px] text-slate-500 mt-1">
                  Used by the &quot;Open broadcast tool&quot; button in the WhatsApp tab.
                  Leave blank to send 1-by-1 via wa.me.
                </p>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 mb-1 block flex items-center gap-1.5">
                  <i className="ph ph-graduation-cap text-amber-400"></i>
                  Toddle account URL
                </label>
                <input value={settings.toddleAccountUrl}
                  onChange={(e) => setSettings({ ...settings, toddleAccountUrl: e.target.value })}
                  placeholder="https://app.toddleapp.com/o/your-school/announcements"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                <p className="text-[11px] text-slate-500 mt-1">
                  Opens directly when admin clicks &quot;Open Toddle&quot; in the send dialog.
                </p>
              </div>

              <div className="flex justify-end pt-2">
                <button onClick={saveSettings} disabled={busy}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-500 hover:bg-brand-400 text-white disabled:opacity-40">
                  {busy ? 'Saving…' : 'Save integrations'}
                </button>
              </div>
            </div>
          )}

          {/* TEMPLATES */}
          {tab === 'templates' && settings && (
            <div className="space-y-4">
              <div className="rounded-lg bg-slate-800/50 border border-slate-700 px-3 py-2 text-xs text-slate-400">
                Placeholders: <code className="text-slate-200">{'{url}'}</code>{' '}
                <code className="text-slate-200">{'{name}'}</code>{' '}
                <code className="text-slate-200">{'{studentName}'}</code>{' '}
                <code className="text-slate-200">{'{closeDate}'}</code>{' '}
                <code className="text-slate-200">{'{ttl}'}</code>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 mb-1 block">Default email subject</label>
                <input value={settings.defaultEmailSubject}
                  onChange={(e) => setSettings({ ...settings, defaultEmailSubject: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 mb-1 block">Default message body</label>
                <textarea value={settings.defaultMessageBody} rows={10}
                  onChange={(e) => setSettings({ ...settings, defaultMessageBody: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono" />
              </div>
              <div className="flex justify-end pt-2">
                <button onClick={saveSettings} disabled={busy}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-500 hover:bg-brand-400 text-white disabled:opacity-40">
                  {busy ? 'Saving…' : 'Save templates'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
