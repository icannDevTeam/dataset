/**
 * pickup-event-bus.js — In-memory SSE pub/sub for live pickup_events delivery.
 *
 * Phase 1 of the latency optimization plan: replace the iPad's 2.5s polling
 * with a server-pushed SSE stream. This module is the broker shared between
 * the SSE endpoint (subscribers) and the internal-notify endpoint (publisher).
 *
 * Topology:
 *   - Map<tenantId, Set<Subscriber>>
 *   - Subscriber: { res, terminalIds: Set<string>, heartbeat: NodeJS.Timer }
 *   - Per-instance only (Vercel Node runtime) — fan-out via the polling
 *     fallback handles cross-instance gaps. Future: RTDB-backed bus.
 *
 * SSE wire format:
 *   event: pickup_event
 *   data: {"id":"…","status":"pending",…shapeEvent payload…}
 *
 * Heartbeat:
 *   `: keep-alive\n\n` every 25s to keep proxies + Vercel from idling out.
 */

const HEARTBEAT_MS = 25_000;
const SUBSCRIBERS = new Map(); // tenantId -> Set<Subscriber>

function _bucket(tenantId) {
  let set = SUBSCRIBERS.get(tenantId);
  if (!set) { set = new Set(); SUBSCRIBERS.set(tenantId, set); }
  return set;
}

/**
 * Register an SSE subscriber. Returns an unsubscribe function.
 *
 * @param {string} tenantId
 * @param {string[]} terminalIds — only events with terminalId in this set are
 *   forwarded. Empty array = receive everything for the tenant.
 * @param {import('http').ServerResponse} res
 * @returns {() => void} unsubscribe
 */
function subscribe(tenantId, terminalIds, res) {
  const sub = {
    res,
    terminalIds: new Set(terminalIds || []),
    heartbeat: null,
  };
  const bucket = _bucket(tenantId);
  bucket.add(sub);

  sub.heartbeat = setInterval(() => {
    try { res.write(`: keep-alive ${Date.now()}\n\n`); }
    catch { unsubscribe(); }
  }, HEARTBEAT_MS);

  function unsubscribe() {
    if (sub.heartbeat) { clearInterval(sub.heartbeat); sub.heartbeat = null; }
    bucket.delete(sub);
    if (bucket.size === 0) SUBSCRIBERS.delete(tenantId);
    try { res.end(); } catch {}
  }

  res.on('close', unsubscribe);
  res.on('error', unsubscribe);

  return unsubscribe;
}

/**
 * Broadcast a shaped pickup_event payload to all matching subscribers in a
 * tenant. `event.terminalId` (if set) is used to filter; subscribers that
 * declared specific terminalIds only see matching events.
 *
 * @param {string} tenantId
 * @param {object} event — already shaped (same payload as feed.js shapeEvent)
 * @returns {number} number of subscribers the event was written to
 */
function broadcast(tenantId, event) {
  const bucket = SUBSCRIBERS.get(tenantId);
  if (!bucket || bucket.size === 0) return 0;
  const payload = `event: pickup_event\ndata: ${JSON.stringify(event)}\n\n`;
  let delivered = 0;
  for (const sub of bucket) {
    if (sub.terminalIds.size > 0 && event.terminalId && !sub.terminalIds.has(event.terminalId)) {
      continue;
    }
    try { sub.res.write(payload); delivered += 1; }
    catch {
      // Best-effort: dead writes are GC'd via the 'close' handler.
    }
  }
  return delivered;
}

/** Diagnostic: count subscribers per tenant. */
function stats() {
  const out = {};
  for (const [tid, set] of SUBSCRIBERS.entries()) out[tid] = set.size;
  return out;
}

module.exports = { subscribe, broadcast, stats };
