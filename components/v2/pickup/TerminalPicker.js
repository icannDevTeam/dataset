/**
 * TerminalPicker
 *
 * Per-chaperone terminal selector. Replaces the read-only device chip strip
 * on the chaperone card with a multi-select that:
 *   - Lists every configured Hikvision terminal (board.devices)
 *   - Pre-selects grade-matching ones (chaperone.enrollment.allDevices.isMatched)
 *   - Allows the operator to override (pick any terminal regardless of grade)
 *   - Hides terminals that are not configured (i.e., not in board.devices)
 *
 * Compact summary chip mode (default) opens a popover with checkboxes.
 */
import { useEffect, useRef, useState } from 'react';

const STATUS_PILL = (d) => {
  if (d.ok)        return { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', icon: 'ph-check' };
  if (d.attempted) return { cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30', icon: 'ph-x' };
  return { cls: 'bg-slate-800/50 text-slate-400 border-slate-700', icon: 'ph-circle-dashed' };
};

export default function TerminalPicker({
  allDevices = [],
  selectedIps,         // controlled; null/undefined → defaults from isMatched (or defaultIps)
  defaultIps,          // optional override for defaults; class-level picker passes grade-matched IPs
  onChange,            // (ips: string[]) => void
  align = 'right',     // 'right' | 'left' — popover horizontal anchor
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef(null);

  const formatGradeScope = (d) => {
    const scopes = Array.isArray(d?.gradeScopes) ? d.gradeScopes.map(String).map((s) => s.trim()).filter(Boolean) : [];
    if (scopes.length === 0) return 'all grades';
    if (scopes.length === 1) return `grade ${scopes[0]}`;
    return `grades ${scopes.join(', ')}`;
  };

  // Compute defaults: caller override wins, otherwise grade-matched only.
  const defaults = Array.isArray(defaultIps)
    ? defaultIps
    : (allDevices.some((d) => d.isMatched)
        ? allDevices.filter((d) => d.isMatched).map((d) => d.ip)
        : []);
  const effective = selectedIps !== undefined && selectedIps !== null ? selectedIps : defaults;
  const selectedSet = new Set(effective);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClickAway);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickAway);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (ip) => {
    const next = new Set(selectedSet);
    if (next.has(ip)) next.delete(ip); else next.add(ip);
    onChange([...next]);
  };

  const setNone = () => onChange([]);
  const setDefaults = () => onChange(defaults);

  const selectedCount = effective.length;
  const isOverridden = selectedIps !== undefined && selectedIps !== null
    && (defaults.length !== effective.length
        || defaults.some((ip) => !selectedSet.has(ip))
        || effective.some((ip) => !defaults.includes(ip)));

  if (allDevices.length === 0) {
    return (
      <a
        href="/v2/terminals"
        className="text-[10px] inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20"
      >
        <i className="ph ph-warning" />No terminals configured · Configure →
      </a>
    );
  }

  return (
    <div className="relative" ref={popRef}>
      {/* Compact summary chips (always-visible row) */}
      <div className="flex flex-wrap gap-1 items-center">
        {allDevices
          .filter((d) => selectedSet.has(d.ip))
          .map((d) => {
            const pill = STATUS_PILL(d);
            return (
              <span
                key={d.ip}
                title={d.error || `${d.name} · ${d.ip}${d.isMatched ? '' : ' · grade override'}`}
                className={`text-[10px] px-1.5 py-0.5 rounded border font-mono inline-flex items-center gap-1 ${pill.cls}`}
              >
                <i className={`ph ${pill.icon}`} />
                {d.name.replace(/\s*\(.*\)\s*$/, '')}
                {!d.isMatched && <i className="ph ph-pencil-simple text-[9px] opacity-70" title="Out-of-grade override" />}
              </span>
            );
          })}
        {selectedCount === 0 && (
          <span className="text-[10px] text-slate-500 italic">No terminals selected</span>
        )}
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          className={`text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-medium ${
            isOverridden
              ? 'bg-violet-500/15 border-violet-500/40 text-violet-200'
              : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <i className="ph ph-list-checks" />
          {selectedCount}/{allDevices.length}
          <i className={`ph ph-caret-down transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Popover */}
      {open && (
        <div
          className={`absolute z-30 ${align === 'left' ? 'left-0' : 'right-0'} top-full mt-1.5 w-72 rounded-xl bg-slate-950 border border-slate-700 shadow-2xl shadow-black/50 overflow-hidden`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-200">Choose terminals</div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={setDefaults}
                className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 border border-slate-700 text-slate-300 hover:bg-slate-800"
                title="Reset to grade-matching terminals"
              >
                Defaults
              </button>
              <button
                type="button"
                onClick={setNone}
                className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 border border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                None
              </button>
            </div>
          </div>
          <ul className="max-h-72 overflow-auto py-1">
            {allDevices.map((d) => {
              const checked = selectedSet.has(d.ip);
              const pill = STATUS_PILL(d);
              return (
                <li key={d.ip}>
                  <label className={`flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-slate-900 ${
                    checked ? 'bg-slate-900/60' : ''
                  }`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(d.ip)}
                      className="mt-1 w-3.5 h-3.5 rounded accent-brand-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] text-white font-medium truncate flex items-center gap-1.5">
                        {d.name}
                        {d.isMatched ? (
                          <span className="text-[8px] uppercase tracking-wider px-1 py-0 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">match</span>
                        ) : (
                          <span className="text-[8px] uppercase tracking-wider px-1 py-0 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">override</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                        <span className="px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-200 border border-brand-500/20">
                          {formatGradeScope(d)}
                        </span>
                        {d.section && <span>{d.section}</span>}
                        <span className="font-mono">{d.ip}</span>
                      </div>
                      {d.attempted && (
                        <div className={`mt-1 text-[10px] inline-flex items-center gap-1 px-1 py-0 rounded border ${pill.cls}`}>
                          <i className={`ph ${pill.icon}`} />
                          {d.ok ? 'Last enrol succeeded' : `Last failed: ${(d.error || 'unknown').slice(0, 40)}`}
                        </div>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="px-3 py-2 border-t border-slate-800 text-[10px] text-slate-500">
            Tip: defaults match the chaperone's authorised grades only. Add extra terminals only when a sibling needs them.
          </div>
        </div>
      )}
    </div>
  );
}
