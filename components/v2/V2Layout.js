import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';

function getWIBTime() {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return now.toISOString().slice(11, 19);
}

const NAV_SECTIONS = [
  {
    label: 'Main',
    items: [
      { href: '/v2', icon: 'ph-squares-four', label: 'Dashboard' },
      { href: '/v2/analytics', icon: 'ph-chart-line-up', label: 'Analytics' },
      { href: '/v2/reports', icon: 'ph-file-text', label: 'Reports' },
    ],
  },
  {
    label: 'Management',
    items: [
      { icon: 'ph-user-circle-plus', label: 'Enrollment', children: [
        { href: '/enrollment', label: 'Dataset Capture' },
        { href: '/mobile-enrollment', label: 'Mobile Enrollment' },
      ]},
      { href: '/device-manager', icon: 'ph-cpu', label: 'Device Manager' },
      { href: '/attendance-monitor', icon: 'ph-list-checks', label: 'Attendance Monitor' },
      { href: '/hikvision', icon: 'ph-fingerprint', label: 'Hikvision' },
      { href: '/v2/device-sync', icon: 'ph-cloud-arrow-down', label: 'Device Sync' },
      { href: '/v2/settings', icon: 'ph-gear-six', label: 'Settings' },
    ],
  },
];

export default function V2Layout({ children }) {
  const router = useRouter();
  const [clock, setClock] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedNav, setExpandedNav] = useState(null);

  useEffect(() => {
    setClock(getWIBTime());
    const timer = setInterval(() => setClock(getWIBTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [router.pathname]);

  const isActive = (href) => {
    if (href === '/v2') return router.pathname === '/v2';
    return router.pathname.startsWith(href);
  };

  const sidebar = (
    <div className={`flex flex-col h-full ${collapsed ? 'w-[72px]' : 'w-64'} transition-all duration-300`}>
      {/* Brand */}
      <div className={`flex items-center gap-3 ${collapsed ? 'px-3 justify-center' : 'px-4'} h-20 border-b border-slate-800/80 flex-shrink-0`}>
        <img
          src="/binus-logo.jpg"
          alt="BINUS"
          className="w-9 h-9 rounded-lg object-contain flex-shrink-0 bg-white p-0.5"
        />
        {!collapsed && (
          <div className="min-w-0">
            <span className="font-bold text-sm tracking-tight text-white leading-tight block">
              BINUS School Simprug
            </span>
            <span className="text-[10px] text-slate-400 leading-tight block">
              Attendance Monitoring
            </span>
          </div>
        )}
      </div>

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto no-scrollbar py-4 px-3 space-y-6">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            {!collapsed && (
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest px-3 mb-2">{section.label}</p>
            )}
            <div className="space-y-1">
              {section.items.map((item) => {
                if (item.children) {
                  const childActive = item.children.some((c) => isActive(c.href));
                  const isOpen = expandedNav === item.label || childActive;
                  return (
                    <div key={item.label}>
                      <button
                        onClick={() => setExpandedNav(isOpen && !childActive ? null : item.label)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                          childActive
                            ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                            : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                        }`}
                        title={collapsed ? item.label : undefined}
                      >
                        <i className={`ph ${item.icon} text-xl flex-shrink-0`}></i>
                        {!collapsed && (
                          <>
                            <span className="flex-1 text-left">{item.label}</span>
                            <i className={`ph ${isOpen ? 'ph-caret-up' : 'ph-caret-down'} text-xs text-slate-500`}></i>
                          </>
                        )}
                      </button>
                      {isOpen && !collapsed && (
                        <div className="ml-5 pl-4 border-l border-slate-800 mt-1 space-y-0.5">
                          {item.children.map((child) => {
                            const cActive = isActive(child.href);
                            return (
                              <Link
                                key={child.href}
                                href={child.href}
                                className={`block px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                                  cActive
                                    ? 'text-brand-400 bg-brand-500/5'
                                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
                                }`}
                              >
                                {child.label}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      active
                        ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20 shadow-[0_0_10px_rgba(34,211,238,0.05)]'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                    }`}
                    title={collapsed ? item.label : undefined}
                  >
                    <i className={`ph ${item.icon} text-xl flex-shrink-0`}></i>
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-slate-800/80 p-3 flex-shrink-0 space-y-2">
        {!collapsed && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-mono text-slate-400">{clock} <span className="text-slate-600">WIB</span></span>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden lg:flex items-center justify-center w-full gap-2 px-3 py-2 rounded-xl text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-all text-sm"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <i className={`ph ${collapsed ? 'ph-caret-double-right' : 'ph-caret-double-left'} text-lg`}></i>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </div>
  );

  return (
    <div className="aura-theme antialiased min-h-screen selection:bg-brand-500/30 selection:text-brand-400 overflow-x-hidden relative">
      <div className="noise-overlay"></div>

      {/* Mobile header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-40 glass-panel border-b border-slate-800/80 h-14 flex items-center justify-between px-4">
        <button onClick={() => setMobileOpen(true)} className="text-slate-400 hover:text-white transition-colors">
          <i className="ph ph-list text-2xl"></i>
        </button>
        <div className="flex items-center gap-2">
          <img src="/binus-logo.jpg" alt="BINUS" className="w-7 h-7 rounded-lg object-contain bg-white p-0.5" />
          <span className="font-bold text-sm text-white">BINUS <span className="text-slate-400 font-normal text-xs">Simprug</span></span>
        </div>
        <span className="text-xs font-mono text-slate-400">{clock}</span>
      </header>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)}></div>
          <div className="absolute left-0 top-0 bottom-0 w-64 glass-panel border-r border-slate-800/80 bg-slate-950/95 z-10">
            {sidebar}
          </div>
        </div>
      )}

      {/* Desktop layout */}
      <div className="flex min-h-screen">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block fixed left-0 top-0 bottom-0 z-30 glass-panel border-r border-slate-800/80 bg-slate-950/80">
          {sidebar}
        </aside>

        {/* Main content */}
        <main className={`flex-1 ${collapsed ? 'lg:ml-[72px]' : 'lg:ml-64'} transition-all duration-300 pt-14 lg:pt-0`}>
          {children}
        </main>
      </div>
    </div>
  );
}
