import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';

const TABS = [
  { key: 'students', label: 'Students', icon: 'ph-student' },
  { key: 'classes', label: 'Classes', icon: 'ph-buildings' },
  { key: 'imports', label: 'Imports', icon: 'ph-upload-simple' },
  { key: 'health', label: 'Health', icon: 'ph-heartbeat' },
];

const EMPTY_SUMMARY = {
  totalStudents: 0,
  totalClasses: 0,
  totalLevels: 0,
  faceEnrolled: 0,
  deviceEnrolled: 0,
  missingHomeroom: 0,
  missingParentPhone: 0,
};

function cn(...parts) {
  return parts.filter(Boolean).join(' ');
}

function SummaryCard({ title, value, note, tone = 'sky' }) {
  const tones = {
    sky: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    rose: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  };
  return (
    <div className={cn('rounded-2xl border p-4', tones[tone])}>
      <div className="text-[11px] uppercase tracking-[0.22em] text-white/60">{title}</div>
      <div className="mt-2 text-3xl font-semibold text-white">{value}</div>
      <div className="mt-1 text-xs text-white/70">{note}</div>
    </div>
  );
}

function StudentModal({ open, student, classOptions, saving, onClose, onSave }) {
  const [form, setForm] = useState({ name: '', homeroom: '', gender: '', parentName: '', parentPhone: '', active: true });
  useEffect(() => {
    if (!student) return;
    setForm({
      name: student.name || '',
      homeroom: student.homeroom || '',
      gender: student.gender || '',
      parentName: student.parentName || '',
      parentPhone: student.parentPhone || '',
      active: student.active !== false,
    });
  }, [student]);
  if (!open || !student) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-2xl rounded-3xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-white">Edit student</div>
            <div className="text-xs text-slate-400">Update profile and class assignment for {student.name || student.studentId}.</div>
          </div>
          <button className="text-slate-400 hover:text-white" onClick={onClose}><i className="ph ph-x text-xl" /></button>
        </div>
        <div className="grid gap-4 p-6 md:grid-cols-2">
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Student name</span>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400" />
          </label>
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Class</span>
            <select value={form.homeroom} onChange={(e) => setForm((f) => ({ ...f, homeroom: e.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400">
              <option value="">Unassigned</option>
              {classOptions.map((item) => <option key={item.id} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Gender</span>
            <input value={form.gender} onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400" />
          </label>
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Parent name</span>
            <input value={form.parentName} onChange={(e) => setForm((f) => ({ ...f, parentName: e.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400" />
          </label>
          <label className="text-sm text-slate-300 md:col-span-2">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Parent phone</span>
            <input value={form.parentPhone} onChange={(e) => setForm((f) => ({ ...f, parentPhone: e.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400" />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-slate-300 md:col-span-2">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
            Active student record
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-6 py-4">
          <button onClick={onClose} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-white">Cancel</button>
          <button onClick={() => onSave(form)} disabled={saving} className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60">
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ClassModal({ open, mode, item, saving, onClose, onSave }) {
  const [form, setForm] = useState({ label: '', level: '', notes: '', active: true });
  useEffect(() => {
    setForm({
      label: item?.label || '',
      level: item?.level || '',
      notes: item?.notes || '',
      active: item?.active !== false,
    });
  }, [item]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl rounded-3xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-white">{mode === 'create' ? 'Add class' : 'Edit class'}</div>
            <div className="text-xs text-slate-400">Managed class metadata drives filters, dropdowns, and exports.</div>
          </div>
          <button className="text-slate-400 hover:text-white" onClick={onClose}><i className="ph ph-x text-xl" /></button>
        </div>
        <div className="grid gap-4 p-6">
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Class label</span>
            <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value.toUpperCase() }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400" placeholder="EY1 or 4A" />
          </label>
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Level</span>
            <input value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value.toUpperCase() }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400" placeholder="EY or 4" />
          </label>
          <label className="text-sm text-slate-300">
            <span className="mb-1 block text-xs uppercase tracking-[0.2em] text-slate-500">Notes</span>
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={3} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-400" />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
            Active class
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-6 py-4">
          <button onClick={onClose} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-white">Cancel</button>
          <button onClick={() => onSave(form)} disabled={saving} className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60">
            {saving ? 'Saving...' : mode === 'create' ? 'Create class' : 'Save class'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StudentClassManagementPage() {
  const [activeTab, setActiveTab] = useState('students');
  const [students, setStudents] = useState([]);
  const [classes, setClasses] = useState([]);
  const [studentSummary, setStudentSummary] = useState(EMPTY_SUMMARY);
  const [classSummary, setClassSummary] = useState({ totalClasses: 0, activeClasses: 0, managedClasses: 0, totalStudents: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [studentModal, setStudentModal] = useState(null);
  const [classModal, setClassModal] = useState({ mode: 'create', item: null, open: false });
  const [savingStudent, setSavingStudent] = useState(false);
  const [savingClass, setSavingClass] = useState(false);
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [studentRes, classRes] = await Promise.all([
        fetch('/api/pickup/admin/student-class-management/students', { credentials: 'include' }).then((r) => r.json().then((j) => ({ ok: r.ok, body: j }))),
        fetch('/api/pickup/admin/student-class-management/classes', { credentials: 'include' }).then((r) => r.json().then((j) => ({ ok: r.ok, body: j }))),
      ]);
      if (!studentRes.ok) throw new Error(studentRes.body?.error || 'Failed loading students');
      if (!classRes.ok) throw new Error(classRes.body?.error || 'Failed loading classes');
      setStudents(studentRes.body.items || []);
      setClasses(classRes.body.items || []);
      setStudentSummary(studentRes.body.summary || EMPTY_SUMMARY);
      setClassSummary(classRes.body.summary || { totalClasses: 0, activeClasses: 0, managedClasses: 0, totalStudents: 0 });
    } catch (err) {
      setError(err.message || 'Failed loading student and class directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filteredStudents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return students.filter((item) => {
      const matchesSearch = !q || [
        item.studentId,
        item.name,
        item.homeroom,
        item.level,
        item.parentName,
        item.parentPhone,
      ].some((value) => String(value || '').toLowerCase().includes(q));
      const matchesClass = classFilter === 'all' || item.homeroom === classFilter;
      const matchesLevel = levelFilter === 'all' || item.level === levelFilter;
      return matchesSearch && matchesClass && matchesLevel;
    });
  }, [students, search, classFilter, levelFilter]);

  const filteredClasses = useMemo(() => {
    const q = search.trim().toLowerCase();
    return classes.filter((item) => {
      const matchesSearch = !q || [item.label, item.level, item.notes].some((value) => String(value || '').toLowerCase().includes(q));
      const matchesLevel = levelFilter === 'all' || item.level === levelFilter;
      return matchesSearch && matchesLevel;
    });
  }, [classes, search, levelFilter]);

  const classOptions = useMemo(() => classes.filter((item) => item.active !== false), [classes]);
  const levels = useMemo(() => Array.from(new Set(classes.map((item) => item.level).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })), [classes]);

  const saveStudent = async (form) => {
    if (!studentModal) return;
    setSavingStudent(true);
    setNotice('');
    try {
      const response = await fetch('/api/pickup/admin/student-class-management/students', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: studentModal.id, patch: form }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed saving student');
      setStudentModal(null);
      setNotice('Student profile updated.');
      await load();
    } catch (err) {
      setError(err.message || 'Failed saving student');
    } finally {
      setSavingStudent(false);
    }
  };

  const saveClass = async (form) => {
    setSavingClass(true);
    setNotice('');
    try {
      const method = classModal.mode === 'create' ? 'POST' : 'PATCH';
      const bodyPayload = classModal.mode === 'create'
        ? form
        : { classId: classModal.item?.id, patch: form };
      const response = await fetch('/api/pickup/admin/student-class-management/classes', {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed saving class');
      setClassModal({ mode: 'create', item: null, open: false });
      setNotice(classModal.mode === 'create' ? 'Class created.' : 'Class updated.');
      await load();
    } catch (err) {
      setError(err.message || 'Failed saving class');
    } finally {
      setSavingClass(false);
    }
  };

  return (
    <>
      <Head>
        <title>Student & Class Management · BINUS Dashboard</title>
      </Head>
      <V2Layout>
        <div className="space-y-6 p-4 md:p-6">
          <section className="rounded-3xl border border-slate-800 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_28%),linear-gradient(135deg,#020617,#0f172a_46%,#111827)] p-6 shadow-[0_24px_80px_rgba(2,6,23,0.45)]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-sky-200">Pickup operations workspace</div>
                <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-4xl">Student & Class Management</h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                  Centralize class configuration, student directory cleanup, and export-ready roster operations for ACOP.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/v2/admin/downloads?card=students-roster" className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-sky-400 hover:text-white">Student roster export</Link>
                <Link href="/v2/admin/downloads?card=class-directory" className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-sky-400 hover:text-white">Class directory export</Link>
                <button onClick={() => setClassModal({ mode: 'create', item: null, open: true })} className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500">Add class</button>
              </div>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard title="Students" value={studentSummary.totalStudents} note="Active directory records" tone="sky" />
            <SummaryCard title="Classes" value={classSummary.totalClasses} note={`${classSummary.managedClasses} managed classes`} tone="emerald" />
            <SummaryCard title="Face Ready" value={studentSummary.faceEnrolled} note={`${studentSummary.deviceEnrolled} enrolled on device`} tone="amber" />
            <SummaryCard title="Needs Cleanup" value={studentSummary.missingParentPhone + studentSummary.missingHomeroom} note="Missing class or parent phone" tone="rose" />
          </section>

          <section className="rounded-3xl border border-slate-800 bg-slate-900/80 shadow-xl">
            <div className="border-b border-slate-800 px-5 pt-5">
              <div className="flex flex-wrap gap-2">
                {TABS.map((tab) => (
                  <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={cn('inline-flex items-center gap-2 rounded-t-2xl px-4 py-3 text-sm font-medium transition', activeTab === tab.key ? 'border border-b-0 border-slate-700 bg-slate-950 text-white' : 'text-slate-400 hover:text-slate-200')}>
                    <i className={`ph ${tab.icon}`} />
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-b border-slate-800 px-5 py-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px_auto]">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={activeTab === 'classes' ? 'Search class, level, notes…' : 'Search student, ID, parent, class…'} className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-sky-400" />
                <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} disabled={activeTab === 'classes'} className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-sky-400 disabled:opacity-50">
                  <option value="all">All classes</option>
                  {classes.map((item) => <option key={item.id} value={item.key}>{item.label}</option>)}
                </select>
                <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-sky-400">
                  <option value="all">All levels</option>
                  {levels.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <button onClick={load} className="rounded-2xl border border-slate-700 px-4 py-3 text-sm text-slate-200 hover:border-slate-500 hover:text-white">Refresh</button>
              </div>
              {notice && <div className="mt-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{notice}</div>}
              {error && <div className="mt-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}
            </div>

            <div className="p-5">
              {loading ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-12 text-center text-sm text-slate-400">Loading directory…</div>
              ) : activeTab === 'students' ? (
                <div className="overflow-hidden rounded-2xl border border-slate-800">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-slate-800 text-sm">
                      <thead className="bg-slate-950/80 text-left text-[11px] uppercase tracking-[0.18em] text-slate-500">
                        <tr>
                          <th className="px-4 py-3">Student</th>
                          <th className="px-4 py-3">Class</th>
                          <th className="px-4 py-3">Parent</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 bg-slate-900/60">
                        {filteredStudents.map((item) => (
                          <tr key={item.id} className="hover:bg-white/[0.03]">
                            <td className="px-4 py-3 align-top">
                              <div className="font-medium text-white">{item.name || 'Unnamed student'}</div>
                              <div className="mt-1 text-xs text-slate-400">{item.studentId || item.id}</div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="text-slate-200">{item.homeroom || 'Unassigned'}</div>
                              <div className="mt-1 text-xs text-slate-500">Level {item.level || '—'}</div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="text-slate-200">{item.parentName || '—'}</div>
                              <div className="mt-1 text-xs text-slate-500">{item.parentPhone || 'No phone recorded'}</div>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <div className="flex flex-wrap gap-2">
                                <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', item.active ? 'bg-emerald-500/10 text-emerald-200' : 'bg-slate-700 text-slate-300')}>{item.active ? 'Active' : 'Inactive'}</span>
                                <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', item.faceCount > 0 ? 'bg-sky-500/10 text-sky-200' : 'bg-amber-500/10 text-amber-200')}>{item.faceCount > 0 ? `${item.faceCount} face${item.faceCount > 1 ? 's' : ''}` : 'No face'}</span>
                                <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', item.deviceEnrolled ? 'bg-violet-500/10 text-violet-200' : 'bg-slate-700 text-slate-300')}>{item.deviceEnrolled ? 'Device ready' : 'Not on device'}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top text-right">
                              <button onClick={() => setStudentModal(item)} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:border-sky-400 hover:text-white">Edit</button>
                            </td>
                          </tr>
                        ))}
                        {filteredStudents.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">No students match the current filters.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : activeTab === 'classes' ? (
                <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                  {filteredClasses.map((item) => (
                    <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-lg font-semibold text-white">{item.label}</div>
                          <div className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">Level {item.level || '—'}</div>
                        </div>
                        <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', item.active ? 'bg-emerald-500/10 text-emerald-200' : 'bg-slate-700 text-slate-300')}>
                          {item.active ? 'Active' : 'Archived'}
                        </span>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-300">
                        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3"><div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Students</div><div className="mt-1 text-xl font-semibold text-white">{item.studentCount}</div></div>
                        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3"><div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Face ready</div><div className="mt-1 text-xl font-semibold text-white">{item.faceReady}</div></div>
                        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3"><div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Device ready</div><div className="mt-1 text-xl font-semibold text-white">{item.deviceReady}</div></div>
                        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3"><div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Missing phone</div><div className="mt-1 text-xl font-semibold text-white">{item.missingParentPhone}</div></div>
                      </div>
                      <div className="mt-4 text-sm text-slate-400">{item.notes || 'No class notes configured yet.'}</div>
                      <div className="mt-4 flex items-center justify-between">
                        <div className="text-xs text-slate-500">{item.managed ? 'Managed class' : 'Derived from student data'}</div>
                        <button onClick={() => setClassModal({ mode: 'edit', item, open: true })} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:border-sky-400 hover:text-white">Edit class</button>
                      </div>
                    </div>
                  ))}
                  {filteredClasses.length === 0 && (
                    <div className="rounded-2xl border border-slate-800 bg-slate-950 px-4 py-10 text-center text-sm text-slate-500 lg:col-span-2 2xl:col-span-3">No classes match the current filters.</div>
                  )}
                </div>
              ) : activeTab === 'imports' ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
                    <div className="text-lg font-semibold text-white">Import pipeline</div>
                    <p className="mt-2 text-sm leading-6 text-slate-400">Bulk CSV/XLSX import preview is the next slice. This tab is reserved for roster upload validation, duplicate detection, and safe write previews.</p>
                  </div>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
                    <div className="text-lg font-semibold text-white">Planned safeguards</div>
                    <ul className="mt-2 space-y-2 text-sm text-slate-400">
                      <li>Duplicate student ID detection before write</li>
                      <li>Class-label validation against managed classes</li>
                      <li>Preview diff for reassignment and new records</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-5 text-amber-100">
                    <div className="text-sm uppercase tracking-[0.18em] text-amber-200/80">Missing parent phone</div>
                    <div className="mt-2 text-3xl font-semibold text-white">{studentSummary.missingParentPhone}</div>
                  </div>
                  <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-5 text-rose-100">
                    <div className="text-sm uppercase tracking-[0.18em] text-rose-200/80">Missing class</div>
                    <div className="mt-2 text-3xl font-semibold text-white">{studentSummary.missingHomeroom}</div>
                  </div>
                  <div className="rounded-2xl border border-sky-500/20 bg-sky-500/10 p-5 text-sky-100">
                    <div className="text-sm uppercase tracking-[0.18em] text-sky-200/80">Managed classes</div>
                    <div className="mt-2 text-3xl font-semibold text-white">{classSummary.managedClasses}</div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <StudentModal open={!!studentModal} student={studentModal} classOptions={classOptions} saving={savingStudent} onClose={() => setStudentModal(null)} onSave={saveStudent} />
        <ClassModal open={classModal.open} mode={classModal.mode} item={classModal.item} saving={savingClass} onClose={() => setClassModal({ mode: 'create', item: null, open: false })} onSave={saveClass} />
      </V2Layout>
    </>
  );
}