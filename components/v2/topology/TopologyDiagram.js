import { useEffect, useMemo, useRef, useState } from 'react';
import { ICONS, CISCO_BLUE, CISCO_BLUE_DEEP, CISCO_BLUE_LIGHT } from './NodeIcons';

/**
 * Animated Cisco SD-Access-style topology for the pickup system.
 * Pure SVG — dashed-line flow via CSS keyframes, packet dots via SMIL
 * <animateMotion>. Nodes map onto live /service-interfaces data.
 */

const VB_W = 1240;
const VB_H = 760;

const STATUS_STROKE = {
  up: '#34d399',
  degraded: '#fbbf24',
  down: '#f87171',
  unconfigured: '#64748b',
};

/* ---- fixed layout (icon = 64x64, x/y = top-left of icon box) ---- */
const BASE_NODES = [
  { id: 'cloud',     x: 80,   y: 40,  icon: 'cloud',    label: 'Internet / Parents', sub: 'Outside world',        ifaceId: null },
  { id: 'vercel',    x: 300,  y: 150, icon: 'switch',   label: 'Vercel Edge',        sub: 'dataset app · BN',     ifaceId: null,            arrows: 4 },
  { id: 'api',       x: 560,  y: 290, icon: 'switch',   label: 'Next.js API Layer',  sub: 'pages/api · hub',      ifaceId: null,            arrows: 8 },
  { id: 'firestore', x: 950,  y: 120, icon: 'db',       label: 'Firestore',          sub: 'Gi0/0',                ifaceId: 'firebase' },
  { id: 'functions', x: 1120, y: 250, icon: 'fn',       label: 'Cloud Functions',    sub: 'Lo0 · email worker',   ifaceId: 'cloud_functions' },
  { id: 'resend',    x: 670,  y: 50,  icon: 'envelope', label: 'Resend',             sub: 'Gi0/1 · SMTP relay',   ifaceId: 'resend' },
  { id: 'whatsapp',  x: 180,  y: 380, icon: 'chat',     label: 'WhatsApp',           sub: 'Tu0 · notify',         ifaceId: 'whatsapp' },
  { id: 'binus',     x: 80,   y: 540, icon: 'globe',    label: 'BINUS School API',   sub: 'Tu1 · roster sync',    ifaceId: 'binus_api' },
  { id: 'tv',        x: 380,  y: 560, icon: 'tv',       label: 'TV Kiosk',           sub: 'SSE live board',       ifaceId: null },
  { id: 'listener',  x: 950,  y: 470, icon: 'listener', label: 'Python Listener',    sub: 'Jetson · event stream', ifaceId: null },
];

/* Terminal slots along the bottom (filled dynamically from hik_* interfaces). */
const TERM_SLOTS = [
  { x: 620, y: 620 }, { x: 770, y: 640 }, { x: 920, y: 640 }, { x: 1070, y: 620 },
];

const BASE_LINKS = [
  { id: 'cloud-vercel',   from: 'cloud',     to: 'vercel',    ifaceId: null,              dir: 'both' },
  { id: 'vercel-api',     from: 'vercel',    to: 'api',       ifaceId: null,              dir: 'both' },
  { id: 'api-firestore',  from: 'api',       to: 'firestore', ifaceId: 'firebase',        dir: 'both',  latency: true },
  { id: 'fs-functions',   from: 'firestore', to: 'functions', ifaceId: 'cloud_functions', dir: 'fwd' },
  { id: 'fn-resend',      from: 'functions', to: 'resend',    ifaceId: 'resend',          dir: 'fwd',   queueBadge: true },
  { id: 'resend-cloud',   from: 'resend',    to: 'cloud',     ifaceId: 'resend',          dir: 'fwd' },
  { id: 'api-whatsapp',   from: 'api',       to: 'whatsapp',  ifaceId: 'whatsapp',        dir: 'fwd' },
  { id: 'api-binus',      from: 'api',       to: 'binus',     ifaceId: 'binus_api',       dir: 'both' },
  { id: 'api-tv',         from: 'api',       to: 'tv',        ifaceId: null,              dir: 'fwd' },
  { id: 'listener-fs',    from: 'listener',  to: 'firestore', ifaceId: null,              dir: 'fwd' },
];

