/**
 * GET /api/pickup/tablet/stream
 *
 * Server-Sent Events feed of new pickup_events for the bound release group.
 * Replaces the 2.5s polling in the iPad teacher PWA.
 *
 * Auth: ?deviceToken= (or x-tablet-device-token header)
 *   Same device-token model as /api/pickup/tablet/feed.
 *
 * Wire format: `event: pickup_event\ndata: {…}\n\n`
 *   Payload shape mirrors feed.js shapeEvent() output.
 *
 * Connection lifecycle:
 *   - Initial `: connected` comment so the client knows we're live.
 *   - 25s heartbeats (handled by lib/pickup-event-bus.js).
 *   - Vercel Node functions cap at ~5min duration. The client should
 *     reconnect every ~4min as a watchdog.
 *
 * NOTE: This endpoint does NOT replay missed events. The iPad keeps a 30s
 *   polling fallback as the safety net for both startup hydration and any
 *   gap during reconnect or cross-instance fan-out.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const bus = require('../../../../lib/pickup-event-bus');
const { effectiveGateStatus } = require('../../../../lib/terminal-gate');

// Allow long-lived connections on Vercel Node runtime.
export const config = {
  api: { bodyParser: false, externalResolver: true },
};

const TERMINAL_REF_TTL_MS = 30 * 1000;
const TERMINAL_REF_CACHE = new Map();
const OFF_WINDOW_CACHE_TTL_MS = 60 * 1000;
const OFF_WINDOW_STREAM_CACHE = new Map();
const STREAM_CONTEXT_CACHE_TTL_MS = 30 * 1000;
const STREAM_HEARTBEAT_SECS = 10 * 60 * 1000;
const STREAM_CONTEXT_CACHE = new Map();

function getStreamContextCache(key) {
  const hit = STREAM_CONTEXT_CACHE.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) > STREAM_CONTEXT_CACHE_TTL_MS) {
    STREAM_CONTEXT_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setStreamContextCache(key, value) {
  STREAM_CONTEXT_CACHE.set(key, { at: Date.now(), value });
}

function getOffWindowCache(key) {
  const hit = OFF_WINDOW_STREAM_CACHE.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) > OFF_WINDOW_CACHE_TTL_MS) {
    OFF_WINDOW_STREAM_CACHE.delete(key);
    return null;
  }
  return hit.payload;
}

function setOffWindowCache(key, payload) {
  OFF_WINDOW_STREAM_CACHE.set(key, { at: Date.now(), payload });
}

function summarizeGateSignal(gateStates, inWindow) {
  const reasonCounts = new Map();
  gateStates.forEach((s) => {
    const reason = String(s?.reason || 'unknown');
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  });
  const reasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason]) => reason);
  return {
    source: 'firestore+backend',
    open: !!inWindow,
    reason: reasons[0] || (inWindow ? 'in-window' : 'out-of-window'),
    reasons,
    terminalsEvaluated: gateStates.length,
    evaluatedAt: new Date().toISOString(),
  };
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function collectTerminalRefs(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  return [raw];
}

function terminalAliases(id, data) {
  const out = new Set();
  [
    id,
    data?.terminalId,
    data?.name,
    data?.deviceName,
    data?.ip,
  ].forEach((v) => {
    const s = String(v || '').trim();
    if (s) out.add(s);
  });
  return out;
}

async function resolveGroupTerminalRefs(db, tid, rawRefs) {
  const cacheHit = TERMINAL_REF_CACHE.get(tid);
  const now = Date.now();
  let terminals = cacheHit?.terminals || null;
  if (!terminals || (now - cacheHit.at) > TERMINAL_REF_TTL_MS) {
    const docs = await db.collection(tenancy.terminalsPath(tid)).get();
    terminals = docs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    TERMINAL_REF_CACHE.set(tid, { at: now, terminals });
  }

  const aliasToId = new Map();
  const aliasesById = new Map();
  for (const t of terminals) {
    const aliases = terminalAliases(t.id, t);
    aliasesById.set(t.id, aliases);
    for (const a of aliases) aliasToId.set(normalizeToken(a), t.id);
  }

  const terminalIds = [];
  const terminalIdSet = new Set();
  const terminalKeys = new Set();

  for (const raw of collectTerminalRefs(rawRefs)) {
    const token = String(raw || '').trim();
    if (!token) continue;
    const matchedId = aliasToId.get(normalizeToken(token));
    if (matchedId) {
      if (!terminalIdSet.has(matchedId)) {
        terminalIdSet.add(matchedId);
        terminalIds.push(matchedId);
      }
      for (const k of aliasesById.get(matchedId) || []) terminalKeys.add(k);
    } else {
      terminalKeys.add(token);
    }
  }

  if (terminalIds.length === 0) {
    for (const raw of collectTerminalRefs(rawRefs)) {
      const token = String(raw || '').trim();
      if (!token || terminalIdSet.has(token)) continue;
      terminalIdSet.add(token);
      terminalIds.push(token);
      terminalKeys.add(token);
    }
  }

  return { terminalIds, terminalKeys: [...terminalKeys] };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method' }); return; }
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) { res.status(401).json({ error: 'deviceToken required' }); return; }
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const tokenKey = `${tid}:${String(token)}`;

  const cachedClosed = getOffWindowCache(tokenKey);
  if (cachedClosed) {
    res.status(200).json(cachedClosed);
    return;
  }

  let terminalIds = [], terminalKeys = [], gradeScopes = [], releaseGroupId = null;
  let gateSignal = null;
  let dev = null;
  let devData = null;
  try {
    initializeFirebase();
    const db = admin.firestore();
    const cachedCtx = getStreamContextCache(tokenKey);
    let group = null;
    let pickupSettings = null;
    if (cachedCtx) {
      ({ releaseGroupId, terminalIds, terminalKeys, gradeScopes, group, pickupSettings } = cachedCtx);
    } else {
      const devSnap = await db.collection(tenancy.tabletDevicesPath(tid))
        .where('deviceToken', '==', String(token))
        .limit(1).get();
      if (devSnap.empty) { res.status(401).json({ error: 'unknown token' }); return; }
      dev = devSnap.docs[0];
      devData = dev.data();
      if (devData.status !== 'paired') { res.status(401).json({ error: 'not paired' }); return; }

      releaseGroupId = devData.releaseGroupId;
      let groupSnap = releaseGroupId ? await db.doc(tenancy.releaseGroupDoc(releaseGroupId, tid)).get() : null;
      if (!groupSnap?.exists) {
        const candidates = ['tabletDeviceId', 'tabletId', 'pairedTabletDeviceId', 'deviceId'];
        let recovered = null;
        for (const field of candidates) {
          try {
            const snap = await db.collection(tenancy.releaseGroupsPath(tid))
              .where(field, '==', dev.id)
              .limit(1)
              .get();
            if (!snap.empty) {
              recovered = snap.docs[0];
              break;
            }
          } catch {}
        }
        if (recovered) {
          groupSnap = recovered;
          releaseGroupId = recovered.id;
          dev.ref.set({ releaseGroupId }, { merge: true }).catch(() => {});
        }
      }
      if (!releaseGroupId) { res.status(409).json({ error: 'no release group bound' }); return; }
      if (!groupSnap?.exists) { res.status(404).json({ error: 'release group not found' }); return; }
      group = groupSnap.data();
      const resolvedRefs = await resolveGroupTerminalRefs(db, tid, group.terminalIds);
      terminalIds = resolvedRefs.terminalIds;
      terminalKeys = resolvedRefs.terminalKeys;
      const pickupSettingsSnap = await db.doc(tenancy.pickupSettingsDoc(tid)).get().catch(() => null);
      pickupSettings = pickupSettingsSnap?.exists ? (pickupSettingsSnap.data() || {}) : {};
    }

    // Union of the group's terminal gradeScopes — lets the bus drop
    // wrong-gate cards (e.g. EY parent at a Grade 4/5 pole).
    if (terminalIds.length > 0) {
      try {
        const termSnaps = await db.getAll(
          ...terminalIds.slice(0, 30).map((tidx) => db.doc(tenancy.terminalDoc(tidx, tid)))
        );
        const terminalDocs = termSnaps.filter((s) => s.exists).map((s) => ({ id: s.id, ...(s.data() || {}) }));
        const gateStates = terminalDocs
          .map((t) => effectiveGateStatus(t, group, new Date(), pickupSettings));
        const inWindow = gateStates.some((s) => !!s.open);
        gateSignal = summarizeGateSignal(gateStates, inWindow);
        if (!inWindow) {
          const closedPayload = { ok: false, inWindow: false, gateSignal };
          setOffWindowCache(tokenKey, closedPayload);
          res.status(200).json(closedPayload);
          return;
        }
        OFF_WINDOW_STREAM_CACHE.delete(tokenKey);
        const set = new Set();
        termSnaps.forEach((s) => {
          if (!s.exists) return;
          const sc = (s.data() || {}).gradeScopes;
          if (Array.isArray(sc)) sc.forEach((g) => { const v = String(g).trim().toUpperCase(); if (v) set.add(v); });
        });
        gradeScopes = [...set];
        setStreamContextCache(tokenKey, { releaseGroupId, terminalIds, terminalKeys, gradeScopes, group, pickupSettings });
      } catch {
        gradeScopes = [];
      }
    } else {
      gateSignal = {
        source: 'firestore+backend',
        open: false,
        reason: 'no-terminals',
        reasons: ['no-terminals'],
        terminalsEvaluated: 0,
        evaluatedAt: new Date().toISOString(),
      };
      const closedPayload = { ok: false, inWindow: false, gateSignal };
      setOffWindowCache(tokenKey, closedPayload);
      res.status(200).json(closedPayload);
      return;
    }

    // Touch lastSeenAt sparingly to reduce write burn from reconnect loops.
    if (!dev) {
      const devSnap = await db.collection(tenancy.tabletDevicesPath(tid))
        .where('deviceToken', '==', String(token))
        .limit(1).get();
      dev = devSnap.empty ? null : devSnap.docs[0];
      devData = dev?.data() || null;
    }
    const lastSeenMs = devData?.lastSeenAt?.toMillis ? devData.lastSeenAt.toMillis() : 0;
    if (dev && (Date.now() - lastSeenMs > STREAM_HEARTBEAT_SECS)) {
      dev.ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    }
  } catch (e) {
    console.error('[pickup/tablet/stream auth]', e.message);
    res.status(500).json({ error: 'internal', message: e.message });
    return;
  }

  // Open the SSE stream.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering if proxied
  });
  res.write(`: connected ${new Date().toISOString()}\n\n`);
  // Some clients (and Vercel's edge) won't flush until a meaningful event
  // arrives — send a small event so the EventSource transitions to OPEN.
  res.write(`event: hello\ndata: ${JSON.stringify({ tenantId: tid, terminalIds, gateSignal })}\n\n`);

  bus.subscribe(tid, terminalKeys, res, gradeScopes, releaseGroupId);
}
