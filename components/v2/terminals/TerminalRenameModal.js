/**
 * TerminalRenameModal — rename a terminal without changing its stable ID.
 *
 * Strategy: PUT only the `name` field. The path-param `id` stays the same
 * (sha1(originalName)[:12]) so any release-group bindings — which reference
 * terminals by ID — keep pointing to the same record. The renamed name then
 * surfaces wherever the UI resolves IDs → names.
 */
import { useState, useEffect, useRef } from 'react';

export default function TerminalRenameModal({ open, terminal, onClose, onRenamed }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open || !terminal) return;
    setName(terminal.name || '');
    setErr(null);
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 50);
  }, [open, terminal]);

  if (!open || !terminal) return null;

  const submit = async () => {
    const next = name.trim();
    if (!next) { setErr('Name cannot be empty.'); return; }
    if (next === terminal.name) { onClose?.(); return; }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/pickup/admin/terminals?id=${encodeURIComponent(terminal.id)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Rename failed');
      onRenamed?.(j.terminal);
      onClose?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center">
            <i className="ph ph-pencil-simple text-brand-300 text-xl"></i>
          </div>
          <div className="flex-1">
            <h2 className="text-base font-bold text-white">Rename Terminal</h2>
            <p className="text-[11px] text-slate-400 mt-0.5 truncate">Currently: <span className="text-slate-200">{terminal.name}</span></p>
          </div>
          <button onClick={onClose} disabled={busy}
            className="text-slate-500 hover:text-white transition disabled:opacity-50">
            <i className="ph ph-x text-xl"></i>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <div className="p-2.5 rounded bg-amber-500/5 border border-amber-500/30 text-[11px] text-amber-200 flex items-start gap-2">
            <i className="ph ph-info text-amber-300 text-base flex-shrink-0 mt-0.5"></i>
            <div>
              Terminal ID stays as <code className="font-mono text-amber-100 bg-amber-500/10 px-1 rounded">{terminal.id}</code>{' '}
              so any release-group bindings remain intact. Only the display name changes.
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              New name <span className="text-rose-400">*</span>
            </label>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="e.g. PYP Lobby"
              className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>

          {err && (
            <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
              <i className="ph ph-warning-circle mr-1"></i>{err}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !name.trim() || name.trim() === terminal.name}
            className="px-4 py-1.5 text-xs rounded-md font-semibold bg-brand-500 hover:bg-brand-400 text-white border border-brand-400 disabled:opacity-50">
            {busy
              ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Renaming…</>
              : <><i className="ph ph-check mr-1"></i>Save name</>}
          </button>
        </div>
      </div>
    </div>
  );
}
