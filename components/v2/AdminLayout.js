/**
 * AdminLayout — focused chrome for the security/RBAC console.
 *
 * Renders ONLY three top-level destinations:
 *   • RBAC               (/v2/admin/rbac)
 *   • System Audit       (/v2/admin/system-audit)
 *   • Security Audit     (/v2/admin/security-audit)
 *
 * Everything else (Dashboard, Pickup, Devices, …) is intentionally hidden so
 * the workspace can use the full viewport. A "Back to Dashboard" link in the
 * header returns the user to the standard V2Layout surface.
 */
import Link from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/AuthContext';

const ADMIN_NAV = [
  {
    href: '/v2/admin/rbac',
    icon: 'ph-shield-checkered',
    label: 'RBAC',
    description: 'Roles, users, permissions',
  },
  {
    href: '/v2/admin/system-audit',
    icon: 'ph-clipboard-text',
    label: 'System Audit',
    description: 'Mutation history',
  },
  {
    href: '/v2/admin/security-audit',
    icon: 'ph-shield-warning',
    label: 'Security Audit',
    description: 'Access logs & anomalies',
  },
];

function getWIBTime() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(11, 19);
}

export default function AdminLayout({ children, title = 'Admin Console', subtitle, actions = null, fullBleed = false }) {
  const router = useRouter();
  const { user, role, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [clock, setClock] = useState('');

  useEffect(() => {
    setClock(getWIBTime());
    const t = setInterval(() => setClock(getWIBTime()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { setMobileOpen(false); }, [router.pathname]);

  const isActive = (href) => router.pathname === href || router.pathname.startsWith(href + '/');

  const sidebar = (
    <div className={`flex flex-col h-full ${collapsed ? 'w-[72px]' : 'w-60'} transition-all duration-300 bg-slate-950 border-r border-slate-800/80`}>
      {/* Brand */}
      <div className={`flex items-center gap-3 ${collapsed ? 'px-3 justify-center' : 'px-4'} h-20 border-b border-slate-800/80 flex-shrink-0`}>
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500/30 to-red-500/30 border border-amber-500/40 flex items-center justify-center flex-shrink-0">
          <i className="ph ph-shield-star text-amber-300 text-xl" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="font-bold text-sm tracking-tight text-white leading-tight block">Admin Console</span>
            <span className="text-[10px] text-amber-400/80 leading-tight block uppercase tracking-widest">Restricted</span>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-5 px-3 space-y-1.5">
        {ADMIN_NAV.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group relative flex items-center ${collapsed ? 'justify-center px-2' : 'gap-3 px-3'} py-3 rounded-xl transition-all border ${
                active
                  ? 'bg-brand-500/10 text-brand-300 border-brand-500/30 shadow-[0_0_18px_rgba(34,211,238,0.08)]'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border-transparent hover:border-slate-700/40'
              }`}
              title={collapsed ? item.label : undefined}
            >
              <i className={`ph ${item.icon} text-xl flex-shrink-0`}></i>
              {!collapsed && (
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold leading-tight">{item.label}</div>
                  <div className="text-[10px] text-slate-500 leading-tight mt-0.5">{item.description}</div>
                </div>
              )}
              {collapsed && (
                <div className="absolute left-full ml-2 px-2.5 py-1.5 bg-slate-800 border border-slate-700 text-white text-xs font-medium rounded-lg whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 pointer-events-none shadow-lg">
                  {item.label}
                </div>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom: back to main + user */}
      <div className="border-t border-slate-800/80 p-3 flex-shrink-0 space-y-2">
        <Link
          href="/v2"
          className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2.5 px-3'} py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-white/5 border border-slate-800/60 transition-all`}
          title={collapsed ? 'Back to dashboard' : undefined}
        >
          <i className="ph ph-arrow-bend-up-left text-base" />
          {!collapsed && <span>Back to dashboard</span>}
        </Link>

        {user && !collapsed && (
          <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/5 border border-slate-800">
            {user.photoURL ? (
              <img src={user.photoURL} alt="" className="w-7 h-7 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center text-xs font-bold flex-shrink-0">
                {(user.displayName || user.email || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-white truncate">{user.displayName || 'User'}</div>
              <div className="text-[10px] text-slate-500 truncate">{user.email}</div>
              {role && (
                <span className="inline-block mt-0.5 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{role}</span>
              )}
            </div>
            <button onClick={() => signOut?.()} title="Sign out" className="text-slate-500 hover:text-red-400 transition-colors">
              <i className="ph ph-sign-out text-base" />
            </button>
          </div>
        )}

        <button
          onClick={() => setCollapsed(c => !c)}
          className={`w-full flex items-center ${collapsed ? 'justify-center' : 'justify-end'} px-2 py-1.5 text-slate-500 hover:text-slate-200 transition-colors`}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <i className={`ph ${collapsed ? 'ph-caret-double-right' : 'ph-caret-double-left'} text-sm`} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <Head>
        <title>{title} · BINUS Admin</title>
      </Head>

      {/* Desktop sidebar */}
      <div className="hidden lg:block flex-shrink-0">{sidebar}</div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <>
          <div className="lg:hidden fixed inset-0 bg-black/60 z-40" onClick={() => setMobileOpen(false)} />
          <div className="lg:hidden fixed inset-y-0 left-0 z-50">{sidebar}</div>
        </>
      )}

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="flex-shrink-0 h-14 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-sm flex items-center justify-between px-4 lg:px-6 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              className="lg:hidden text-slate-400 hover:text-white"
              onClick={() => setMobileOpen(true)}
            >
              <i className="ph ph-list text-xl" />
            </button>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-white truncate">{title}</h1>
              {subtitle && <p className="text-[11px] text-slate-500 truncate">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {actions}
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-500">
              <i className="ph ph-clock" /> {clock} WIB
            </span>
          </div>
        </header>

        {/* Content fills remaining viewport — children control internal scroll */}
        <main className={`flex-1 min-h-0 overflow-hidden ${fullBleed ? '' : 'p-4 lg:p-6'}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
