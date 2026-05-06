/**
 * Terminal-gate helpers.
 *
 * Each terminal in `tenants/{tid}/terminals/{id}` may carry:
 *   windowOpen:    "HH:MM"   (Asia/Jakarta) — schedule open
 *   windowClose:   "HH:MM"   (Asia/Jakarta) — schedule close
 *   gateOverride:  "open" | "closed" | null — manual admin override
 *
 * Effective state precedence (highest first):
 *   1. gateOverride === "closed"  → CLOSED (admin force-close)
 *   2. gateOverride === "open"    → OPEN   (admin force-open, even outside schedule)
 *   3. schedule (if both window times set) → OPEN inside window, CLOSED outside
 *   4. no schedule + no override  → OPEN (always-open default)
 */

function _hhmmToMinutes(s) {
  if (!s || typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function _wibMinutes(d) {
  // Asia/Jakarta = UTC+7 (no DST).
  const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return wib.getUTCHours() * 60 + wib.getUTCMinutes();
}

function isValidHHMM(s) {
  return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s) && _hhmmToMinutes(s) != null;
}

/**
 * @param {{windowOpen?:string, windowClose?:string, gateOverride?:'open'|'closed'|null}} terminal
 * @param {Date} [now]
 * @returns {{
 *   open: boolean,
 *   manualOverride: 'open'|'closed'|null,
 *   scheduled: { configured: boolean, opensAt: string|'', closesAt: string|'', open: boolean },
 *   reason: 'manual-open'|'manual-closed'|'in-window'|'out-of-window'|'always-open'
 * }}
 */
function terminalGateStatus(terminal, now = new Date()) {
  const override = terminal?.gateOverride === 'open' || terminal?.gateOverride === 'closed'
    ? terminal.gateOverride : null;
  const openMin = _hhmmToMinutes(terminal?.windowOpen);
  const closeMin = _hhmmToMinutes(terminal?.windowClose);
  const configured = openMin != null && closeMin != null;

  let scheduledOpen = true;
  if (configured) {
    const cur = _wibMinutes(now);
    scheduledOpen = openMin <= closeMin
      ? (cur >= openMin && cur <= closeMin)
      : (cur >= openMin || cur <= closeMin);  // crosses midnight
  }

  const scheduled = {
    configured,
    opensAt: configured ? terminal.windowOpen : '',
    closesAt: configured ? terminal.windowClose : '',
    open: scheduledOpen,
  };

  if (override === 'closed') {
    return { open: false, manualOverride: 'closed', scheduled, reason: 'manual-closed' };
  }
  if (override === 'open') {
    return { open: true, manualOverride: 'open', scheduled, reason: 'manual-open' };
  }
  if (configured) {
    return {
      open: scheduledOpen, manualOverride: null, scheduled,
      reason: scheduledOpen ? 'in-window' : 'out-of-window',
    };
  }
  return { open: true, manualOverride: null, scheduled, reason: 'always-open' };
}

module.exports = { terminalGateStatus, isValidHHMM };
