import Head from 'next/head';
import Link from 'next/link';
import V2Layout from '../../components/v2/V2Layout';
import PageGuard from '../../components/v2/PageGuard';
import AccessDenied from '../../components/v2/AccessDenied';
import { useAuth } from '../../lib/AuthContext';

const QUICK_LINKS = [
  { href: '/v2/analytics', title: 'Pickup Analytics', description: 'Live pickup trend, gates, classes, terminals, and risk snapshot.' },
  { href: '/v2/pickup-admin', title: 'Onboarding Review', description: 'Review pending guardians, invites, and pickup settings.' },
  { href: '/v2/reports', title: 'Reports', description: 'Operational reports and exports for daily administration.' },
  { href: '/v2/system-interfaces', title: 'Service Interfaces', description: 'Monitor the operational probes and backend service health.' },
];

export default function DashboardHome() {
  const { can } = useAuth();
  const canDashboard = can('dashboard', 'view') || can('analytics', 'view') || can('analytics', 'view_pickup');

  return (
    <V2Layout>
      <Head>
        <title>BINUS Operations Console</title>
      </Head>

      <PageGuard feature="dashboard" action="view" what="view dashboard home">
        {!canDashboard ? (
          <AccessDenied feature="dashboard" action="view" what="see the dashboard home" variant="panel" />
        ) : (
          <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1600px] mx-auto space-y-5">
            <section className="rounded-[24px] border border-slate-800/80 bg-[radial-gradient(circle_at_15%_20%,rgba(45,212,191,0.16),transparent_42%),radial-gradient(circle_at_82%_12%,rgba(14,165,233,0.12),transparent_34%),linear-gradient(160deg,rgba(5,11,23,0.96),rgba(10,19,34,0.94))] p-6 sm:p-8 shadow-[0_24px_70px_rgba(2,6,23,0.62)] animate-fade-in-up">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                  <p className="text-[11px] tracking-[0.28em] uppercase text-cyan-200/90 font-semibold">BINUS School Simprug</p>
                  <h1 className="text-3xl sm:text-4xl font-semibold text-slate-100 mt-2">Operations Console</h1>
                  <p className="text-slate-400 mt-3 text-sm sm:text-base leading-7">
                    A clean entry point for pickup operations, analytics, reporting, and live service visibility.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href="/v2/analytics" className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-cyan-400/15 text-cyan-100 border border-cyan-300/35 hover:bg-cyan-300/20 transition">
                    Open Analytics
                  </Link>
                  <Link href="/v2/pickup-admin" className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-slate-900/70 text-slate-100 border border-slate-700 hover:bg-slate-800/80 transition">
                    Pickup Admin
                  </Link>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {QUICK_LINKS.map((item, index) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-2xl border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_14px_40px_rgba(2,6,23,0.45)] hover:border-cyan-400/30 hover:bg-slate-900/75 transition-all animate-fade-in-up"
                  style={{ animationDelay: `${index * 60}ms` }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-100 tracking-wide">{item.title}</h2>
                      <p className="text-[11px] text-slate-500 mt-2 leading-5">{item.description}</p>
                    </div>
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-slate-900/80 text-cyan-200">
                      <i className="ph ph-arrow-up-right text-lg"></i>
                    </span>
                  </div>
                </Link>
              ))}
            </section>

            <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <InfoPanel title="Quick Access" subtitle="Fast routes for daily operations">
                <LinkRow href="/v2/analytics" label="Pickup Analytics" />
                <LinkRow href="/v2/pickup-admin" label="Onboarding Review" />
                <LinkRow href="/v2/reports" label="Reports" />
                <LinkRow href="/v2/system-interfaces" label="Service Interfaces" />
              </InfoPanel>

              <InfoPanel title="Live Focus" subtitle="What the team uses most">
                <BulletRow label="Pickup trend" value="Wavy trend + gate activity" />
                <BulletRow label="Reliability" value="Terminal status pie and service health" />
                <BulletRow label="Review desk" value="Pending forms and onboarding queue" />
              </InfoPanel>

              <InfoPanel title="Notes" subtitle="Dashboard behavior">
                <BulletRow label="Route" value="This page stays light and stable" />
                <BulletRow label="Style" value="Dark operational shell" />
                <BulletRow label="Goal" value="No blank home screen" />
              </InfoPanel>
            </section>
          </div>
        )}
      </PageGuard>
    </V2Layout>
  );
}

function InfoPanel({ title, subtitle, children }) {
  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-950/72 p-5 shadow-[0_14px_40px_rgba(2,6,23,0.45)]">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-100 tracking-wide">{title}</h2>
        {subtitle && <p className="text-[11px] text-slate-500 mt-1">{subtitle}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function LinkRow({ href, label }) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200 hover:bg-slate-800/80 transition">
      <span>{label}</span>
      <i className="ph ph-arrow-right text-slate-500"></i>
    </Link>
  );
}

function BulletRow({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p className="text-sm text-slate-200 mt-1">{value}</p>
    </div>
  );
}
