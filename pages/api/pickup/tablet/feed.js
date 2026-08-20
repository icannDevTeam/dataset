/**
 * GET /api/pickup/tablet/feed
 *
 * Token-authenticated feed for the iPad teacher app. Returns pickup_events
 * scoped to the bound release group's terminalIds.
 *
 * Auth:  x-tablet-device-token header (or ?deviceToken=)
 * Query: ?since=ISO  ?max=12 (active limit)
 *
 * Response:
 *   {
 *     ok, now, releaseGroup: { id, name, gradeLabel, terminalIds },
 *     active:  [...],   // status='pending', up to maxActive (default 12)
 *     held:    [...],   // status='held'
 *   }
 *
 * Card shape mirrors /api/pickup/teacher/feed for shared UI components.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { effectiveGateStatus } = require('../../../../lib/terminal-gate');
const { shapePickupEvent, SILENT_ON_IPAD, eventMatchesScopes } = require('../../../../lib/shape-pickup-event');

const WINDOW_MS = 30 * 60 * 1000;
const TERMINAL_REF_TTL_MS = 30 * 1000;
const TERMINAL_REF_CACHE = new Map();
const OFF_WINDOW_CACHE_TTL_MS = 60 * 1000;
const OFF_WINDOW_FEED_CACHE = new Map();
const FEED_CONTEXT_CACHE_TTL_MS = 30 * 1000;
const FEED_HEARTBEAT_SECS = 10 * 60 * 1000;
const FEED_CONTEXT_CACHE = new Map();

function getFeedContextCache(key) {
  const hit = FEED_CONTEXT_CACHE.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) > FEED_CONTEXT_CACHE_TTL_MS) {
    FEED_CONTEXT_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setFeedContextCache(key, value) {
  FEED_CONTEXT_CACHE.set(key, { at: Date.now(), value });
}

function getOffWindowCache(key) {
  const hit = OFF_WINDOW_FEED_CACHE.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) > OFF_WINDOW_CACHE_TTL_MS) {
    OFF_WINDOW_FEED_CACHE.delete(key);
    return null;
  }
  return hit.payload;
}

function setOffWindowCache(key, payload) {
  OFF_WINDOW_FEED_CACHE.set(key, { at: Date.now(), payload });
}

function toIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v?.toDate) { try { return v.toDate().toISOString(); } catch { return null; } }
  try { return new Date(v).toISOString(); } catch { return null; }
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
  const unmatchedKeys = new Set();

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
      unmatchedKeys.add(token);
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

  // queryKeys: what we actually query pickup_events.terminalId against.
  // Events stamp the CANONICAL registry id (verified 2026-08-05: 97% canonical,
  // rest are stale deleted-terminal ids that arrive via unmatched refs), so
  // querying every alias (name/ip/deviceName) just multiplied reads ~5x.
  const queryKeys = [...new Set([...terminalIds, ...unmatchedKeys])];

  return { terminalIds, terminalKeys: [...terminalKeys], queryKeys };
}

function hhmmToMinutes(s) {
  if (!s || typeof s !== 'string') return null;
  const [h, m] = s.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return (h * 60) + m;
}

function summarizeWindow(gateStates) {
  const windows = gateStates
    .map((s) => ({
      open: s?.scheduled?.opensAt || null,
      close: s?.scheduled?.closesAt || null,
    }))
    .filter((w) => w.open && w.close);
  if (windows.length === 0) return { windowOpen: null, windowClose: null };

  const starts = windows
    .map((w) => hhmmToMinutes(w.open))
    .filter((v) => Number.isInteger(v));
  const closes = windows
    .map((w) => hhmmToMinutes(w.close))
    .filter((v) => Number.isInteger(v));
  if (!starts.length || !closes.length) return { windowOpen: null, windowClose: null };

  const minStart = Math.min(...starts);
  const maxClose = Math.max(...closes);
  const fmt = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  return { windowOpen: fmt(minStart), windowClose: fmt(maxClose) };
}

function summarizeGateSignal(gateStates, inWindow, windowOpen, windowClose) {
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
    windowOpen: windowOpen || null,
    windowClose: windowClose || null,
    evaluatedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) return res.status(401).json({ error: 'deviceToken required' });
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const tokenKey = `${tid}:${String(token)}`;

  const cachedClosed = getOffWindowCache(tokenKey);
  if (cachedClosed) {
    return res.status(200).json({
      ...cachedClosed,
      now: new Date().toISOString(),
    });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();
    let dev = null;
    let devData = null;
    let releaseGroupId = null;
    let group = null;
    let terminalIds = [];
    let queryKeys = [];

    const cachedCtx = getFeedContextCache(tokenKey);
    if (cachedCtx) {
      ({ releaseGroupId, group, terminalIds, queryKeys } = cachedCtx);
    } else {
      // Resolve device -> release group -> terminalIds.
      const devSnap = await db.collection(tenancy.tabletDevicesPath(tid))
        .where('deviceToken', '==', String(token))
        .limit(1).get();
      if (devSnap.empty) return res.status(401).json({ error: 'unknown token' });
      dev = devSnap.docs[0];
      devData = dev.data();
      if (devData.status !== 'paired') return res.status(401).json({ error: 'not paired' });

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
      if (!releaseGroupId) return res.status(409).json({ error: 'no release group bound' });
      if (!groupSnap?.exists) return res.status(404).json({ error: 'release group not found' });
      group = groupSnap.data();
      const resolvedRefs = await resolveGroupTerminalRefs(db, tid, group.terminalIds);
      terminalIds = resolvedRefs.terminalIds;
      queryKeys = resolvedRefs.queryKeys;
      setFeedContextCache(tokenKey, { releaseGroupId, group, terminalIds, queryKeys });
    }
    if (terminalIds.length === 0) {
      const gateSignal = {
        source: 'firestore+backend',
        open: false,
        reason: 'no-terminals',
        reasons: ['no-terminals'],
        terminalsEvaluated: 0,
        windowOpen: null,
        windowClose: null,
        evaluatedAt: new Date().toISOString(),
      };
      const closedPayload = {
        ok: true,
        inWindow: false,
        windowOpen: null,
        windowClose: null,
        gateSignal,
        releaseGroup: { id: releaseGroupId, name: group.name, gradeLabel: group.gradeLabel, terminalIds: [] },
        active: [],
        held: [],
        todayReleased: 0,
      };
      setOffWindowCache(tokenKey, closedPayload);
      return res.status(200).json({ ...closedPayload, now: new Date().toISOString() });
    }

    // Touch lastSeenAt sparingly to reduce write burn from polling tablets.
    if (!dev) {
      const devSnap = await db.collection(tenancy.tabletDevicesPath(tid))
        .where('deviceToken', '==', String(token))
        .limit(1).get();
      dev = devSnap.empty ? null : devSnap.docs[0];
      devData = dev?.data() || null;
    }
    const lastSeenMs = devData?.lastSeenAt?.toMillis ? devData.lastSeenAt.toMillis() : 0;
    if (dev && (Date.now() - lastSeenMs > FEED_HEARTBEAT_SECS)) {
      dev.ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    }

    const pickupSettingsSnap = await db.doc(tenancy.pickupSettingsDoc(tid)).get().catch(() => null);
    const pickupSettings = pickupSettingsSnap?.exists ? (pickupSettingsSnap.data() || {}) : {};

    // Union of gradeScopes across the group's terminals — used to hide
    // wrong-gate cards (e.g. EY parent scanning at a Grade 4/5 pole) even if
    // the edge writer didn't stamp decision='wrong_terminal'.
    let terminalDocs = [];
    let groupScopes = new Set();
    try {
      const termSnaps = await db.getAll(
        ...terminalIds.slice(0, 30).map((tidx) => db.doc(tenancy.terminalDoc(tidx, tid)))
      );
      terminalDocs = termSnaps.filter((s) => s.exists).map((s) => ({ id: s.id, ...(s.data() || {}) }));
      termSnaps.forEach((s) => {
        if (!s.exists) return;
        const sc = (s.data() || {}).gradeScopes;
        if (Array.isArray(sc)) sc.forEach((g) => { const v = String(g).trim().toUpperCase(); if (v) groupScopes.add(v); });
      });
    } catch {
      groupScopes = new Set();
      terminalDocs = [];
    }

    const gateStates = terminalDocs.map((t) => effectiveGateStatus(t, group, new Date(), pickupSettings));
    const inWindow = gateStates.length > 0 ? gateStates.some((s) => !!s.open) : false;
    const { windowOpen, windowClose } = summarizeWindow(gateStates);
    const gateSignal = summarizeGateSignal(gateStates, inWindow, windowOpen, windowClose);
    if (!inWindow) {
      const closedPayload = {
        ok: true,
        inWindow: false,
        windowOpen,
        windowClose,
        gateSignal,
        releaseGroup: {
          id: releaseGroupId,
          name: group.name,
          gradeLabel: group.gradeLabel,
          terminalIds,
        },
        active: [],
        held: [],
        todayReleased: 0,
      };
      setOffWindowCache(tokenKey, closedPayload);
      return res.status(200).json({ ...closedPayload, now: new Date().toISOString() });
    }
    OFF_WINDOW_FEED_CACHE.delete(tokenKey);

    const sinceMs = req.query.since ? new Date(String(req.query.since)).getTime() : null;
    const wibNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const wibStartUtcMs = Date.UTC(
      wibNow.getUTCFullYear(),
      wibNow.getUTCMonth(),
      wibNow.getUTCDate(),
      0, 0, 0, 0,
    ) - (7 * 60 * 60 * 1000);
    // Hydrate from start-of-day WIB so already-scanned chaperones still show
    // during active dismissal windows (e.g. Friday early release), even when
    // there was no new scan in the last 30 minutes.
    const cutoffMs = sinceMs && !Number.isNaN(sinceMs)
      ? Math.max(sinceMs, wibStartUtcMs, Date.now() - WINDOW_MS)
      : wibStartUtcMs;

    // Push the time filter into Firestore so we only read today's docs
    // instead of fetching a large chunk and discarding in memory.
    // The (terminalId, recordedAt) and (releaseGroupId, recordedAt) composite
    // indexes already exist to support the orderBy — the range clause reuses them.
    const cutoffTs = admin.firestore.Timestamp.fromMillis(cutoffMs);

    const fetchTerminalDocs = async (tidx) => {
      try {
        return await db.collection(tenancy.pickupEventsPath(tid))
          .where('terminalId', '==', tidx)
          .where('recordedAt', '>=', cutoffTs)
          .orderBy('recordedAt', 'desc')
          .limit(25).get();
      } catch (e) {
        // Composite index might not exist yet on older tenants — fall back
        // without the time range so the feed still works.
        try {
          return await db.collection(tenancy.pickupEventsPath(tid))
            .where('terminalId', '==', tidx)
            .orderBy('recordedAt', 'desc')
            .limit(25).get();
        } catch {
          return db.collection(tenancy.pickupEventsPath(tid))
            .where('terminalId', '==', tidx)
            .limit(25).get();
        }
      }
    };

    const perTerm = await Promise.all(
      queryKeys.slice(0, 10).map((tidx) => fetchTerminalDocs(tidx))
    );
    const releaseGroupDocs = await (async () => {
      try {
        return await db.collection(tenancy.pickupEventsPath(tid))
          .where('releaseGroupId', '==', releaseGroupId)
          .where('recordedAt', '>=', cutoffTs)
          .orderBy('recordedAt', 'desc')
          .limit(40)
          .get();
      } catch {
        try {
          return await db.collection(tenancy.pickupEventsPath(tid))
            .where('releaseGroupId', '==', releaseGroupId)
            .orderBy('recordedAt', 'desc')
            .limit(40)
            .get();
        } catch {
          try {
            return await db.collection(tenancy.pickupEventsPath(tid))
              .where('releaseGroupId', '==', releaseGroupId)
              .limit(40)
              .get();
          } catch {
            return { docs: [] };
          }
        }
      }
    })();
    const recordedMs = (d) => {
      const v = d.data().recordedAt;
      if (!v) return 0;
      if (typeof v.toMillis === 'function') return v.toMillis();
      if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; }
      if (v instanceof Date) return v.getTime();
      return 0;
    };
    const byId = new Map();
    [...perTerm.flatMap((s) => s.docs), ...(releaseGroupDocs.docs || [])].forEach((d) => {
      if (recordedMs(d) <= cutoffMs) return;
      byId.set(d.id, d);
    });
    const allDocs = [...byId.values()];
    allDocs.sort((a, b) => recordedMs(b) - recordedMs(a));
    const snap = { docs: allDocs.slice(0, 80) };

    const maxActive = Math.max(1, Math.min(12, parseInt(req.query.max, 10) || 12));
    const active = [];
    const held = [];
    let todayReleased = 0;
    const todayStartMs = (() => {
      // Local-day start in UTC+7 (WIB)
      const now = new Date(Date.now() + 7 * 3600 * 1000);
      const ymd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return ymd - 7 * 3600 * 1000;
    })();
    // Decisions written for audit but never shown on the iPad.
    // Keeps the screen quiet for: parents at the wrong gate, randoms with
    // out-of-system Hikvision enrolments, and out-of-window scans.
    for (const doc of snap.docs) {
      const data = doc.data();
      const status = data.status || 'pending';
      if (SILENT_ON_IPAD.has(data.decision)) continue;
      if (!eventMatchesScopes(data, groupScopes)) continue; // wrong-gate: EY parent at a Grade 4/5 pole etc.
      if (status === 'pending' && active.length < 50) {
        active.push(doc);
      } else if (status === 'held') {
        held.push(doc);
      } else if (status === 'released') {
        const releasedAt = data.teacherRelease?.at?.toMillis ? data.teacherRelease.at.toMillis()
          : (data.recordedAt?.toMillis ? data.recordedAt.toMillis() : 0);
        if (releasedAt >= todayStartMs) todayReleased++;
      }
    }
    // active is desc-by-recordedAt; show oldest unresolved first (FIFO).
    active.reverse();
    const activeShown = active.slice(0, maxActive);

    const [activeOut, heldOut] = await Promise.all([
      Promise.all(activeShown.map((d) => shapePickupEvent(bucket, tid, d))),
      Promise.all(held.map((d) => shapePickupEvent(bucket, tid, d))),
    ]);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      ok: true,
      inWindow: true,
      now: new Date().toISOString(),
      windowOpen,
      windowClose,
      gateSignal,
      releaseGroup: {
        id: releaseGroupId,
        name: group.name,
        gradeLabel: group.gradeLabel,
        terminalIds,
      },
      active: activeOut,
      held: heldOut,
      todayReleased,
    });
  } catch (e) {
    console.error('[pickup/tablet/feed]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