function centerOf(node) {
  return { cx: node.x + 32, cy: node.y + 32 };
}

/* Speed tier from 5-min packet rates: 0 idle, 1 light, 2 busy. */
function speedTier(iface) {
  if (!iface || !iface.counters) return 0;
  const r = (iface.counters.inputRate5min || 0) + (iface.counters.outputRate5min || 0);
  if (r >= 1) return 2;
  if (r > 0) return 1;
  return 0;
}

function AnimatedLink({ link, from, to, iface, reducedMotion }) {
  const a = centerOf(from);
  const b = centerOf(to);
  const status = link.ifaceId ? (iface?.status || 'unconfigured') : 'up';
  const color = STATUS_STROKE[status] || STATUS_STROKE.unconfigured;
  const down = status === 'down';
  const uncfg = status === 'unconfigured';
  const tier = down || uncfg ? 0 : speedTier(iface);

  // shorten so lines stop at icon edges
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const len = Math.hypot(dx, dy) || 1;
  const pad = 40;
  const x1 = a.cx + (dx / len) * pad, y1 = a.cy + (dy / len) * pad;
  const x2 = b.cx - (dx / len) * pad, y2 = b.cy - (dy / len) * pad;
  const pathD = `M ${x1} ${y1} L ${x2} ${y2}`;
  const pathDRev = `M ${x2} ${y2} L ${x1} ${y1}`;
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;

  const dashDur = tier === 2 ? '0.7s' : tier === 1 ? '1.6s' : '3.2s';
  const pktDur = tier === 2 ? '1.4s' : tier === 1 ? '2.6s' : '5s';
  const pkts = down || uncfg ? 0 : tier === 2 ? 3 : tier === 1 ? 2 : 1;
  const animate = !reducedMotion && !down && !uncfg;

  return (
    <g>
      <path d={pathD} stroke={down ? '#7f1d1d' : 'rgba(148,163,184,.25)'} strokeWidth="3" fill="none" />
      <path
        d={pathD}
        stroke={color}
        strokeWidth={down ? 2 : 2.2}
        fill="none"
        strokeDasharray={uncfg ? '3 7' : down ? '6 6' : '9 9'}
        opacity={uncfg ? 0.5 : down ? 0.9 : tier === 0 ? 0.45 : 0.95}
        className={animate ? 'topo-dash' : undefined}
        style={animate ? { animationDuration: dashDur } : undefined}
      />
      {animate && Array.from({ length: pkts }).map((_, i) => (
        <circle key={i} r="3.4" fill={color} opacity="0.95">
          <animateMotion
            dur={pktDur}
            repeatCount="indefinite"
            begin={`${(i * (parseFloat(pktDur) / pkts)).toFixed(2)}s`}
            path={link.dir === 'both' && i % 2 === 1 ? pathDRev : pathD}
          />
        </circle>
      ))}
      {down && (
        <g transform={`translate(${midX} ${midY})`}>
          <circle r="10" fill="#7f1d1d" stroke="#f87171" strokeWidth="1.5" />
          <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" stroke="#fecaca" strokeWidth="2.2" />
        </g>
      )}
      {link.latency && iface?.probe?.latencyMs != null && !down && (
        <g transform={`translate(${midX} ${midY - 14})`}>
          <rect x="-34" y="-11" width="68" height="20" rx="10" fill="#0f172a" stroke="rgba(52,211,153,.4)" strokeWidth="1" />
          <text textAnchor="middle" y="4" fill="#34d399" fontSize="11" fontFamily="ui-monospace, monospace">
            {iface.probe.latencyMs} ms
          </text>
        </g>
      )}
      {link.queueBadge && link.queueCount > 0 && (
        <g transform={`translate(${midX} ${midY + 16})`}>
          <rect x="-44" y="-11" width="88" height="20" rx="10" fill="#0f172a" stroke="rgba(251,191,36,.45)" strokeWidth="1" />
          <text textAnchor="middle" y="4" fill="#fbbf24" fontSize="11" fontFamily="ui-monospace, monospace">
            queue: {link.queueCount}
          </text>
        </g>
      )}
    </g>
  );
}

