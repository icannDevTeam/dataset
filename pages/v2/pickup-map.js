import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'enrolled', label: 'Enrolled' },
  { key: 'partial', label: 'Partial' },
  { key: 'needs-enroll', label: 'Needs enrol' },
  { key: 'no-photos', label: 'No photo' },
];

function clampText(text, max = 36) {
  if (!text) return '—';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function Pill({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${className}`}>
      {children}
    </span>
  );
}

function StudentChips({ students = [] }) {
  if (!students.length) return <span className="text-slate-400">No students</span>;
  const visible = students.slice(0, 3);
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((student) => (
        <span
          key={student.id || student.name || student.homeroom}
          className="text-[10px] bg-slate-800/90 border border-slate-700 rounded-full px-2 py-1 text-slate-200"
          title={[student.name, student.homeroom, student.grade].filter(Boolean).join(' · ')}
        >
          {student.name || student.id || '—'}
        </span>
      ))}
      {students.length > 3 && (
        <span className="text-[10px] bg-slate-900 border border-slate-700 rounded-full px-2 py-1 text-slate-400">
          +{students.length - 3} more
        </span>
      )}
    </div>
  );
}

function StatusBadge({ chaperone }) {
  const { allEnrolled, needsEnroll, photoCount, enrolledDeviceCount } = chaperone;
  if (!photoCount) {
    return <Pill className="bg-violet-500/10 text-violet-200 border border-violet-500/25">No photo</Pill>;
  }
  if (allEnrolled) {
    return <Pill className="bg-emerald-500/10 text-emerald-200 border border-emerald-500/25">Enrolled</Pill>;
  }
  if (enrolledDeviceCount > 0) {
    return <Pill className="bg-amber-500/10 text-amber-200 border border-amber-500/25">Partial</Pill>;
  }
  if (needsEnroll) {
    return <Pill className="bg-rose-500/10 text-rose-200 border border-rose-500/25">Not enrolled</Pill>;
  }
  return <Pill className="bg-slate-700/10 text-slate-200 border border-slate-600/25">Unknown</Pill>;
}

export default function PickupMapPage() {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [grade, setGrade] = useState('all');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/pickup/admin/enrollment-board', { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setBoard(data);
      })
      .catch((err) => setError(err.message || 'Could not load data'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chaperones = useMemo(() => {
    if (!board?.groups) return [];
    const unique = new Map();
    board.groups.forEach((group) => {
      (group.chaperones || []).forEach((c) => {
        if (c?.id && !unique.has(c.id)) unique.set(c.id, c);
      });
    });
    return [...unique.values()];
  }, [board]);

  const grades = useMemo(() => {
    const set = new Set();
    chaperones.forEach((c) => {
      (c.studentGrades || []).forEach((g) => { if (g) set.add(String(g)); });
    });
    return [...set].sort((a, b) => {
      const ai = parseInt(a, 10);
      const bi = parseInt(b, 10);
      if (!Number.isNaN(ai) && !Number.isNaN(bi)) return ai - bi;
      return String(a).localeCompare(String(b));
    });
  }, [chaperones]);

  const filteredChaperones = useMemo(() => {
    const query = search.trim().toLowerCase();
    return chaperones.filter((c) => {
      if (status === 'enrolled' && !c.allEnrolled) return false;
      if (status === 'partial' && (c.allEnrolled || c.enrolledDeviceCount === 0)) return false;
      if (status === 'needs-enroll' && !c.needsEnroll) return false;
      if (status === 'no-photos' && !c.noPhotos) return false;
      if (grade !== 'all' && !(c.studentGrades || []).includes(grade)) return false;
      if (!query) return true;
      const haystack = [
        c.name,
        c.employeeNo,
        c.relation,
        c.phone,
        c.email,
        ...(c.authorizedStudents || []).map((s) => `${s.name} ${s.homeroom} ${s.grade}`),
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [chaperones, grade, search, status]);

  const count = filteredChaperones.length;
  const total = chaperones.length;

  return (
    <V2Layout>
      <Head>
        <title>Pickup Chaperone Map · BINUS Pickup System</title>
      </Head>

      <div className="space-y-6">
        <div className="rounded-3xl border border-slate-800/80 bg-slate-950/90 p-6 shadow-xl shadow-slate-950/20">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-300">Pickup Mapping</p>
              <h1 className="mt-3 text-3xl font-semibold text-white">Chaperone ↔ Student Mapping</h1>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                See approved chaperones alongside the students they are authorized for, plus enrollment status at a glance.
                Use the filters to narrow by status, grade, or student name.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-800/80 bg-slate-900/80 p-4 text-sm text-slate-200">
                <div className="text-slate-400 text-xs uppercase tracking-[0.24em]">Chaperones</div>
                <div className="mt-2 text-2xl font-semibold text-white">{total}</div>
                <div className="text-slate-500 text-xs">loaded from current pickup roster</div>
              </div>
              <div className="rounded-2xl border border-slate-800/80 bg-slate-900/80 p-4 text-sm text-slate-200">
                <div className="text-slate-400 text-xs uppercase tracking-[0.24em]">Visible rows</div>
                <div className="mt-2 text-2xl font-semibold text-white">{count}</div>
                <div className="text-slate-500 text-xs">matches current filter</div>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-800/80 bg-slate-950/90 p-5 shadow-xl shadow-slate-950/10">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto_auto] items-end">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <div className="text-xs uppercase tracking-[0.24em] text-slate-500 mb-2">Search</div>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search chaperone, student, homeroom..."
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-brand-400"
                />
              </label>
              <label className="block">
                <div className="text-xs uppercase tracking-[0.24em] text-slate-500 mb-2">Status</div>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3 text-sm text-slate-100 outline-none"
                >
                  {STATUS_FILTERS.map((item) => (
                    <option key={item.key} value={item.key}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <div className="text-xs uppercase tracking-[0.24em] text-slate-500 mb-2">Grade</div>
                <select
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3 text-sm text-slate-100 outline-none"
                >
                  <option value="all">All grades</option>
                  {grades.map((gradeValue) => (
                    <option key={gradeValue} value={gradeValue}>Grade {gradeValue}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-3 justify-end">
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3 text-sm font-medium text-slate-200 hover:bg-slate-800"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-left">
              <thead>
                <tr className="text-xs uppercase tracking-[0.24em] text-slate-500">
                  <th className="pb-3 pr-4 font-normal">Chaperone</th>
                  <th className="pb-3 pr-4 font-normal">Enrollment</th>
                  <th className="pb-3 pr-4 font-normal">Authorized students</th>
                  <th className="pb-3 pr-4 font-normal">Student grades</th>
                  <th className="pb-3 font-normal">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan="5" className="py-10 text-center text-slate-400">
                      Loading chaperone/student mapping...
                    </td>
                  </tr>
                )}
                {!loading && error && (
                  <tr>
                    <td colSpan="5" className="py-10 text-center text-rose-300">
                      {error}
                    </td>
                  </tr>
                )}
                {!loading && !error && filteredChaperones.length === 0 && (
                  <tr>
                    <td colSpan="5" className="py-10 text-center text-slate-500">
                      No chaperones match the current filter.
                    </td>
                  </tr>
                )}
                {!loading && !error && filteredChaperones.map((chaperone) => (
                  <tr key={chaperone.id} className="border-t border-slate-800/80">
                    <td className="py-4 pr-4 align-top">
                      <div className="text-sm font-semibold text-white">{chaperone.name}</div>
                      <div className="mt-1 text-xs text-slate-400">{clampText(chaperone.relation || chaperone.relationship || 'Unknown relation')}</div>
                      <div className="mt-1 text-[11px] text-slate-500">{chaperone.employeeNo || '—'}</div>
                    </td>
                    <td className="py-4 pr-4 align-top space-y-2">
                      <StatusBadge chaperone={chaperone} />
                      <div className="text-[11px] text-slate-500">
                        {chaperone.photoCount === 0
                          ? 'Needs photo upload before enrolment'
                          : chaperone.allEnrolled
                            ? 'All matched devices enrolled'
                            : chaperone.enrolledDeviceCount > 0
                              ? 'Some terminals enrolled'
                              : 'Ready to enrol'}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {chaperone.studentClasses?.length ? `${chaperone.studentClasses.length} class${chaperone.studentClasses.length === 1 ? '' : 'es'}` : 'No class data'}
                      </div>
                    </td>
                    <td className="py-4 pr-4 align-top max-w-[340px]">
                      <StudentChips students={chaperone.authorizedStudents || []} />
                    </td>
                    <td className="py-4 pr-4 align-top">
                      <div className="text-sm text-slate-200">{(chaperone.studentGrades || []).join(', ') || '—'}</div>
                    </td>
                    <td className="py-4 align-top text-sm text-slate-400">
                      {chaperone.lastSeenAt || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </V2Layout>
  );
}
