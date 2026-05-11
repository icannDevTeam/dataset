import React, { useState, useCallback, useMemo } from 'react';

/**
 * components/v2/reports/OnboardingExportOverlay.js
 *
 * Modal export form for the onboarding forms module. POSTs to
 * /api/pickup/admin/onboarding-export and triggers a browser download.
 */

const SECTIONS = [
  { key: 'summary',    label: 'Summary KPIs',                 icon: 'ph-gauge' },
  { key: 'records',    label: 'Form records (flattened)',     icon: 'ph-list-bullets' },
  { key: 'chaperones', label: 'Chaperone roster (XLSX only)', icon: 'ph-identification-card', xlsxOnly: true },
  { key: 'audit',      label: 'Audit trail',                  icon: 'ph-shield-check' },
];

const FORMATS = [
  { id: 'xlsx', label: 'Excel (XLSX)', icon: 'ph-microsoft-excel-logo', desc: 'Multi-sheet, embedded photos' },
  { id: 'pdf',  label: 'PDF report',   icon: 'ph-file-pdf',             desc: 'Branded summary + tables' },
  { id: 'csv',  label: 'CSV',          icon: 'ph-file-csv',             desc: 'Sectioned plain text' },
];

const DEFAULT_SECTIONS = { summary: true, records: true, chaperones: false, audit: true };

