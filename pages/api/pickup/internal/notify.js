/**
 * POST /api/pickup/internal/notify
 *
 * Backend-side bridge: called by pickup_event_writer.py immediately after a
 * pickup_event Firestore document is written. Re-fetches the doc, shapes it,
 * and broadcasts it on the in-memory SSE bus so connected iPad teacher PWAs
 * get the new card in <1s.
 *
 * Auth: shared secret in `X-Internal-Push-Secret` header, must equal
 *   process.env.INTERNAL_PUSH_SECRET.
 *
 * Body: { tenantId: string, eventId: string }
 *
 * Response: { ok: true, delivered: number } | { ok: false, error: string }
 *
 * Idempotent — re-broadcasting an already-delivered event is harmless;
 * the iPad merges by event.id.
 */
import admin from 'firebase-admin';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const bus = require('../../../../lib/pickup-event-bus');
const { shapePickupEvent } = require('../../../../lib/pickup-event-shape');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  const secret = process.env.INTERNAL_PUSH_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, error: 'INTERNAL_PUSH_SECRET not configured' });
  }
  if (req.headers['x-internal-push-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { tenantId, eventId } = req.body || {};
  if (!tenantId || !eventId) {
    return res.status(400).json({ ok: false, error: 'tenantId and eventId required' });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();

    const docRef = db.doc(`${tenancy.pickupEventsPath(tenantId)}/${eventId}`);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: 'event not found' });
    }

    const shaped = await shapePickupEvent(bucket, snap);
    const delivered = bus.broadcast(tenantId, shaped);

    return res.status(200).json({ ok: true, delivered });
  } catch (e) {
    console.error('[pickup/internal/notify]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
