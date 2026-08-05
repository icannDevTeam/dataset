import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const KIND_ICON = {
  security: { icon: 'ph-shield-warning', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  form: { icon: 'ph-hand-waving', cls: 'bg-brand-500/15 text-brand-300 border-brand-500/30' },
  email: { icon: 'ph-envelope-simple', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
};

function timeAgo(iso) {
  if (!iso) return '';
  const d = Date.now() - Date.parse(iso);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

const SEEN_KEY = 'v2-notif-seen';

export default function NotificationBell({ className = '' }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [seenAt, setSeenAt] = useState('');
  const panelRef = useRef(null);

  useEffect(() => {
    try { setSeenAt(localStorage.getItem(SEEN_KEY) || ''); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const r = await fetch('/api/pickup/admin/notifications', { credentials: 'include' });
        if (r.status === 401 || r.status === 403) { if (!stop) setAllowed(false); return; }
        if (!r.ok) return;
        const j = await r.json();
        if (!stop) setItems(Array.isArray(j.items) ? j.items : []);
      } catch { /* ignore */ }
    };
    load();

    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);

    const t = setInterval(load, 90000);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!allowed) return null;

  const unread = items.filter((i) => i.at && i.at > seenAt).length;

  const toggle = () => {
    setOpen((o) => {
      if (!o) {
        const now = new Date().toISOString();
        setSeenAt(now);
        try { localStorage.setItem(SEEN_KEY, now); } catch { /* ignore */ }
      }
      return !o;
    });
  };

  return (
    <div ref={panelRef} className={`relative ${className}`}>
      <button
        onClick={toggle}
        title="Notifications"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        className="relative w-9 h-9 rounded-xl bg-slate-900/70 backdrop-blur border border-slate-700/70 text-slate-400 hover:text-white hover:border-slate-500 transition-colors flex items-center justify-center"
      >
        <i className="ph ph-bell text-lg"></i>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-slate-950">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-700/70 bg-slate-950/95 backdrop-blur shadow-2xl shadow-black/50 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <span className="text-sm font-semibold text-white">Notifications</span>
            <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">last 24h</span>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-slate-500 text-xs">
                <i className="ph ph-bell-slash text-2xl block mb-2"></i>
                Nothing new — all quiet.
              </div>
            ) : (
              items.map((it) => {
                const k = KIND_ICON[it.kind] || KIND_ICON.form;
                return (
                  <Link
                    key={it.id}
                    href={it.href || '/v2'}
                    onClick={() => setOpen(false)}
                    className="flex items-start gap-3 px-4 py-3 border-b border-slate-900 last:border-0 hover:bg-white/5 transition-colors"
                  >
                    <span className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${k.cls}`}>
                      <i className={`ph ${k.icon} text-base`}></i>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold text-slate-200 truncate">{it.title}</span>
                      <span className="block text-[11px] text-slate-500 truncate">{it.detail}</span>
                    </span>
                    <span className="text-[10px] text-slate-600 font-mono flex-shrink-0 mt-0.5">{timeAgo(it.at)}</span>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
