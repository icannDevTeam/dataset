/**
 * Tablet (iPad) pairing helpers — Phase 2 mirror of lib/tv-devices.js.
 *
 *   tenants/{tid}/tablet_devices/{deviceId}
 *     {
 *       deviceId,            // = doc id
 *       deviceLabel,         // admin-friendly name (e.g. "PYP G4 iPad")
 *       pairingCode,         // 6-char display code while status === "pending"
 *       pairingExpiresAt,
 *       deviceToken,         // long secret returned to iPad after pairing
 *       releaseGroupId,      // bound release group (which terminals it watches)
 *       status,              // "pending" | "paired" | "revoked"
 *       userAgent,
 *       createdAt,
 *       claimedAt,
 *       lastSeenAt,
 *       lastSeenIp,
 *     }
 *
 * Pairing flow (admin starts a code per release group, iPad enters it):
 *   1. Admin clicks "Pair iPad" on a release group → POST /api/pickup/tablet/start-pair
 *      → server creates a pending tablet_devices doc bound to releaseGroupId
 *      → returns 6-char code shown in admin UI.
 *   2. iPad opens /pickup/teacher with no token → renders pairing screen.
 *   3. iPad submits code → POST /api/pickup/tablet/claim-by-code → token issued.
 *   4. iPad persists token in localStorage + cookie; thereafter calls /whoami on boot.
 */
const crypto = require('crypto');
const tenancy = require('./tenancy');

const tabletDevicesPath = (t) => tenancy.tabletDevicesPath(t);
const tabletDeviceDoc = (id, t) => tenancy.tabletDeviceDoc(id, t);

// Avoid ambiguous chars (0/O/1/I/L) so a teacher can read codes off an iPad.
const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomFromAlphabet(len, alphabet = SAFE_ALPHABET) {
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function genPairingCode() {
  return randomFromAlphabet(6);
}

function genDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

function genDeviceId() {
  return `tab_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizePairingCode(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function tsIso(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') return ts;
  if (ts.toDate) return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

function publicDevice(id, data) {
  if (!data) return null;
  return {
    id,
    deviceLabel: data.deviceLabel || id,
    pairingCode: data.pairingCode || null,
    releaseGroupId: data.releaseGroupId || null,
    status: data.status || 'pending',
    userAgent: data.userAgent || null,
    createdAt: tsIso(data.createdAt),
    claimedAt: tsIso(data.claimedAt),
    lastSeenAt: tsIso(data.lastSeenAt),
  };
}

module.exports = {
  tabletDevicesPath,
  tabletDeviceDoc,
  genPairingCode,
  genDeviceToken,
  genDeviceId,
  normalizePairingCode,
  publicDevice,
};