export default function OnboardingExportOverlay({
  open, onClose,
  defaultFrom, defaultTo,
  defaultStatus = 'all', defaultGrade = '', defaultHomeroom = '', defaultStudentId = '',
}) {
  const [format, setFormat]       = useState('xlsx');
  const [from, setFrom]           = useState(defaultFrom || '');
  const [to, setTo]               = useState(defaultTo || '');
  const [status, setStatus]       = useState(defaultStatus);
  const [grade, setGrade]         = useState(defaultGrade);
  const [homeroom, setHomeroom]   = useState(defaultHomeroom);
  const [studentId, setStudentId] = useState(defaultStudentId);
  const [sections, setSections]   = useState(DEFAULT_SECTIONS);
  const [includePhotos, setIncludePhotos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  React.useEffect(() => {
    if (!open) return;
    setFrom(defaultFrom || ''); setTo(defaultTo || '');
    setStatus(defaultStatus); setGrade(defaultGrade);
    setHomeroom(defaultHomeroom); setStudentId(defaultStudentId);
    setErr(null); setBusy(false);
  }, [open, defaultFrom, defaultTo, defaultStatus, defaultGrade, defaultHomeroom, defaultStudentId]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const enabledSections = useMemo(() => {
    if (format === 'xlsx') return sections;
    return { ...sections, chaperones: false };
  }, [sections, format]);

  const toggleSection = (k) => setSections((s) => ({ ...s, [k]: !s[k] }));

  const submit = useCallback(async (overrideFormat) => {
    const fmt = overrideFormat || format;
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/pickup/admin/onboarding-export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: fmt,
          from: from || undefined,
          to:   to   || undefined,
          status,
          grade:     grade ? Number(grade) : undefined,
          homeroom:  homeroom.trim()  || undefined,
          studentId: studentId.trim() || undefined,
          sections: enabledSections,
          // For PDF + print, include photos when the chaperone section is on
          // (it's how chaperone face thumbnails get embedded into each form).
          includeChaperonePhotos:
            (fmt === 'xlsx' && includePhotos) ||
            (fmt === 'pdf' || fmt === 'print'),
        }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.message || j.error || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (fmt === 'print') {
        // Open in a new tab; the HTML auto-fires window.print() on load.
        const w = window.open(url, '_blank');
        if (!w) throw new Error('Pop-up blocked — allow pop-ups for this site, then retry.');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        onClose?.();
        return;
      }
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename="([^"]+)"/);
      const name = m ? m[1] : `onboarding-forms.${fmt}`;
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      onClose?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setBusy(false); }
  }, [format, from, to, status, grade, homeroom, studentId, enabledSections, includePhotos, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <i className="ph ph-export text-emerald-400"></i> Export onboarding forms
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Pick a format, narrow the records, and choose which sections to include.
            </p>
          </div>
          <button onClick={() => !busy && onClose?.()} disabled={busy}
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40">
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Format</div>
            <div className="grid grid-cols-3 gap-2">
              {FORMATS.map((f) => (
                <button key={f.id} onClick={() => setFormat(f.id)}
                  className={`text-left px-3 py-2.5 rounded-lg border transition-all ${
                    format === f.id
                      ? 'bg-emerald-500/15 border-emerald-500/60 text-white'
                      : 'bg-slate-800/40 border-slate-800 text-slate-300 hover:border-slate-700'
                  }`}>
                  <div className="flex items-center gap-2 font-semibold text-sm">
                    <i className={`ph ${f.icon}`}></i>{f.label}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{f.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Status">
              <select value={status} onChange={(e)=>setStatus(e.target.value)} className={inputCls}>
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </Field>
            <Field label="Submitted from"><input type="date" value={from} onChange={(e)=>setFrom(e.target.value)} className={inputCls}/></Field>
            <Field label="Submitted to"><input type="date" value={to} onChange={(e)=>setTo(e.target.value)} className={inputCls}/></Field>
            <Field label="Grade (optional)" hint="1–12">
              <input value={grade} onChange={(e)=>setGrade(e.target.value)} placeholder="all" className={inputCls}/>
            </Field>
            <Field label="Homeroom (optional)" hint="e.g. 4C">
              <input value={homeroom} onChange={(e)=>setHomeroom(e.target.value.toUpperCase())} placeholder="all" className={inputCls}/>
            </Field>
            <Field label="Student ID (optional)" hint="e.g. BIN12345">
              <input value={studentId} onChange={(e)=>setStudentId(e.target.value)} placeholder="any" className={inputCls}/>
            </Field>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 flex items-center justify-between">
              <span>Sections to include</span>
              <span className="flex gap-2">
                <button onClick={() => setSections(DEFAULT_SECTIONS)} className="text-[10px] text-emerald-300 hover:text-emerald-200">defaults</button>
                <button onClick={() => setSections(Object.fromEntries(SECTIONS.map(s => [s.key, true])))} className="text-[10px] text-slate-300 hover:text-white">all</button>
                <button onClick={() => setSections({})} className="text-[10px] text-slate-400 hover:text-white">none</button>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {SECTIONS.map((s) => {
                const disabled = s.xlsxOnly && format !== 'xlsx';
                const on = !!sections[s.key] && !disabled;
                return (
                  <label key={s.key}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                      disabled ? 'opacity-40 cursor-not-allowed bg-slate-900/40 border-slate-800' :
                      on ? 'bg-emerald-500/10 border-emerald-500/40 text-white' :
                           'bg-slate-800/40 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}>
                    <input type="checkbox" disabled={disabled} checked={on}
                      onChange={() => toggleSection(s.key)} className="accent-emerald-500"/>
                    <i className={`ph ${s.icon} text-sm`}></i>
                    <span className="flex-1">{s.label}</span>
                  </label>
                );
              })}
            </div>
            {format === 'xlsx' && sections.chaperones && (
              <label className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/30 text-xs text-violet-200 cursor-pointer">
                <input type="checkbox" checked={includePhotos}
                  onChange={(e)=>setIncludePhotos(e.target.checked)} className="accent-violet-500"/>
                <i className="ph ph-image-square"></i>
                Embed chaperone face thumbnails (slower; +~50 KB per photo)
              </label>
            )}
          </div>

          {err && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/40 text-rose-200 text-sm flex items-start gap-2">
              <i className="ph ph-warning-circle text-lg flex-shrink-0"></i>
              <div className="flex-1">{err}</div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2">
          <button onClick={() => !busy && onClose?.()} disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={() => submit('print')} disabled={busy}
            title="Open a printable letterhead view in a new tab"
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            <i className="ph ph-printer"></i>Print preview
          </button>
          <button onClick={() => submit()} disabled={busy}
            className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-semibold flex items-center gap-2 disabled:opacity-50 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
            {busy
              ? <><i className="ph ph-spinner-gap animate-spin"></i>Generating…</>
              : <><i className="ph ph-download-simple"></i>Generate {format.toUpperCase()}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = 'w-full px-2.5 py-1.5 rounded-md bg-slate-800/60 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-emerald-500';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-slate-500 mt-1">{hint}</div>}
    </label>
  );
}
