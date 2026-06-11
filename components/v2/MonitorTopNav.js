/**
 * MonitorTopNav — shared tab bar for the monitoring pages.
 * Renders above the page content inside V2Layout.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';

const TABS = [
  {
    href: '/v2/pickup-monitor',
    icon: 'ph-heartbeat',
    label: 'System Health',
    sub: 'APIs · Email · Security',
  },
  {
    href: '/v2/pickup-ops',
    icon: 'ph-terminal-window',
    label: 'Operations & Interfaces',
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
    <div className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 mb-6">
      <div className="max-w-screen-2xl mx-auto flex items-center gap-1 overflow-x-auto">
        {TABS.map((tab) => {
          const isActive = active === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex items-center gap-2.5 px-4 py-3.5 border-b-2 text-sm font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <i className={`ph ${tab.icon} text-base`}></i>
              <span>{tab.label}</span>
              <span className={`hidden sm:inline text-xs font-normal ${isActive ? 'text-blue-400' : 'text-gray-400'}`}>
                — {tab.sub}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
