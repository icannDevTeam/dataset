/**
 * GET /api/pickup/admin/admin-event-stream
 *
 * Server-Sent Events feed of live pickup_events for the admin monitoring
 * dashboard. Unlike /api/pickup/tablet/stream (which requires a device token),
 * this endpoint uses the standard admin session auth (withApi / Bearer token).
 *
 * Wire format:
 *   event: pickup_event
 *   data: { id, gate, chaperoneId, studentName, cardState, confidence,
 *            officerOverride, recordedAt, terminalId }
 *
 *   event: heartbeat
 *   data: { ts: ISO }
 *
 * Connection lifecycle:
 *   - `: connected` comment on open
 *   - 25s heartbeat
 *   - Client should reconnect after 4 minutes (Vercel function timeout)
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { verifyCookie } = require('../../../../lib/session-cookie');

// Allow long-lived connections
export const config = {
  api: { bodyParser: false, externalResolver: true },
};

const HEARTBEAT_MS = 25_000;
const LOOKBACK_MS  = 60_000;

function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}

function shapeEvent(doc) {
  const e = doc.data();
  const ts = e.recordedAt?.toDate?.() || (typeof e.recordedAt === 'string' ? new Date(e.recordedAt) : null);
  return {
    id: doc.id,
    gate: e.gate || e.deviceName || 'Unknown',
    terminalId: e.terminalId || null,
    chaperoneId: e.chaperoneId || null,
    chaperoneName: e.chaperoneName || null,
    studentName: e.studentName || null,
    cardState: (e.cardState || 'green').toLowerCase(),
    confidence: e.confidence != null ? Math.round(e.confidence * 100) : null,
    officerOverride: !!e.officerOverride,
    spoofDetected: !!e.spoofDetected,
    recordedAt: ts ? ts.toISOString() : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }

  // Auth: accept session cookie or Bearer token (same as withApi)
  const cookie = req.cookies?.__session;
  const bearer = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const apiKey = process.env.DASHBOARD_API_KEY || '';

  const cookieOk = cookie && verifyCookie(cookie) !== null;
  const bearerOk = bearer && apiKey && bearer === apiKey;
  if (!cookieOk && !bearerOk) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const lookbackTs = admin.firestore.Timestamp.fromMillis(Date.now() - LOOKBACK_MS);
    let initialized = false;

    const unsubscribe = db.collection(tenancy.pickupEventsPath(tid))
      .where('recordedAt', '>=', lookbackTs)
      .orderBy('recordedAt', 'desc')
      .limit(50)
      .onSnapshot(
        (snap) => {
          if (!initialized) {
            initialized = true;
            // Send the most recent event on connect (UI context)
            if (!snap.empty) {
              sendEvent(res, 'pickup_event', shapeEvent(snap.docs[0]));
            }
            return;
          }
          snap.docChanges().forEach((change) => {
            if (change.type === 'added') {
              sendEvent(res, 'pickup_event', shapeEvent(change.doc));
            }
          });
        },
        (err) => {
          console.error('[admin-event-stream] Firestore error:', err.message);
          try { res.end(); } catch { /* already closed */ }
        },
      );

    // Heartbeat
    const hbInterval = setInterval(() => {
      try {
        sendEvent(res, 'heartbeat', { ts: new Date().toISOString() });
      } catch {
        clearInterval(hbInterval);
        unsubscribe();
      }
    }, HEARTBEAT_MS);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(hbInterval);
      unsubscribe();
    });
    req.on('error', () => {
      clearInterval(hbInterval);
      unsubscribe();
    });

  } catch (e) {
    console.error('[admin-event-stream]', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
    else res.end();
  }
}
