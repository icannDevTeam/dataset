/**
 * pickup-event-bus.js — Firestore-backed SSE pub/sub for live pickup_events.
 *
 * Replaces the old HTTP-fed in-memory bus (which required INTERNAL_NOTIFY_URL
 * to be set in prod — it never was, so iPads always fell back to polling).
 *
 * Topology:
 *   - Map<tenantId, Set<Subscriber>>
 *   - Map<tenantId, FirestoreListener>  (one live snapshot per tenant)
 *   - Subscriber: { res, terminalIds: Set<string>, heartbeat: Timer }
 *   - First subscriber for a tenant starts the onSnapshot.
 *   - Last subscriber leaving detaches it.
 *
 * SSE wire format:
 *   event: pickup_event
 *   data: {…shapePickupEvent payload…}
 *
 * Heartbeat: `: keep-alive\n\n` every 25s.
 *
 * NOTE: per-instance only. On Vercel serverless, each lambda has its own
 *   bus + its own snapshot. iPads on different lambdas all converge because
 *   each lambda runs its own Firestore listener.
 */

const admin = require('firebase-admin');
const { initializeFirebase, getFirebaseStorage } = require('./firebase-admin');
const tenancy = require('./tenancy');
const { shapePickupEvent, prewarmSession } = require('./shape-pickup-event');

const HEARTBEAT_MS = 25_000;
const LISTENER_LOOKBACK_MS = 60_000;  // include events from the last 60s on a fresh listener
const PREWARM_INTERVAL_MS  = 4 * 60_000; // re-warm before 5-min signed URL TTL expires

const SUBSCRIBERS = new Map();   // tenantId -> Set<Subscriber>
const LISTENERS  = new Map();    // tenantId -> { unsubscribe, startMs }
const PREWARMERS = new Map();    // tenantId -> intervalId

function _bucket(tenantId) {
  let set = SUBSCRIBERS.get(tenantId);
  if (!set) { set = new Set(); SUBSCRIBERS.set(tenantId, set); }
  return set;
}

function _ensureListener(tenantId) {
  if (LISTENERS.has(tenantId)) return;
  try {
    initializeFirebase();
    const db = admin.firestore();
    const storageBucket = getFirebaseStorage().bucket();
    const startMs = Date.now() - LISTENER_LOOKBACK_MS;
    const startTs = admin.firestore.Timestamp.fromMillis(startMs);

    // Pre-warm caches immediately and then every 4 min to keep URLs fresh.
    prewarmSession(db, storageBucket, tenantId);
    const prewarmTimer = setInterval(
      () => prewarmSession(db, storageBucket, tenantId),
      PREWARM_INTERVAL_MS
    );
    PREWARMERS.set(tenantId, prewarmTimer);

    const q = db.collection(tenancy.pickupEventsPath(tenantId))
      .where('recordedAt', '>', startTs);

    const unsubscribe = q.onSnapshot(async (snap) => {
      const added = snap.docChanges().filter((c) => c.type === 'added');
      if (added.length === 0) return;
      for (const change of added) {
        try {
          const shaped = await shapePickupEvent(storageBucket, tenantId, change.doc);
          _broadcast(tenantId, shaped);
        } catch (e) {
          console.error('[pickup-event-bus shape]', tenantId, e.message);
        }
      }
    }, (err) => {
      console.error('[pickup-event-bus listener]', tenantId, err.message);
      const entry = LISTENERS.get(tenantId);
      if (entry) { try { entry.unsubscribe(); } catch {} ; LISTENERS.delete(tenantId); }
    });

    LISTENERS.set(tenantId, { unsubscribe, startMs });
  } catch (e) {
    console.error('[pickup-event-bus ensureListener]', tenantId, e.message);
  }
}

function _maybeReleaseListener(tenantId) {
  const bucket = SUBSCRIBERS.get(tenantId);
  if (bucket && bucket.size > 0) return;
  const entry = LISTENERS.get(tenantId);
  if (!entry) return;
  try { entry.unsubscribe(); } catch {}
  LISTENERS.delete(tenantId);
  const prewarmTimer = PREWARMERS.get(tenantId);
  if (prewarmTimer) { clearInterval(prewarmTimer); PREWARMERS.delete(tenantId); }
}

function _broadcast(tenantId, event) {
  const bucket = SUBSCRIBERS.get(tenantId);
  if (!bucket || bucket.size === 0) return 0;
  const payload = `event: pickup_event\ndata: ${JSON.stringify(event)}\n\n`;
  let delivered = 0;
  for (const sub of bucket) {
    if (sub.terminalIds.size > 0 && event.terminalId && !sub.terminalIds.has(event.terminalId)) {
      continue;
    }
    try { sub.res.write(payload); delivered += 1; }
    catch { /* dead writes GC'd via 'close' handler */ }
  }
  return delivered;
}

/**
 * Register an SSE subscriber. Returns an unsubscribe function.
 *
 * @param {string} tenantId
 * @param {string[]} terminalIds — only events matching these are forwarded.
 *   Empty array = receive everything for the tenant.
 * @param {import('http').ServerResponse} res
 * @returns {() => void}
 */
function subscribe(tenantId, terminalIds, res) {
  const sub = {
    res,
    terminalIds: new Set(terminalIds || []),
    heartbeat: null,
  };
  const bucket = _bucket(tenantId);
  bucket.add(sub);
  _ensureListener(tenantId);

  sub.heartbeat = setInterval(() => {
    try { res.write(`: keep-alive ${Date.now()}\n\n`); }
    catch { unsubscribe(); }
  }, HEARTBEAT_MS);

  function unsubscribe() {
    if (sub.heartbeat) { clearInterval(sub.heartbeat); sub.heartbeat = null; }
    bucket.delete(sub);
    if (bucket.size === 0) SUBSCRIBERS.delete(tenantId);
    _maybeReleaseListener(tenantId);
    try { res.end(); } catch {}
  }

  res.on('close', unsubscribe);
  res.on('error', unsubscribe);

  return unsubscribe;
}

/** Diagnostic: counts per tenant. */
function stats() {
  const out = {};
  for (const [tid, set] of SUBSCRIBERS.entries()) {
    out[tid] = { subscribers: set.size, listener: LISTENERS.has(tid) };
  }
  return out;
}

module.exports = { subscribe, stats };
