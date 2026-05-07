/**
 * Pickup System — Onboarding Invite Links
 *
 * One named, open-ended invite link can serve any number of parents.
 * Each link has its own ID (`lid`) embedded as a JWT claim, allowing
 * per-link revocation, usage caps, and analytics — without abandoning
 * the stateless verification fast-path on hot endpoints.
 *
 * Firestore: tenants/{tid}/onboarding_invites/{lid}
 *   {
 *     name, description?, enabled, useCount, maxUses|null,
 *     expiresAt|null, lastUsedAt|null, revokedAt|null,
 *     createdBy, createdAt, updatedAt, token, url
 *   }
 *
 * Hot path:
 *   1. verifyPickupOnboardingToken(token)         (HMAC, no Firestore)
 *   2. if claims.lid → assertInviteUsable()        (1 doc read; cache OK)
 *   3. on success → recordUse()                    (atomic increment)
 */
const crypto = require('crypto');
const admin = require('firebase-admin');
const { signPickupOnboardingToken } = require('./pickup-token');
const tenancy = require('./tenancy');

const COLL = 'onboarding_invites';

const DEFAULT_TTL_DAYS = 90;
const MAX_TTL_DAYS = 365;

function invitesPath(tid) {
  return `${tenancy.tenantDoc(tid)}/${COLL}`;
}

function inviteDocPath(tid, lid) {
  return `${invitesPath(tid)}/${lid}`;
}

function newLinkId() {
  // 12 chars base32-ish, URL-safe, ~60 bits — collision-resistant.
  return crypto.randomBytes(8).toString('hex');
}

function buildInviteUrl(token) {
  // No silent fallback to a hardcoded prod URL — that caused tokens signed
  // with a local secret to be served via a prod URL, producing bad_signature
  // errors when clicked. Fail loud instead.
  const base = process.env.PUBLIC_BASE_URL
    || process.env.NEXT_PUBLIC_BASE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!base) {
    throw new Error(
      'buildInviteUrl: no base URL configured. Set PUBLIC_BASE_URL ' +
      '(e.g. http://localhost:3000 in dev, https://your-domain in prod).'
    );
  }
  return `${base.replace(/\/+$/, '')}/pickup/onboarding/${token}`;
}

function clampTtlDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_DAYS;
  return Math.min(Math.max(1, Math.floor(n)), MAX_TTL_DAYS);
}

function clampMaxUses(maxUses) {
  if (maxUses === null || maxUses === undefined || maxUses === '') return null;
  const n = Number(maxUses);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), 100000);
}

/** Convert anything ISO-ish or millis to a Firestore Timestamp, or null. */
function toTimestamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return admin.firestore.Timestamp.fromMillis(v);
  }
  if (v instanceof Date) return admin.firestore.Timestamp.fromDate(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return admin.firestore.Timestamp.fromDate(d);
  }
  if (v && typeof v.toMillis === 'function') return v;
  return null;
}

/** Serialise a Firestore document into a plain JSON-safe shape. */
function serialize(doc) {
  if (!doc || !doc.exists) return null;
  const d = doc.data() || {};
  const ts = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (v || null));
  return {
    id: doc.id,
    name: d.name || '',
    description: d.description || '',
    enabled: d.enabled !== false && !d.revokedAt,
    revoked: !!d.revokedAt,
    useCount: Number(d.useCount || 0),
    maxUses: d.maxUses === undefined ? null : (d.maxUses === null ? null : Number(d.maxUses)),
    expiresAt: ts(d.expiresAt),
    windowOpenAt: ts(d.windowOpenAt),
    windowCloseAt: ts(d.windowCloseAt),
    lastUsedAt: ts(d.lastUsedAt),
    revokedAt: ts(d.revokedAt),
    archived: !!d.archived,
    archivedAt: ts(d.archivedAt),
    createdBy: d.createdBy || null,
    createdAt: ts(d.createdAt),
    updatedAt: ts(d.updatedAt),
    token: d.token || null,
    url: d.url || (d.token ? buildInviteUrl(d.token) : null),
  };
}