function Node({ node, iface, onSelect }) {
  const Icon = ICONS[node.icon];
  const status = node.ifaceId ? (iface?.status || 'unconfigured') : 'up';
  const ring = STATUS_STROKE[status] || STATUS_STROKE.unconfigured;
  const clickable = !!node.ifaceId && !!iface;

  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      onClick={clickable ? () => onSelect(iface) : undefined}
      style={{ cursor: clickable ? 'pointer' : 'default' }}
      className="topo-node"
    >
      {node.icon !== 'cloud' && (
        <rect x="-4" y="-4" width="72" height="72" rx="16" fill="none" stroke={ring} strokeWidth="1.5" opacity="0.6" />
      )}
      <Icon arrows={node.arrows} />
      {node.ifaceId && (
        <circle cx="60" cy="4" r="5.5" fill={ring} stroke="#0f172a" strokeWidth="2">
          {status === 'up' && <animate attributeName="opacity" values="1;.45;1" dur="2s" repeatCount="indefinite" />}
        </circle>
      )}
      <text x="32" y="84" textAnchor="middle" fill="#e2e8f0" fontSize="13" fontWeight="600" fontFamily="ui-sans-serif, system-ui">
        {node.label}
      </text>
      <text x="32" y="99" textAnchor="middle" fill="#64748b" fontSize="10.5" fontFamily="ui-monospace, monospace">
        {iface?.name || node.sub}
      </text>
    </g>
  );
}

