/**
 * TerminalAddModal — admin form to register a new Hikvision face terminal.
 * Mirrors styling of OnboardingExportOverlay for visual consistency.
 *
 * Posts to /api/pickup/admin/terminals which stamps a stable
 * sha1(name)[:12] terminalId server-side when none is supplied.
 */
import { useState, useEffect, useRef } from 'react';

const HHMM_RE = /^\d{2}:\d{2}$/;

export default function TerminalAddModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    ip: '',
    deviceName: '',
    gradeLabel: '',
    gateLabel: '',
    windowOpen: '',
    windowClose: '',
    enabled: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const firstInput = useRef(null);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: '', ip: '', deviceName: '', gradeLabel: '', gateLabel: '',
      windowOpen: '', windowClose: '', enabled: true,
    });
    setErr(null);
    setTimeout(() => firstInput.current?.focus(), 50);
  }, [open]);

  if (!open) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const name = form.name.trim();
    if (!name) { setErr('Name is required.'); return; }
    if (form.windowOpen && !HHMM_RE.test(form.windowOpen)) { setErr('Open time must be HH:MM.'); return; }
    if (form.windowClose && !HHMM_RE.test(form.windowClose)) { setErr('Close time must be HH:MM.'); return; }

    setBusy(true);
    setErr(null);
    try {
      const body = {
        name,
        ip: form.ip.trim() || undefined,
        deviceName: form.deviceName.trim() || undefined,
        gradeLabel: form.gradeLabel.trim() || undefined,
        gateLabel: form.gateLabel.trim() || undefined,
        windowOpen: form.windowOpen || undefined,
        windowClose: form.windowClose || undefined,
        enabled: form.enabled,
      };
      const r = await fetch('/api/pickup/admin/terminals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to create terminal');
      onCreated?.(j.terminal);
      onClose?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
            <i className="ph ph-cpu text-emerald-300 text-xl"></i>
          </div>
          <div className="flex-1">
            <h2 className="text-base font-bold text-white">Add Terminal</h2>
            <p className="text-[11px] text-slate-400 mt-0.5">Register a new Hikvision face terminal in this tenant.</p>
          </div>
          <button onClick={onClose} disabled={busy}
            className="text-slate-500 hover:text-white transition disabled:opacity-50">
            <i className="ph ph-x text-xl"></i>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <Field label="Name" required hint="e.g. PYP Lobby (used for the stable terminal ID)">
            <input
              ref={firstInput}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="PYP Lobby"
              className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="IP address" hint="optional">
              <input
                value={form.ip}
                onChange={(e) => set('ip', e.target.value)}
                placeholder="10.0.0.21"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
              />
            </Field>
            <Field label="Device name" hint="defaults to Name">
              <input
                value={form.deviceName}
                onChange={(e) => set('deviceName', e.target.value)}
                placeholder="DS-K1T341AMF"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Grade label" hint="e.g. PYP G3-G5">
              <input
                value={form.gradeLabel}
                onChange={(e) => set('gradeLabel', e.target.value)}
                placeholder="—"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
              />
            </Field>
            <Field label="Gate label" hint="e.g. PYP Lobby">
              <input
                value={form.gateLabel}
                onChange={(e) => set('gateLabel', e.target.value)}
                placeholder="—"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
              />
            </Field>
          </div>

          <Field label="Pickup window (WIB)" hint="leave blank for always-open">
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={form.windowOpen}
                onChange={(e) => set('windowOpen', e.target.value)}
                className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
              />
              <span className="text-slate-600 text-xs">→</span>
              <input
                type="time"
                value={form.windowClose}
                onChange={(e) => set('windowClose', e.target.value)}
                className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-slate-100 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
          </Field>

          <label className="flex items-center gap-2 mt-1 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
              className="rounded border-slate-700 bg-slate-950"
            />
            Enabled (serves feeds and kiosks immediately)
          </label>

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
          <button onClick={submit} disabled={busy || !form.name.trim()}
            className="px-4 py-1.5 text-xs rounded-md font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 border border-emerald-400 disabled:opacity-50">
            {busy
              ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Creating…</>
              : <><i className="ph ph-plus mr-1"></i>Create terminal</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
        {label}{required && <span className="text-rose-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <div className="text-[10px] text-slate-500 mt-0.5">{hint}</div>}
    </div>
  );
}
