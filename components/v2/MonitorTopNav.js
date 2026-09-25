/**
 * MonitorTopNav — shared tab bar linking all three owner-only monitoring pages.
 * Appears at the top of: Cost Monitor, Operations Interface, Service Interfaces.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';

const TABS = [
  {
    href: '/v2/cost-monitor',
    icon: 'ph-currency-dollar',
    label: 'Cost Monitor',
    sub: 'Spend · Free tier · Domains',
  },
  {
    href: '/v2/pickup-ops',
    icon: 'ph-terminal-window',
    label: 'Operations',
    sub: 'Terminals · Devices · Live stream',
  },
  {
    href: '/v2/system-interfaces',
    icon: 'ph-plugs-connected',
    label: 'Service Interfaces',
    sub: 'Firebase · Resend · Hikvision · APIs',
  },
];

export default function MonitorTopNav() {
  const router = useRouter();
  const active = router.pathname;

  return (
    <div className="border-b border-slate-800 px-4 sm:px-6 lg:px-8 mb-6 bg-slate-950/60 backdrop-blur-sm">
      <div className="max-w-[1800px] mx-auto flex items-center gap-0 overflow-x-auto">
        {TABS.map((tab) => {
          const isActive = active === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex items-center gap-2 px-4 py-3.5 border-b-2 text-sm font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? 'border-violet-400 text-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-300 hover:border-slate-600'
              }`}
            >
              <i className={`ph ${tab.icon} text-base ${isActive ? 'text-violet-400' : 'text-slate-600'}`}></i>
              <span>{tab.label}</span>
              <span className={`hidden sm:inline text-xs font-normal ${isActive ? 'text-slate-400' : 'text-slate-600'}`}>
                — {tab.sub}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
