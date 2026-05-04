/**
 * <KioskManager /> — embedded inside /v2/pickup-admin (TV Kiosks view).
 *
 * Polls /api/pickup/admin/kiosk-status every 10s for live counts, lets the
 * admin create/edit/delete profiles via /api/pickup/admin/kiosk-profiles, and
 * provides "Open TV" + "Copy URL" buttons that use the real PICKUP_TV_TOKEN.
 *
 * Uses an injected showToast(kind, msg) so the host page owns notifications.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';

const COMMON_HOMEROOMS = [
  'EYA','EYB','EYC','KGA','KGB',
  '1A','1B','1C','2A','2B','2C','3A','3B','3C',
  '4A','4B','4C','5A','5B','5C','6A','6B','6C',
  '7A','7B','7C','8A','8B','8C','9A','9B','9C',
  '10A','10B','11A','11B','12A','12B',
];

const ACCENT_PRESETS = [
  { value: '#8B1538', label: 'Maroon' },
  { value: '#5D0E27', label: 'Deep Maroon' },
  { value: '#FCBF11', label: 'Gold' },
  { value: '#0EA5E9', label: 'Sky' },
  { value: '#10B981', label: 'Emerald' },
  { value: '#7C3AED', label: 'Violet' },
];

const EMPTY = {
  id: '', name: '', kioskCode: '', gates: [], homerooms: [],
  showQueue: true, maxCards: 5, beepEnabled: true, accent: '#8B1538',
  windowOpen: '', windowClose: '', suppressOutOfWindow: true,
};

function timeAgo(iso) {
  if (!iso) return null;
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function ChipInput({ value, onChange, suggestions, placeholder }) {
  const [draft, setDraft] = useState('');
  const list = Array.isArray(value) ? value : [];
  const sugs = (suggestions || []).filter((s) => !list.includes(s) && s.toLowerCase().includes(draft.toLowerCase()));
  const add = (v) => {
    const t = String(v).trim();
    if (!t) return;
    if (list.includes(t)) return;
    onChange([...list, t]);
    setDraft('');
  };
  const remove = (v) => onChange(list.filter((x) => x !== v));
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
        {list.length === 0 && <div className="text-xs text-slate-500 italic">none — matches all</div>}
        {list.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 bg-amber-500/20 text-amber-200 border border-amber-500/40 rounded-md px-2 py-0.5 text-xs font-semibold">
            {v}
            <button type="button" onClick={() => remove(v)} className="hover:text-amber-100"><i className="ph ph-x text-[10px]"></i></button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); }
            else if (e.key === 'Backspace' && !draft && list.length) remove(list[list.length - 1]);
          }}
          placeholder={placeholder}
          className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
        />
        {draft && sugs.length > 0 && (
          <div className="absolute z-10 mt-1 left-0 right-0 bg-slate-900 border border-slate-700 rounded-md max-h-48 overflow-auto shadow-xl">
            {sugs.slice(0, 12).map((s) => (
              <button key={s} type="button" onClick={() => add(s)}
                className="block w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-amber-500/15">
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function KioskManager({ showToast }) {
  const toast = showToast || (() => {});
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [gateOptions, setGateOptions] = useState([]);
  const [token, setToken] = useState('');
  const [origin, setOrigin] = useState('');
  const [totalLive, setTotalLive] = useState(0);
  const [tick, setTick] = useState(0);

  // ─── Paired TVs (per-device tokens) ─────────────────────────────────
  const [devices, setDevices] = useState([]);
  const [pairing, setPairing] = useState(null);   // { pairingCode, profileId, deviceLabel } when modal open
  const [pairBusy, setPairBusy] = useState(false);

  const reloadDevices = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/tv-devices', { credentials: 'include' });
      const j = await r.json();
      if (r.ok) setDevices(j.devices || []);
    } catch {}
  }, []);

  const openPair = () => setPairing({ pairingCode: '', profileId: profiles[0]?.id || '', deviceLabel: '' });
  const closePair = () => setPairing(null);

  const submitPair = async () => {
    if (!pairing?.pairingCode || !pairing?.profileId) { toast('error', 'Pairing code and profile required'); return; }
    setPairBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/tv-devices?action=claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(pairing),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'claim failed');
      toast('ok', `Paired TV → ${j.profileName}`);
      setPairing(null);
      reloadDevices();
    } catch (e) { toast('error', e.message); }
    finally { setPairBusy(false); }
  };

  const reassignDevice = async (dev, profileId) => {
    try {
      const r = await fetch(`/api/pickup/admin/tv-devices?id=${encodeURIComponent(dev.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ profileId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'update failed');
      toast('ok', `Reassigned "${dev.deviceLabel}"`);
      reloadDevices();
    } catch (e) { toast('error', e.message); }
  };

  const renameDevice = async (dev) => {
    const next = prompt('Rename TV', dev.deviceLabel);
    if (!next || next === dev.deviceLabel) return;
    try {
      const r = await fetch(`/api/pickup/admin/tv-devices?id=${encodeURIComponent(dev.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ deviceLabel: next }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'rename failed');
      toast('ok', `Renamed → "${next}"`);
      reloadDevices();
    } catch (e) { toast('error', e.message); }
  };

  const revokeDevice = async (dev) => {
    if (!confirm(`Unpair "${dev.deviceLabel}"? It will return to the pairing screen on next refresh.`)) return;
    try {
      const r = await fetch(`/api/pickup/admin/tv-devices?id=${encodeURIComponent(dev.id)}&hard=1`, {
        method: 'DELETE', credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'revoke failed');
      toast('ok', `Unpaired "${dev.deviceLabel}"`);
      reloadDevices();
    } catch (e) { toast('error', e.message); }
  };

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/pickup/admin/kiosk-status', { credentials: 'include' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'fetch failed');
      setProfiles(j.profiles || []);
      setGateOptions(j.gateOptions || []);
      setToken(j.token || '');
      setOrigin(j.origin || (typeof window !== 'undefined' ? window.location.origin : ''));
      setTotalLive(j.totalLive || 0);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); reloadDevices(); }, [reload, reloadDevices]);
  useEffect(() => {
    const t1 = setInterval(() => { reload(); reloadDevices(); }, 10000);
    const t2 = setInterval(() => setTick((x) => x + 1), 5000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [reload, reloadDevices]);

  const startCreate = () => setEditing({ ...EMPTY });
  const startEdit = (p) => setEditing({ ...EMPTY, ...p });
  const cancel = () => setEditing(null);

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { toast('error', 'Name is required'); return; }
    setSaving(true);
    try {
      const isNew = !profiles.find((x) => x.id === editing.id);
      const url = isNew
        ? '/api/pickup/admin/kiosk-profiles'
        : `/api/pickup/admin/kiosk-profiles?id=${encodeURIComponent(editing.id)}`;
      const r = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(editing),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || 'save failed');
      toast('ok', isNew ? `Created "${j.profile.name}"` : `Updated "${j.profile.name}"`);
      setEditing(null);
      await reload();
    } catch (e) { toast('error', e.message); }
    finally { setSaving(false); }
  };

  const remove = async (p) => {
    if (!confirm(`Delete kiosk profile "${p.name}"? Any TVs using it will fall back to the unfiltered feed.`)) return;
    try {
      const r = await fetch(`/api/pickup/admin/kiosk-profiles?id=${encodeURIComponent(p.id)}`, {
        method: 'DELETE', credentials: 'include',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'delete failed');
      toast('ok', `Deleted "${p.name}"`);
      await reload();
    } catch (e) { toast('error', e.message); }
  };

  const liveUrl = (p) => token ? `${origin}/pickup/tv?token=${token}&profile=${encodeURIComponent(p.id)}` : '';
  const templateUrl = (p) => `${origin || 'https://your-host'}/pickup/tv?token=<PICKUP_TV_TOKEN>&profile=${encodeURIComponent(p.id)}`;

  const copyUrl = async (p) => {
    const url = liveUrl(p) || templateUrl(p);
    try {
      await navigator.clipboard.writeText(url);
      toast('ok', token ? 'Live kiosk URL copied to clipboard' : 'URL template copied (PICKUP_TV_TOKEN missing)');
    } catch { toast('error', 'Could not access clipboard'); }
  };

  const openTv = (p) => {
    const url = liveUrl(p);
    if (!url) { toast('error', 'PICKUP_TV_TOKEN not configured on the server'); return; }
    window.open(url, '_blank', 'noopener');
  };

  const grouped = useMemo(() => {
    const g = new Map();
    profiles.forEach((p) => {
      const key = p.gates[0] || '— Any gate —';
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(p);
    });
    return [...g.entries()];
  }, [profiles]);

  return (
    <div>
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <i className="ph ph-television-simple text-amber-400"></i> TV Kiosks
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            One profile = one screen. Each profile gets a short kiosk code that any TV can type at <code className="text-amber-300">/pickup/tv</code> to claim it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { reload(); reloadDevices(); }}
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <i className="ph ph-arrows-clockwise"></i> Refresh
          </button>
          <button onClick={openPair}
            className="bg-slate-800 hover:bg-slate-700 border border-amber-500/40 text-amber-300 text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5">
            <i className="ph ph-link"></i> Pair a TV
          </button>
          <button onClick={startCreate}
            className="bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold text-sm px-3.5 py-1.5 rounded-lg flex items-center gap-1.5 shadow-lg shadow-amber-500/20">
            <i className="ph ph-plus-circle"></i> New kiosk
          </button>
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <MiniStat label="Profiles" value={profiles.length} icon="ph-television-simple" tone="slate" />
        <MiniStat label="Paired TVs" value={devices.filter((d) => d.status === 'paired').length} icon="ph-broadcast" tone="emerald" />
        <MiniStat label="Live events (30 min)" value={totalLive} icon="ph-pulse" tone="amber" />
        <MiniStat label="Distinct gates" value={gateOptions.length} icon="ph-map-pin" tone="slate" />
      </div>

      {/* Paired TVs panel */}
      <PairedTvPanel
        devices={devices}
        profiles={profiles}
        onPair={openPair}
        onReassign={reassignDevice}
        onRename={renameDevice}
        onRevoke={revokeDevice}
        tickKey={tick}
      />

      {loading ? (
        <div className="text-slate-500 py-12 text-center"><i className="ph ph-spinner animate-spin mr-1"></i> Loading…</div>
      ) : err ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-4 text-red-200 text-sm">⚠ {err}</div>
      ) : profiles.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-slate-700 p-12 text-center">
          <i className="ph ph-television-simple text-6xl text-slate-600"></i>
          <div className="mt-3 text-slate-300 font-semibold">No kiosk profiles yet</div>
          <div className="text-sm text-slate-500 mt-1">Create one profile per TV screen.</div>
          <button onClick={startCreate} className="mt-5 bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold px-4 py-2 rounded-lg">
            Create your first kiosk →
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([gate, list]) => (
            <div key={gate}>
              <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-widest text-slate-500 font-semibold">
                <i className="ph ph-map-pin text-amber-400"></i> {gate}
                <span className="text-slate-600 normal-case font-normal tracking-normal">· {list.length} {list.length === 1 ? 'screen' : 'screens'}</span>
              </div>
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                {list.map((p) => (
                  <KioskCard key={p.id} profile={p}
                    onEdit={() => startEdit(p)}
                    onDelete={() => remove(p)}
                    onCopy={() => copyUrl(p)}
                    onOpen={() => openTv(p)}
                    hasToken={!!token}
                    tickKey={tick} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto" onClick={cancel}>
          <div className="bg-slate-950 border border-slate-700 rounded-2xl shadow-2xl max-w-2xl w-full p-6 my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">
                {profiles.find((x) => x.id === editing.id) ? 'Edit kiosk profile' : 'New kiosk profile'}
              </h2>
              <button onClick={cancel} className="text-slate-400 hover:text-white"><i className="ph ph-x text-xl"></i></button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">Display name</label>
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="e.g. PYP Lobby · Grade 1"
                    className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    Kiosk code <span className="text-slate-500 font-normal">(2–6 chars)</span>
                  </label>
                  <input
                    value={editing.kioskCode || ''}
                    onChange={(e) => setEditing({ ...editing, kioskCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) })}
                    placeholder="PYP1"
                    maxLength={6}
                    className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-base font-mono uppercase tracking-widest text-amber-300 focus:border-amber-500 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">Type this on any TV at <code>/pickup/tv</code></p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Gates <span className="text-slate-500 font-normal">(empty = all gates)</span>
                </label>
                <ChipInput
                  value={editing.gates}
                  onChange={(v) => setEditing({ ...editing, gates: v })}
                  suggestions={gateOptions}
                  placeholder="Type a gate name and press Enter"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Homerooms <span className="text-slate-500 font-normal">(empty = all)</span>
                </label>
                <ChipInput
                  value={editing.homerooms}
                  onChange={(v) => setEditing({ ...editing, homerooms: v })}
                  suggestions={COMMON_HOMEROOMS}
                  placeholder="e.g. 1A, 1B, 1C"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">Max cards (1–8)</label>
                  <input type="number" min="1" max="8" value={editing.maxCards}
                    onChange={(e) => setEditing({ ...editing, maxCards: parseInt(e.target.value, 10) || 5 })}
                    className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100" />
                </div>
                <div className="flex items-center pt-6">
                  <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                    <input type="checkbox" checked={editing.showQueue}
                      onChange={(e) => setEditing({ ...editing, showQueue: e.target.checked })}
                      className="accent-amber-500" />
                    Show queue
                  </label>
                </div>
                <div className="flex items-center pt-6">
                  <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                    <input type="checkbox" checked={editing.beepEnabled}
                      onChange={(e) => setEditing({ ...editing, beepEnabled: e.target.checked })}
                      className="accent-amber-500" />
                    Beep on new event
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Accent color</label>
                <div className="flex flex-wrap items-center gap-2">
                  {ACCENT_PRESETS.map((a) => (
                    <button key={a.value} type="button" title={a.label}
                      onClick={() => setEditing({ ...editing, accent: a.value })}
                      className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${editing.accent === a.value ? 'border-white scale-110' : 'border-slate-700'}`}
                      style={{ background: a.value }} />
                  ))}
                  <input type="color" value={editing.accent}
                    onChange={(e) => setEditing({ ...editing, accent: e.target.value })}
                    className="h-7 w-9 bg-slate-900 border border-slate-700 rounded cursor-pointer" />
                  <code className="text-xs text-slate-400">{editing.accent}</code>
                </div>
              </div>

              {/* Gate hours — suppress events outside window */}
              <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <i className="ph ph-clock-clockwise text-amber-400"></i>
                    <span className="text-sm font-semibold text-amber-200">Gate hours</span>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">Asia/Jakarta</span>
                </div>
                <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                  Hide pickup events recorded outside this window. Useful for blocking early-arrival false alerts when the Hikvision device keeps firing.
                  Leave both blank to allow events all day.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">Opens at</label>
                    <input
                      type="time"
                      value={editing.windowOpen || ''}
                      onChange={(e) => setEditing({ ...editing, windowOpen: e.target.value })}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">Closes at</label>
                    <input
                      type="time"
                      value={editing.windowClose || ''}
                      onChange={(e) => setEditing({ ...editing, windowClose: e.target.value })}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editing.suppressOutOfWindow !== false}
                    onChange={(e) => setEditing({ ...editing, suppressOutOfWindow: e.target.checked })}
                    className="accent-amber-500"
                  />
                  <span>Suppress events outside window <span className="text-slate-500">(recommended)</span></span>
                </label>
                {editing.windowOpen && editing.windowClose && (
                  <div className="mt-2 text-[11px] text-amber-300/80">
                    • Gate window: <b>{editing.windowOpen}</b> → <b>{editing.windowClose}</b>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button onClick={cancel} className="px-4 py-2 text-sm text-slate-300 hover:text-white">Cancel</button>
              <button onClick={save} disabled={saving}
                className="bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-900 font-semibold px-4 py-2 rounded-lg flex items-center gap-2">
                {saving ? <><i className="ph ph-spinner animate-spin"></i> Saving…</> : <><i className="ph ph-check"></i> Save profile</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pair-claim modal */}
      {pairing && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={closePair}>
          <div className="bg-slate-950 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <i className="ph ph-link text-amber-400"></i> Pair a TV
              </h2>
              <button onClick={closePair} className="text-slate-400 hover:text-white"><i className="ph ph-x text-xl"></i></button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              On the TV, open <code className="text-amber-300">/pickup/tv</code> and click <b>Pair this TV</b>. It will display a 6-character code — type it below.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Pairing code (from the TV)</label>
                <input
                  value={pairing.pairingCode}
                  onChange={(e) => setPairing({ ...pairing, pairingCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) })}
                  placeholder="ABCDEF"
                  maxLength={6}
                  className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-3 text-2xl font-mono tracking-widest text-amber-300 text-center uppercase focus:border-amber-500 focus:outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Assign to kiosk profile</label>
                <select
                  value={pairing.profileId}
                  onChange={(e) => setPairing({ ...pairing, profileId: e.target.value })}
                  className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  {profiles.length === 0 && <option value="">— no profiles yet —</option>}
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Nickname <span className="text-slate-500 font-normal">(optional)</span></label>
                <input
                  value={pairing.deviceLabel}
                  onChange={(e) => setPairing({ ...pairing, deviceLabel: e.target.value })}
                  placeholder="e.g. PYP Lobby TV 1"
                  className="w-full bg-slate-900/60 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={closePair} className="px-4 py-2 text-sm text-slate-300 hover:text-white">Cancel</button>
              <button onClick={submitPair} disabled={pairBusy || !pairing.pairingCode || !pairing.profileId}
                className="bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-900 font-semibold px-4 py-2 rounded-lg flex items-center gap-2">
                {pairBusy ? <><i className="ph ph-spinner animate-spin"></i> Pairing…</> : <><i className="ph ph-link"></i> Claim & assign</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, icon, tone }) {
  const toneCls = {
    amber: 'text-amber-400',
    emerald: 'text-emerald-300',
    slate: 'text-white',
  }[tone] || 'text-white';
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
        <i className={`ph ${icon}`}></i> {label}
      </div>
      <div className={`text-xl font-bold mt-1 ${toneCls}`}>{value}</div>
    </div>
  );
}

function KioskCard({ profile: p, onEdit, onDelete, onCopy, onOpen, hasToken, tickKey }) {
  const live = p.liveCount || 0;
  const lastAgo = useMemo(() => timeAgo(p.lastEventAt), [p.lastEventAt, tickKey]);
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 hover:border-amber-500/40 transition-colors overflow-hidden">
      <div className="h-1.5" style={{ background: p.accent || '#8B1538' }}></div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold text-white truncate flex items-center gap-2">
              {p.name}
              {live > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 rounded-full px-2 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  LIVE
                </span>
              )}
            </div>
            <code className="text-[10px] text-slate-500 font-mono">{p.id}</code>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onEdit} title="Edit"
              className="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded">
              <i className="ph ph-pencil-simple"></i>
            </button>
            <button onClick={onDelete} title="Delete"
              className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded">
              <i className="ph ph-trash"></i>
            </button>
          </div>
        </div>

        {/* Big kiosk code — what the user types on the TV */}
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-center">
          <div className="text-[10px] uppercase tracking-widest text-amber-400/70">Type at /pickup/tv</div>
          {p.kioskCode ? (
            <div className="text-3xl font-black font-mono tracking-[0.25em] text-amber-300 mt-1">{p.kioskCode}</div>
          ) : (
            <div className="text-xs text-slate-500 mt-1 italic">no code set — edit profile to assign one</div>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-slate-950/60 border border-slate-800 p-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Live events</div>
            <div className="text-lg font-bold text-amber-300 mt-0.5">{live}</div>
            {lastAgo && <div className="text-[10px] text-slate-500 mt-0.5">last {lastAgo}</div>}
          </div>
          <div className="rounded-md bg-slate-950/60 border border-slate-800 p-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Layout</div>
            <div className="text-xs text-slate-200 mt-0.5">{p.maxCards} cards</div>
            <div className="text-[10px] text-slate-500">queue {p.showQueue ? 'on' : 'off'} · beep {p.beepEnabled ? 'on' : 'off'}</div>
          </div>
        </div>

        <div className="mt-3 space-y-1 text-xs">
          <div className="text-slate-500">Gates</div>
          <div className="flex flex-wrap gap-1">
            {p.gates.length === 0
              ? <span className="text-[11px] italic text-slate-500">all gates</span>
              : p.gates.map((g) => <span key={g} className="bg-slate-800 text-slate-300 rounded px-1.5 py-0.5 text-[11px]">{g}</span>)}
          </div>
          <div className="text-slate-500 mt-1">Homerooms</div>
          <div className="text-amber-300 font-mono text-[11px]">
            {p.homerooms.length === 0 ? <span className="italic text-slate-500">all</span> : p.homerooms.join(' · ')}
          </div>
          <div className="text-slate-500 mt-1.5 flex items-center gap-1">
            <i className="ph ph-clock-clockwise"></i> Gate hours
          </div>
          <div className="text-[11px]">
            {p.windowOpen && p.windowClose ? (
              <span className="text-emerald-300 font-mono">
                {p.windowOpen} → {p.windowClose}
                {p.suppressOutOfWindow === false && (
                  <span className="ml-1 text-slate-500">(events not suppressed)</span>
                )}
              </span>
            ) : (
              <span className="italic text-slate-500">always open</span>
            )}
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-slate-800 flex items-center gap-2">
          <button onClick={onOpen}
            title="Preview this kiosk on this device (uses legacy token)"
            className="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold px-3 py-2 rounded-lg flex items-center justify-center gap-1.5">
            <i className="ph ph-arrow-square-out"></i> Preview
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Paired-TVs panel — shows every device that has been paired (or is mid-pairing).
 * Each row has Reassign / Rename / Unpair controls.
 */
function PairedTvPanel({ devices, profiles, onPair, onReassign, onRename, onRevoke, tickKey }) {
  const profileById = useMemo(() => {
    const m = new Map();
    profiles.forEach((p) => m.set(p.id, p));
    return m;
  }, [profiles]);

  const paired = devices.filter((d) => d.status === 'paired');
  const pending = devices.filter((d) => d.status === 'pending');

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <i className="ph ph-broadcast text-emerald-400"></i> Paired TVs
            <span className="text-xs text-slate-500 font-normal">{paired.length} active{pending.length > 0 ? ` · ${pending.length} waiting to pair` : ''}</span>
          </h3>
        </div>
        <button onClick={onPair}
          className="text-xs bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5">
          <i className="ph ph-link"></i> Pair a TV
        </button>
      </div>

      {pending.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-xs text-amber-200 mb-2 font-semibold uppercase tracking-wider">Awaiting pairing</div>
          <div className="space-y-1">
            {pending.map((d) => (
              <div key={d.id} className="flex items-center gap-3 text-xs">
                <div className="font-mono text-base text-amber-300 tracking-widest">
                  {(d.pairingCode || '').slice(0, 3)}-{(d.pairingCode || '').slice(3)}
                </div>
                <div className="text-slate-400 flex-1 truncate">{d.userAgent || d.id}</div>
                <span className="text-[10px] text-slate-500">started {timeAgo(d.createdAt) || 'just now'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {paired.length === 0 ? (
        <div className="text-center text-slate-500 text-sm py-6">
          <i className="ph ph-television-simple text-3xl block mb-1 opacity-40"></i>
          No TVs paired yet. Click <b>Pair a TV</b> to claim a code shown on a TV, or set a kiosk code on a profile and type it at <code>/pickup/tv</code>.
        </div>
      ) : (
        <div className="space-y-2">
          {paired.map((d) => {
            const profile = profileById.get(d.profileId);
            return (
              <div key={d.id} className="rounded-lg border border-slate-700 bg-slate-900/70 p-3 flex flex-wrap items-center gap-3">
                <div className="w-2 h-10 rounded" style={{ background: profile?.accent || '#475569' }}></div>
                <div className="flex-1 min-w-[220px]">
                  <div className="font-semibold text-slate-100 text-sm truncate">{d.deviceLabel}</div>
                  <div className="text-[11px] text-slate-400 truncate">last seen {timeAgo(d.lastSeenAt) || 'never'} · <code className="text-slate-500">{d.id}</code></div>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Profile</label>
                  <select
                    value={d.profileId || ''}
                    onChange={(e) => onReassign(d, e.target.value)}
                    className="bg-slate-800 border border-slate-600 text-slate-100 text-xs rounded px-2 py-1.5 max-w-[200px] focus:border-amber-500 focus:outline-none"
                  >
                    {!d.profileId && <option value="">— unassigned —</option>}
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={() => onRename(d)}
                  title="Rename this TV"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-200 bg-amber-500/15 border border-amber-500/40 rounded-md hover:bg-amber-500/25 hover:text-amber-100 transition-colors"
                >
                  <i className="ph ph-pencil-simple"></i> Rename
                </button>
                <button
                  onClick={() => onRevoke(d)}
                  title="Unpair this TV"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-200 bg-red-500/15 border border-red-500/40 rounded-md hover:bg-red-500/25 hover:text-red-100 transition-colors"
                >
                  <i className="ph ph-plug"></i> Unpair
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
