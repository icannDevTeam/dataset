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

// Allow long-lived connections on Vercel Node runtime.
export const config = {
  api: { bodyParser: false, externalResolver: true },
};

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method' }); return; }
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) { res.status(401).json({ error: 'deviceToken required' }); return; }

  let tid, terminalIds = [], gradeScopes = [], releaseGroupId = null;
  try {
    initializeFirebase();
    const db = admin.firestore();
    tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

    const devSnap = await db.collection(tenancy.tabletDevicesPath(tid))
      .where('deviceToken', '==', String(token))
      .limit(1).get();
    if (devSnap.empty) { res.status(401).json({ error: 'unknown token' }); return; }
    const dev = devSnap.docs[0];
    const devData = dev.data();
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
    const group = groupSnap.data();
    terminalIds = Array.isArray(group.terminalIds) ? group.terminalIds : [];

    // Union of the group's terminal gradeScopes — lets the bus drop
    // wrong-gate cards (e.g. EY parent at a Grade 4/5 pole).
    if (terminalIds.length > 0) {
      try {
        const termSnaps = await db.getAll(
          ...terminalIds.slice(0, 30).map((tidx) => db.doc(tenancy.terminalDoc(tidx, tid)))
        );
        const set = new Set();
        termSnaps.forEach((s) => {
          if (!s.exists) return;
          const sc = (s.data() || {}).gradeScopes;
          if (Array.isArray(sc)) sc.forEach((g) => { const v = String(g).trim().toUpperCase(); if (v) set.add(v); });
        });
        gradeScopes = [...set];
      } catch { gradeScopes = []; }
    }

    // Touch lastSeenAt (best-effort, non-blocking).
    dev.ref.set({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
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
  res.write(`event: hello\ndata: ${JSON.stringify({ tenantId: tid, terminalIds })}\n\n`);

  bus.subscribe(tid, terminalIds, res, gradeScopes, releaseGroupId);
}
