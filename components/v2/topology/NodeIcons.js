/**
 * Cisco-style topology glyphs — pure inline SVG, no external assets.
 *
 * Every icon renders a <g> sized for a 64x64 box with (0,0) at the top-left.
 * The parent (TopologyDiagram) positions them with transform translate().
 */

export const CISCO_BLUE_DEEP = '#0b2e59';
export const CISCO_BLUE = '#1565c0';
export const CISCO_BLUE_LIGHT = '#1e88e5';

/* Double-headed Cisco arrow pointing right from the icon centre. */
function RadArrow({ angle, cx = 32, cy = 32, len = 21 }) {
  return (
    <g transform={`rotate(${angle} ${cx} ${cy})`}>
      <path
        d={`M ${cx + 4} ${cy - 2.2} L ${cx + len - 7} ${cy - 2.2} L ${cx + len - 7} ${cy - 5.5} L ${cx + len} ${cy} L ${cx + len - 7} ${cy + 5.5} L ${cx + len - 7} ${cy + 2.2} L ${cx + 4} ${cy + 2.2} Z`}
        fill="#fff"
      />
    </g>
  );
}

/* Cisco routed-switch: rounded square + radiating white arrows.
   arrows=4 → diagonals (campus switch), arrows=8 → hub/core. */
export function SwitchIcon({ arrows = 4, dark = false }) {
  const angles = arrows === 8
    ? [0, 45, 90, 135, 180, 225, 270, 315]
    : [45, 135, 225, 315];
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12"
        fill={dark ? CISCO_BLUE_DEEP : `url(#topoSwitchGrad)`}
        stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <circle cx="32" cy="32" r="6.5" fill="#fff" opacity=".95" />
      {angles.map((a) => <RadArrow key={a} angle={a} />)}
    </g>
  );
}

/* Cloud — external network. */
export function CloudIcon() {
  return (
    <g>
      <path
        d="M 16 44 a 10 10 0 0 1 -1 -19.9 A 14 14 0 0 1 41 18.5 A 11 11 0 0 1 50 44 Z"
        fill="#0f172a" stroke={CISCO_BLUE_LIGHT} strokeWidth="2.5" strokeLinejoin="round"
      />
    </g>
  );
}

/* Firestore — database cylinder stack. */
export function DbIcon() {
  return (
    <g>
      <rect x="8" y="2" width="48" height="60" rx="10" fill="url(#topoSwitchGrad)" stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <ellipse cx="32" cy="18" rx="15" ry="6" fill="none" stroke="#fff" strokeWidth="2.5" />
      <path d="M 17 18 V 44 a 15 6 0 0 0 30 0 V 18" fill="none" stroke="#fff" strokeWidth="2.5" />
      <path d="M 17 31 a 15 6 0 0 0 30 0" fill="none" stroke="#fff" strokeWidth="2" opacity=".7" />
    </g>
  );
}

/* Cloud Functions — lambda chip. */
export function FnIcon() {
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12" fill="url(#topoSwitchGrad)" stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <text x="32" y="43" textAnchor="middle" fill="#fff" fontSize="32" fontWeight="700" fontFamily="ui-monospace, monospace">λ</text>
    </g>
  );
}

/* Resend — envelope. */
export function EnvelopeIcon() {
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12" fill="url(#topoSwitchGrad)" stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <rect x="14" y="20" width="36" height="26" rx="4" fill="none" stroke="#fff" strokeWidth="2.5" />
      <path d="M 15 22 L 32 36 L 49 22" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
    </g>
  );
}

/* Hikvision face terminal — panel with face outline. */
export function TerminalIcon() {
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12" fill={CISCO_BLUE_DEEP} stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <rect x="16" y="10" width="32" height="44" rx="5" fill="none" stroke="#fff" strokeWidth="2.2" />
      <circle cx="32" cy="27" r="7" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path d="M 22 46 a 10 8 0 0 1 20 0" fill="none" stroke="#fff" strokeWidth="2.2" />
    </g>
  );
}

/* WhatsApp — chat bubble. */
export function ChatIcon() {
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12" fill={CISCO_BLUE_DEEP} stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <path d="M 32 14 a 17 15 0 0 1 0 30 a 19 19 0 0 1 -8 -1.6 L 16 46 l 2.6 -7 A 15 15 0 0 1 32 14 Z"
        fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="26" cy="29" r="1.8" fill="#fff" />
      <circle cx="33" cy="29" r="1.8" fill="#fff" />
      <circle cx="40" cy="29" r="1.8" fill="#fff" />
    </g>
  );
}

/* BINUS School API — globe. */
export function GlobeIcon() {
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12" fill={CISCO_BLUE_DEEP} stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="#fff" strokeWidth="2.2" />
      <ellipse cx="32" cy="32" rx="8" ry="17" fill="none" stroke="#fff" strokeWidth="1.8" />
      <path d="M 15 32 h 34 M 17.5 24 h 29 M 17.5 40 h 29" stroke="#fff" strokeWidth="1.8" fill="none" />
    </g>
  );
}

/* TV kiosk display. */
export function TvIcon() {
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12" fill={CISCO_BLUE_DEEP} stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <rect x="12" y="16" width="40" height="26" rx="3" fill="none" stroke="#fff" strokeWidth="2.4" />
      <path d="M 26 48 h 12 M 32 42 v 6" stroke="#fff" strokeWidth="2.4" />
      <path d="M 17 36 l 7 -7 l 5 4 l 9 -9" fill="none" stroke="#22d3ee" strokeWidth="2.2" strokeLinejoin="round" />
    </g>
  );
}

/* Python listener — terminal prompt chip. */
export function ListenerIcon() {
  return (
    <g>
      <rect x="2" y="2" width="60" height="60" rx="12" fill="url(#topoSwitchGrad)" stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
      <rect x="12" y="16" width="40" height="32" rx="4" fill="none" stroke="#fff" strokeWidth="2.4" />
      <path d="M 19 26 l 6 6 l -6 6" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M 30 38 h 12" stroke="#fff" strokeWidth="2.4" />
    </g>
  );
}

export const ICONS = {
  switch: SwitchIcon,
  cloud: CloudIcon,
  db: DbIcon,
  fn: FnIcon,
  envelope: EnvelopeIcon,
  terminal: TerminalIcon,
  chat: ChatIcon,
  globe: GlobeIcon,
  tv: TvIcon,
  listener: ListenerIcon,
};