export default function TopologyDiagram({ interfaces = [], health = null, onSelect = () => {} }) {
  const svgRef = useRef(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const onVis = () => {
      const svg = svgRef.current;
      if (!svg || !svg.pauseAnimations) return;
      if (document.hidden) svg.pauseAnimations();
      else svg.unpauseAnimations();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const byId = useMemo(() => {
    const m = {};
    for (const i of interfaces) m[i.id] = i;
    return m;
  }, [interfaces]);

  const termIfaces = useMemo(
    () => interfaces.filter((i) => i.id.startsWith('hik')).slice(0, TERM_SLOTS.length),
    [interfaces]
  );

  const nodes = useMemo(() => {
    const terms = termIfaces.map((iface, i) => ({
      id: `term-${iface.id}`,
      x: TERM_SLOTS[i].x,
      y: TERM_SLOTS[i].y,
      icon: 'terminal',
      label: iface.description || `Terminal ${i + 1}`,
      sub: iface.name,
      ifaceId: iface.id,
    }));
    return [...BASE_NODES, ...terms];
  }, [termIfaces]);

  const links = useMemo(() => {
    const queuePending = health?.emailQueue?.pending ?? 0;
    const base = BASE_LINKS.map((l) => (l.queueBadge ? { ...l, queueCount: queuePending } : l));
    const termLinks = termIfaces.map((iface) => ({
      id: `link-term-${iface.id}`,
      from: `term-${iface.id}`,
      to: 'listener',
      ifaceId: iface.id,
      dir: 'fwd',
    }));
    return [...base, ...termLinks];
  }, [termIfaces, health]);

  const nodeById = useMemo(() => {
    const m = {};
    for (const n of nodes) m[n.id] = n;
    return m;
  }, [nodes]);

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70">
      <svg ref={svgRef} viewBox={`0 0 ${VB_W} ${VB_H}`} className="block w-full h-auto" role="img" aria-label="Live system topology">
        <defs>
          <linearGradient id="topoSwitchGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CISCO_BLUE_LIGHT} />
            <stop offset="55%" stopColor={CISCO_BLUE} />
            <stop offset="100%" stopColor={CISCO_BLUE_DEEP} />
          </linearGradient>
          <pattern id="topoGridDots" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1" fill="rgba(148,163,184,.08)" />
          </pattern>
        </defs>

        <rect width={VB_W} height={VB_H} fill="url(#topoGridDots)" />

        {/* Services block (Cisco-style dotted enclosure) */}
        <rect x="900" y="20" width="320" height="330" rx="14" fill="rgba(21,101,192,.05)"
          stroke="rgba(30,136,229,.45)" strokeWidth="1.5" strokeDasharray="6 5" />
        <text x="918" y="44" fill="#60a5fa" fontSize="12" fontWeight="700" letterSpacing="2"
          fontFamily="ui-monospace, monospace">GOOGLE CLOUD SERVICES</text>

        {/* Edge block */}
        <rect x="560" y="560" width="640" height="170" rx="14" fill="rgba(21,101,192,.04)"
          stroke="rgba(100,116,139,.4)" strokeWidth="1.5" strokeDasharray="6 5" />
        <text x="578" y="584" fill="#94a3b8" fontSize="12" fontWeight="700" letterSpacing="2"
          fontFamily="ui-monospace, monospace">FACE TERMINALS · SERIAL0/N</text>

        {links.map((l) => {
          const from = nodeById[l.from];
          const to = nodeById[l.to];
          if (!from || !to) return null;
          return <AnimatedLink key={l.id} link={l} from={from} to={to} iface={l.ifaceId ? byId[l.ifaceId] : null} reducedMotion={reducedMotion} />;
        })}

        {nodes.map((n) => (
          <Node key={n.id} node={n} iface={n.ifaceId ? byId[n.ifaceId] : null} onSelect={onSelect} />
        ))}

        {/* Legend */}
        <g transform="translate(28 660)" fontFamily="ui-sans-serif, system-ui" fontSize="11.5">
          <rect x="-12" y="-22" width="250" height="104" rx="10" fill="rgba(2,6,23,.8)" stroke="rgba(51,65,85,.7)" strokeWidth="1" />
          <text y="-4" fill="#94a3b8" fontSize="10" fontWeight="700" letterSpacing="2">LEGEND</text>
          <line x1="0" y1="12" x2="34" y2="12" stroke={STATUS_STROKE.up} strokeWidth="2.2" strokeDasharray="9 9" />
          <text x="44" y="16" fill="#cbd5e1">UP — traffic flowing</text>
          <line x1="0" y1="32" x2="34" y2="32" stroke={STATUS_STROKE.degraded} strokeWidth="2.2" strokeDasharray="9 9" />
          <text x="44" y="36" fill="#cbd5e1">Degraded</text>
          <line x1="0" y1="52" x2="34" y2="52" stroke={STATUS_STROKE.down} strokeWidth="2.2" strokeDasharray="6 6" />
          <text x="44" y="56" fill="#cbd5e1">DOWN — link severed</text>
          <circle cx="8" cy="72" r="3.4" fill={STATUS_STROKE.up} />
          <text x="44" y="76" fill="#cbd5e1">Packet in flight</text>
        </g>
      </svg>

      <style jsx>{`
        :global(.topo-dash) {
          animation: topoDashFlow 1.6s linear infinite;
        }
        @keyframes topoDashFlow {
          to { stroke-dashoffset: -18; }
        }
        :global(.topo-node:hover rect:first-of-type) {
          opacity: 1;
        }
        @media (prefers-reduced-motion: reduce) {
          :global(.topo-dash) { animation: none; }
        }
      `}</style>
    </div>
  );
}