/**
 * Create a new invite link.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} tid
 * @param {{name:string, description?:string, ttlDays?:number, maxUses?:number|null, createdBy?:string}} opts
 */
async function createInvite(db, tid, opts) {
  const name = String(opts?.name || '').trim();
  if (!name) throw new Error('name required');
  if (name.length > 80) throw new Error('name too long');

  const ttlDays = clampTtlDays(opts?.ttlDays);
  const baseTtlSeconds = ttlDays * 24 * 3600;
  const maxUses = clampMaxUses(opts?.maxUses);
  const description = String(opts?.description || '').trim().slice(0, 280) || null;
  const createdBy = String(opts?.createdBy || 'system').slice(0, 128);

  const lid = newLinkId();

  const windowOpenAt = toTimestamp(opts?.windowOpenAt);
  const windowCloseAt = toTimestamp(opts?.windowCloseAt);
  if (windowOpenAt && windowCloseAt && windowCloseAt.toMillis() <= windowOpenAt.toMillis()) {
    throw new Error('windowCloseAt must be after windowOpenAt');
  }

  // The JWT lifetime must outlast the submission window — otherwise a
  // parent who opens the link after exp can never see the friendly
  // "window closed" / "not yet open" message; they get a confusing
  // "Link expired" wall instead. We extend the signed `exp` to the
  // later of the requested ttl and 24h past the window close.
  const now = Date.now();
  const windowDerivedSeconds = windowCloseAt
    ? Math.max(0, Math.floor((windowCloseAt.toMillis() - now) / 1000) + 86400)
    : 0;
  const ttlSeconds = Math.max(baseTtlSeconds, windowDerivedSeconds);

  const token = signPickupOnboardingToken({ tenantId: tid, linkId: lid, ttlSeconds });
  const url = buildInviteUrl(token);

  const serverNow = admin.firestore.FieldValue.serverTimestamp();
  const expiresAt = admin.firestore.Timestamp.fromMillis(now + ttlSeconds * 1000);

  const ref = db.doc(inviteDocPath(tid, lid));
  await ref.set({
    name,
    description,
    enabled: true,
    useCount: 0,
    maxUses,
    expiresAt,
    windowOpenAt,
    windowCloseAt,
    lastUsedAt: null,
    revokedAt: null,
    createdBy,
    createdAt: serverNow,
    updatedAt: serverNow,
    token,
    url,
  });

  const snap = await ref.get();
  return serialize(snap);
}

async function listInvites(db, tid) {
  const snap = await db.collection(invitesPath(tid))
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();
  return snap.docs.map(serialize).filter(Boolean);
}

async function getInvite(db, tid, lid) {
  const snap = await db.doc(inviteDocPath(tid, lid)).get();
  return serialize(snap);
}

async function updateInvite(db, tid, lid, patch) {
  const allowed = {};
  if (patch && typeof patch.name === 'string') {
    const v = patch.name.trim();
    if (!v) throw new Error('name cannot be empty');
    if (v.length > 80) throw new Error('name too long');
    allowed.name = v;
  }
  if (patch && typeof patch.description === 'string') {
    allowed.description = patch.description.trim().slice(0, 280) || null;
  }
  if (patch && typeof patch.enabled === 'boolean') {
    allowed.enabled = patch.enabled;
    // Toggling enabled clears any prior revoke so admin can re-activate.
    if (patch.enabled) allowed.revokedAt = null;
  }
  if (patch && typeof patch.archived === 'boolean') {
    allowed.archived = patch.archived;
    allowed.archivedAt = patch.archived
      ? admin.firestore.FieldValue.serverTimestamp()
      : null;
  }
  if (patch && (patch.maxUses === null || patch.maxUses === undefined || patch.maxUses === '' || Number.isFinite(Number(patch.maxUses)))) {
    if (Object.prototype.hasOwnProperty.call(patch, 'maxUses')) {
      allowed.maxUses = clampMaxUses(patch.maxUses);
    }
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'windowOpenAt')) {
    allowed.windowOpenAt = toTimestamp(patch.windowOpenAt);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'windowCloseAt')) {
    allowed.windowCloseAt = toTimestamp(patch.windowCloseAt);
  }
  // Cross-field check: read current values to verify open < close.
  if (allowed.windowOpenAt !== undefined || allowed.windowCloseAt !== undefined) {
    const cur = await db.doc(inviteDocPath(tid, lid)).get();
    const curD = cur.exists ? cur.data() : {};
    const open  = (allowed.windowOpenAt  !== undefined ? allowed.windowOpenAt  : curD.windowOpenAt)  || null;
    const close = (allowed.windowCloseAt !== undefined ? allowed.windowCloseAt : curD.windowCloseAt) || null;
    if (open && close && close.toMillis() <= open.toMillis()) {
      throw new Error('windowCloseAt must be after windowOpenAt');
    }
  }
  if (Object.keys(allowed).length === 0) {
    return getInvite(db, tid, lid);
  }
  allowed.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db.doc(inviteDocPath(tid, lid)).set(allowed, { merge: true });
  return getInvite(db, tid, lid);
}

