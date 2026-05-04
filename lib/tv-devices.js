/**
 * TV-device pairing helpers.
 *
 *   tenants/{tid}/tv_devices/{deviceId}
 *     {
 *       deviceId,            // = doc id
 *       deviceLabel,         // admin-friendly name (e.g. "PYP Lobby TV 1")
 *       pairingCode,         // 6-char display code while status === "pending"
 *       deviceToken,         // long secret returned to TV after pairing/code-claim
 *       profileId,           // kiosk profile assigned to this TV
 *       status,              // "pending" | "paired" | "revoked"
 *       userAgent,
 *       createdAt,
 *       claimedAt,
 *       lastSeenAt,
 *       lastSeenIp,
 *     }
 *
 * Two ways a TV becomes "paired":
 *   1. Admin types pairing code in dashboard → claim → token issued
 *   2. TV types a kiosk code on the entry page → server creates a device doc
 *      directly bound to the matching profile → token issued
 */
const crypto = require('crypto');
const tenancy = require('./tenancy');

const tvDevicesPath = (t) => `${tenancy.tenantDoc(t)}/tv_devices`;
const tvDeviceDoc = (id, t) => `${tvDevicesPath(t)}/${id}`;

// Avoid ambiguous chars (0/O/1/I/L) so users can read codes off a TV across the room.
const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomFromAlphabet(len, alphabet = SAFE_ALPHABET) {
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function genPairingCode() {
  // 6 chars, displayed as XXX-XXX
  return randomFromAlphabet(6);
}

function genDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

function genDeviceId() {
  return `tvd_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeKioskCode(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
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
    profileId: data.profileId || null,
    status: data.status || 'pending',
    userAgent: data.userAgent || null,
    createdAt: tsIso(data.createdAt),
    claimedAt: tsIso(data.claimedAt),
    lastSeenAt: tsIso(data.lastSeenAt),
  };
}

module.exports = {
  tvDevicesPath,
  tvDeviceDoc,
  genPairingCode,
  genDeviceToken,
  genDeviceId,
  normalizeKioskCode,
  normalizePairingCode,
  publicDevice,
};
