/**
 * GET /api/pickup/tablet/whoami
 *
 * Public. The iPad calls this on boot with its stored deviceToken to confirm
 * it is still paired and to fetch the current release group + terminal list.
 *
 * Auth: x-tablet-device-token header  (or ?deviceToken=)
 * Reply (ok): { ok, deviceId, deviceLabel, releaseGroupId, releaseGroupName,
 *               gradeLabel, terminalIds, terminals: [{id,name,gateLabel,gateOverride}] }
 * Reply (revoked): 401
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { effectiveGateStatus } = require('../../../../lib/terminal-gate');

const WHOAMI_CACHE_TTL_MS = 60 * 1000;
const WHOAMI_HEARTBEAT_MS = 30 * 60 * 1000;
const WHOAMI_CACHE = new Map();

function getWhoamiCache(key) {
  const hit = WHOAMI_CACHE.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) > WHOAMI_CACHE_TTL_MS) {
    WHOAMI_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setWhoamiCache(key, value) {
  WHOAMI_CACHE.set(key, { at: Date.now(), value });
}

function hhmmToMinutes(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  return (h * 60) + mm;
}

function minutesToHhmm(v) {
  const h = Math.floor(v / 60);
  const m = v % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const token = req.headers['x-tablet-device-token'] || req.query.deviceToken;
  if (!token) return res.status(400).json({ error: 'deviceToken required' });
  const tenantId = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const cacheKey = `${tenantId}:${String(token)}`;
  const cached = getWhoamiCache(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    initializeFirebase();
    const db = admin.firestore();
    const snap = await db.collection(tenancy.tabletDevicesPath(tenantId))
      .where('deviceToken', '==', String(token))
      .limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'unknown token' });

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.status !== 'paired') return res.status(401).json({ error: data.status || 'revoked' });

    const releaseGroupId = data.releaseGroupId;
    let groupData = null;
    if (releaseGroupId) {
      const g = await db.doc(tenancy.releaseGroupDoc(releaseGroupId, tenantId)).get();
      groupData = g.exists ? g.data() : null;
    }
    const pickupSettingsSnap = await db.doc(tenancy.pickupSettingsDoc(tenantId)).get().catch(() => null);
    const pickupSettings = pickupSettingsSnap?.exists ? (pickupSettingsSnap.data() || {}) : {};

    const terminalIds = Array.isArray(groupData?.terminalIds) ? groupData.terminalIds : [];
    const terminals = [];
    for (const tid2 of terminalIds) {
      const t = await db.doc(tenancy.terminalDoc(tid2, tenantId)).get();
      if (t.exists) {
        const td = t.data();
        const gate = effectiveGateStatus(td, groupData, new Date(), pickupSettings);
        terminals.push({
          id: t.id,
          name: td.name || t.id,
          gateLabel: td.gateLabel || null,
          gateOverride: td.gateOverride || null,
          enabled: td.enabled !== false,
          windowOpen: gate?.scheduled?.opensAt || null,
          windowClose: gate?.scheduled?.closesAt || null,
        });
      }
    }

    const windowPairs = terminals
      .map((t) => ({ open: hhmmToMinutes(t.windowOpen), close: hhmmToMinutes(t.windowClose) }))
      .filter((p) => Number.isInteger(p.open) && Number.isInteger(p.close));
    const windowOpen = windowPairs.length ? minutesToHhmm(Math.min(...windowPairs.map((p) => p.open))) : null;
    const windowClose = windowPairs.length ? minutesToHhmm(Math.max(...windowPairs.map((p) => p.close))) : null;

    const payload = {
      ok: true,
      deviceId: doc.id,
      deviceLabel: data.deviceLabel || doc.id,
      releaseGroupId,
      releaseGroupName: groupData?.name || releaseGroupId,
      gradeLabel: groupData?.gradeLabel || null,
      terminalIds,
      terminals,
      windowOpen,
      windowClose,
    };
    setWhoamiCache(cacheKey, payload);

    // Touch lastSeenAt sparingly to reduce write churn.
    const lastSeenMs = data?.lastSeenAt?.toMillis ? data.lastSeenAt.toMillis() : 0;
    if (Date.now() - lastSeenMs > WHOAMI_HEARTBEAT_MS) {
      doc.ref.set({
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeenIp: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      }, { merge: true }).catch(() => {});
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[pickup/tablet/whoami]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
