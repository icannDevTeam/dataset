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

/**
 * Date in Asia/Jakarta as 'YYYY-MM-DD' — used to key per-day overrides.
 */
function wibDateKey(d = new Date()) {
  const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const y = wib.getUTCFullYear();
  const m = String(wib.getUTCMonth() + 1).padStart(2, '0');
  const day = String(wib.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Weekday key in Asia/Jakarta ('mon'…'sun') — used for recurring windows.
 */
function wibWeekdayKey(d = new Date()) {
  const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return WEEKDAY_KEYS[wib.getUTCDay()];
}

/**
 * Recurring day-of-week window from pickup settings, or null.
 * Shape: settings.pickupWindowByDay = { fri: { start:'11:30', end:'17:30' } }
 */
function weeklyWindowFor(settings, now = new Date()) {
  const byDay = settings?.pickupWindowByDay;
  if (!byDay || typeof byDay !== 'object') return null;
  const w = byDay[wibWeekdayKey(now)];
  if (!w) return null;
  const open = w.start || w.open;
  const close = w.end || w.close;
  if (!isValidHHMM(open) || !isValidHHMM(close)) return null;
  return { open, close };
}

/**
 * Like `terminalGateStatus` but applies (highest first):
 *   1. the release group's one-off `pickupOverrides` for today's WIB date
 *   2. the tenant's recurring `pickupWindowByDay` weekly window (e.g. Friday
 *      11:30 early dismissal) from pickup settings
 *   3. the terminal's daily window
 *
 * @param {object} terminal — terminal doc data
 * @param {object|null} group — release group doc data (or null)
 * @param {Date} [now]
 * @param {object|null} [settings] — tenants/{t}/settings/pickup doc data
 */
function effectiveGateStatus(terminal, group, now = new Date(), settings = null) {
  const overrides = Array.isArray(group?.pickupOverrides) ? group.pickupOverrides : [];
  if (overrides.length) {
    const today = wibDateKey(now);
    const ov = overrides.find((o) => o && o.date === today);
    if (ov) {
      if (ov.closedAllDay) {
        return {
          open: false, manualOverride: null,
          scheduled: { configured: true, opensAt: '', closesAt: '', open: false },
          reason: 'override-closed-all-day',
          override: { date: ov.date, closedAllDay: true, note: ov.note || null },
        };
      }
      // Build a synthetic terminal that uses the override window.
      const synthetic = {
        ...terminal,
        windowOpen: ov.open || terminal?.windowOpen,
        windowClose: ov.close || terminal?.windowClose,
      };
      const base = terminalGateStatus(synthetic, now);
      return {
        ...base,
        reason: base.reason === 'in-window' ? 'override-in-window' : 'override-out-of-window',
        override: { date: ov.date, open: ov.open, close: ov.close, note: ov.note || null },
      };
    }
  }
  const weekly = weeklyWindowFor(settings, now);
  if (weekly) {
    const synthetic = {
      ...terminal,
      windowOpen: weekly.open,
      windowClose: weekly.close,
    };
    const base = terminalGateStatus(synthetic, now);
    return {
      ...base,
      reason: base.reason === 'in-window' ? 'weekly-in-window' : (base.reason === 'out-of-window' ? 'weekly-out-of-window' : base.reason),
      override: { weekday: wibWeekdayKey(now), open: weekly.open, close: weekly.close, recurring: true },
    };
  }
  return terminalGateStatus(terminal, now);
}

module.exports = { terminalGateStatus, effectiveGateStatus, isValidHHMM, wibDateKey, wibWeekdayKey, weeklyWindowFor };