async function revokeInvite(db, tid, lid) {
  await db.doc(inviteDocPath(tid, lid)).set({
    enabled: false,
    revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return getInvite(db, tid, lid);
}

async function deleteInvite(db, tid, lid) {
  await db.doc(inviteDocPath(tid, lid)).delete();
  return { ok: true };
}

/**
 * Hot-path check used by submit/lookup/face endpoints.
 * Returns {ok:true} if the link can still be used, otherwise
 * {ok:false, reason, status} where status is the HTTP code to return.
 *
 * Reads exactly one document. If `lid` is falsy we treat it as a
 * legacy/open token and accept it (no link record to enforce).
 */
async function assertInviteUsable(db, tid, lid) {
  if (!lid) return { ok: true };
  const ref = db.doc(inviteDocPath(tid, lid));
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, reason: 'invite_not_found', status: 403 };
  }
  const d = snap.data() || {};
  const meta = {
    windowOpenAt:  d.windowOpenAt  && d.windowOpenAt.toMillis  ? d.windowOpenAt.toMillis()  : null,
    windowCloseAt: d.windowCloseAt && d.windowCloseAt.toMillis ? d.windowCloseAt.toMillis() : null,
  };
  if (d.revokedAt) return { ok: false, reason: 'invite_revoked', status: 403, ...meta };
  if (d.enabled === false) return { ok: false, reason: 'invite_disabled', status: 403, ...meta };
  if (d.expiresAt && typeof d.expiresAt.toMillis === 'function' && d.expiresAt.toMillis() < Date.now()) {
    return { ok: false, reason: 'invite_expired', status: 403, ...meta };
  }
  if (meta.windowOpenAt && meta.windowOpenAt > Date.now()) {
    return { ok: false, reason: 'invite_not_yet_open', status: 403, ...meta };
  }
  if (meta.windowCloseAt && meta.windowCloseAt < Date.now()) {
    return { ok: false, reason: 'invite_window_closed', status: 403, ...meta };
  }
  if (d.maxUses != null && Number(d.useCount || 0) >= Number(d.maxUses)) {
    return { ok: false, reason: 'invite_capacity_reached', status: 403, ...meta };
  }
  return { ok: true, ...meta };
}

/**
 * Atomically increment useCount and stamp lastUsedAt.
 * Best-effort — failures are swallowed so onboarding never breaks
 * because of analytics bookkeeping.
 */
async function recordUse(db, tid, lid) {
  if (!lid) return;
  try {
    await db.doc(inviteDocPath(tid, lid)).set({
      useCount: admin.firestore.FieldValue.increment(1),
      lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('[onboarding-invites] recordUse failed:', err.message);
  }
}

module.exports = {
  createInvite,
  listInvites,
  getInvite,
  updateInvite,
  revokeInvite,
  deleteInvite,
  assertInviteUsable,
  recordUse,
  buildInviteUrl,
  invitesPath,
  DEFAULT_TTL_DAYS,
  MAX_TTL_DAYS,
};
