/**
 * Minimal 5-field cron parser. Supports asterisk, step (slash-N),
 * comma-lists, ranges, and numeric literals. Used by the scheduled-
 * reports cron route to compute nextRunAt for saved presets. Not a
 * full RFC implementation — covers only the patterns the preset UI
 * can produce (every-15-min, daily, weekly, monthly, every-6h).
 *
 * All times are interpreted in UTC. Operators wanting local-time
 * schedules should convert before storing.
 */

function parseField(token, min, max) {
  const allowed = new Set();
  for (const part of String(token).split(',')) {
    const [base, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`bad_cron_step:${token}`);
    let from = min, to = max;
    if (base !== '*') {
      if (base.includes('-')) {
        const [a, b] = base.split('-').map((n) => parseInt(n, 10));
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`bad_cron_range:${token}`);
        from = a; to = b;
      } else {
        const n = parseInt(base, 10);
        if (!Number.isFinite(n)) throw new Error(`bad_cron_value:${token}`);
        from = n; to = n;
      }
    }
    for (let v = from; v <= to; v += step) {
      if (v >= min && v <= max) allowed.add(v);
    }
  }
  return allowed;
}

/** Validate cron expression. Throws on invalid input. Returns parsed fields. */
function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron_must_have_5_fields');
  const [m, h, dom, mon, dow] = parts;
  return {
    minute:     parseField(m,   0, 59),
    hour:       parseField(h,   0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month:      parseField(mon, 1, 12),
    dayOfWeek:  parseField(dow, 0, 6),   // 0 = Sunday
    expr,
  };
}

/**
 * Compute the next firing time strictly AFTER `from` (a Date) for `expr`.
 * Returns a JS Date in UTC, or null if no match within 366 days (a guard
 * against pathological expressions like `0 0 31 2 *`).
 */
function nextCronAt(expr, from = new Date()) {
  const fields = parseCron(expr);
  // Start from the next whole minute after `from`.
  let d = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    from.getUTCHours(), from.getUTCMinutes() + 1, 0, 0,
  ));
  const limit = new Date(d.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (d <= limit) {
    if (!fields.month.has(d.getUTCMonth() + 1)) {
      // jump to first of next month
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
      continue;
    }
    if (!fields.dayOfMonth.has(d.getUTCDate()) || !fields.dayOfWeek.has(d.getUTCDay())) {
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
      continue;
    }
    if (!fields.hour.has(d.getUTCHours())) {
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0, 0));
      continue;
    }
    if (!fields.minute.has(d.getUTCMinutes())) {
      d = new Date(d.getTime() + 60 * 1000);
      continue;
    }
    return d;
  }
  return null;
}

module.exports = { parseCron, nextCronAt };
