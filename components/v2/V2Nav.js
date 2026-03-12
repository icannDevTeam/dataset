import Link from 'next/link';
import { useRouter } from 'next/router';

const NAV_ITEMS = [
  { href: '/v2', label: 'Dashboard Overview' },
  { href: '/v2/analytics', label: 'Analytics' },
  { href: '/v2/settings', label: 'Settings' },
];

export default function V2Nav({ clock }) {
  const router = useRouter();
  const current = router.pathname;

  return (
    <header className="fixed top-0 left-0 right-0 z-40 glass-panel border-b-0 border-slate-800/80">
      <div className="max-w-[90rem] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-400 to-indigo-600 flex items-center justify-center shadow-[0_0_15px_rgba(34,211,238,0.3)] relative overflow-hidden">
            <i className="ph ph-scan text-white text-xl z-10"></i>
            <div className="absolute inset-0 bg-white/20 h-[2px] w-full animate-scan-line"></div>
          </div>
          <span className="font-bold text-lg tracking-tight text-white">
            BINUS<span className="text-brand-400">Face</span>
          </span>
          <span className="ml-2 px-2 py-0.5 rounded text-[10px] font-bold bg-brand-500/20 text-brand-400 border border-brand-500/30 uppercase tracking-wide">v2</span>
        </div>

        {/* Nav Links */}
        <nav className="hidden md:flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${
                current === item.href
                  ? 'bg-white/10 text-brand-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-white/5'
              }`}
            >
              {item.label}
            </Link>
          ))}
          <div className="h-5 w-px bg-slate-800 mx-2"></div>
          <Link href="/dashboard" className="px-3 py-2 text-xs font-medium rounded-md text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-all border border-slate-800">
            v1 Dashboard
          </Link>
        </nav>

        {/* Right side */}
        <div className="flex items-center gap-3">
          {clock && (
            <span className="text-sm font-mono text-slate-400">
              {clock} <span className="text-slate-600">WIB</span>
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
