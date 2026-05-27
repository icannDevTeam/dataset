/**
 * /api/v2/users/me/preferences
 *
 * Single source of truth for the Downloads Hub per-user UI preferences.
 *
 * Stored at: users/{uid}/preferences/downloads
 *   {
 *     favourites:     string[],                          // pinned card ids
 *     timezone:       string,                            // IANA name (whitelist)
 *     formatDefaults: { [cardId]: 'csv'|'xlsx'|'pdf' },  // per-card preferred format
 *     rangeDefaults:  { [cardId]: 'today'|'yesterday'|...},
 *     updatedAt:      Timestamp,
 *   }
 *
 * Note: this codebase doesn't expose a Firebase uid on req.user — every
 * dashboard user is keyed by email everywhere (`dashboard_users/{email}`,
 * `reportRuns.byUid = email`). To stay consistent we use email as the
 * uid-equivalent here. If a real Firebase uid ever lands on req.user it
 * takes priority.
 *
 * Auth: gated on `auth.signed_in` — every role gets it by default. No
 * download permission is required: a user is always allowed to manage
 * their own UI prefs even if they can't see every card.
 *
 * Contract
 * ────────
 *   GET → 200 { ok, favourites, timezone, formatDefaults, rangeDefaults, updatedAt }
 *
 *   POST { key, value }
 *     key ∈ ['favourites','timezone','formatDefaults','rangeDefaults']
 *     value depends on key (full replace).
 *
 *   POST { key: 'favourites', op: 'add'|'remove', id }
 *     focused toggle (optimistic-friendly).
 *
 * No audit log — these are low-sensitivity per-user UI prefs.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../../lib/firebase-admin';
import { withApi } from '../../../../../lib/api-auth';

const ALLOWED_KEYS = new Set(['favourites', 'timezone', 'formatDefaults', 'rangeDefaults']);

const ALLOWED_TZ = new Set([
  'Asia/Jakarta', 'UTC', 'Asia/Singapore', 'Asia/Tokyo',
  'Europe/London', 'America/Los_Angeles', 'America/New_York',
]);
const ALLOWED_FORMATS = new Set(['csv', 'xlsx', 'pdf']);
const ALLOWED_RANGES = new Set([
  'today', 'yesterday', 'this_week', 'last_7',
  'this_month', 'last_term', 'custom',
]);

const MAX_FAVOURITES  = 64;
const MAX_MAP_ENTRIES = 64;
const MAX_CARD_ID_LEN = 64;

const DEFAULTS = Object.freeze({
  favourites: [],
  timezone: 'Asia/Jakarta',
  formatDefaults: {},
  rangeDefaults: {},
});

function prefDocRef(db, userKey) {
  // users/{uid}/preferences/downloads — 4-segment doc path per spec.
  return db.collection('users').doc(userKey).collection('preferences').doc('downloads');
}

function normalize(doc) {
  const d = doc || {};
  const favourites = Array.isArray(d.favourites)
    ? d.favourites.filter((s) => typeof s === 'string')
    : [];
  const timezone = (typeof d.timezone === 'string' && ALLOWED_TZ.has(d.timezone))
    ? d.timezone
    : DEFAULTS.timezone;
  const formatDefaults = (d.formatDefaults && typeof d.formatDefaults === 'object')
    ? Object.fromEntries(
        Object.entries(d.formatDefaults)
          .filter(([, v]) => ALLOWED_FORMATS.has(v)),
      )
    : {};
  const rangeDefaults = (d.rangeDefaults && typeof d.rangeDefaults === 'object')
    ? Object.fromEntries(
        Object.entries(d.rangeDefaults)
          .filter(([, v]) => ALLOWED_RANGES.has(v)),
      )
    : {};
  const updatedAt = d.updatedAt?.toMillis?.() || d.updatedAt || null;
  return { favourites, timezone, formatDefaults, rangeDefaults, updatedAt };
}

// ── Per-key validation. Returns { value } on success, { error } on failure.
function validateFavouritesValue(value) {
  if (!Array.isArray(value)) return { error: 'favourites must be a string[]' };
  const cleaned = Array.from(new Set(
    value.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_CARD_ID_LEN),
  )).slice(0, MAX_FAVOURITES);
  return { value: cleaned };
}

function validateTimezoneValue(value) {
  if (typeof value !== 'string' || !ALLOWED_TZ.has(value)) {
    return { error: `timezone must be one of: ${[...ALLOWED_TZ].join(', ')}` };
  }
  return { value };
}

function validateMapValue(value, allowedSet, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${label} must be an object` };
  }
  const out = {};
  let n = 0;
  for (const [cardId, v] of Object.entries(value)) {
    if (typeof cardId !== 'string' || !cardId || cardId.length > MAX_CARD_ID_LEN) continue;
    if (typeof v !== 'string' || !allowedSet.has(v)) {
      return { error: `${label}.${cardId} must be one of: ${[...allowedSet].join(', ')}` };
    }
    out[cardId] = v;
    if (++n >= MAX_MAP_ENTRIES) break;
  }
  return { value: out };
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const actor = req.user || {};
  // Email is the de-facto uid in this codebase. Sanity-strip just in case.
  const userKey = (actor.uid || actor.email || '').toString().trim().toLowerCase();
  if (!userKey) return res.status(401).json({ error: 'auth_required' });

  const ref = prefDocRef(db, userKey);

  if (req.method === 'GET') {
    const snap = await ref.get().catch(() => null);
    const data = snap?.exists ? snap.data() : null;
    if (!data) {
      // Sensible defaults — same shape the POST handler would produce.
      return res.status(200).json({ ok: true, ...DEFAULTS, updatedAt: null });
    }
    return res.status(200).json({ ok: true, ...normalize(data) });
  }

  // POST — single-key patch per spec.
  const body = req.body || {};
  const key = typeof body.key === 'string' ? body.key : null;
  if (!key || !ALLOWED_KEYS.has(key)) {
    return res.status(400).json({
      error: 'bad_key',
      message: `key must be one of: ${[...ALLOWED_KEYS].join(', ')}`,
    });
  }

  const patch = {};

  // ── Focused favourites toggle ────────────────────────────────────
  if (key === 'favourites' && typeof body.op === 'string') {
    const { op, id } = body;
    if (!['add', 'remove'].includes(op)) {
      return res.status(400).json({ error: 'bad_op', message: "op must be 'add' or 'remove'" });
    }
    if (typeof id !== 'string' || !id || id.length > MAX_CARD_ID_LEN) {
      return res.status(400).json({ error: 'bad_id', message: 'id must be a non-empty string' });
    }
    patch.favourites = op === 'add'
      ? admin.firestore.FieldValue.arrayUnion(id)
      : admin.firestore.FieldValue.arrayRemove(id);
  }
  // ── Full-replace value patches ────────────────────────────────────
  else if (key === 'favourites') {
    const v = validateFavouritesValue(body.value);
    if (v.error) return res.status(400).json({ error: 'bad_value', message: v.error });
    patch.favourites = v.value;
  } else if (key === 'timezone') {
    const v = validateTimezoneValue(body.value);
    if (v.error) return res.status(400).json({ error: 'bad_value', message: v.error });
    patch.timezone = v.value;
  } else if (key === 'formatDefaults') {
    const v = validateMapValue(body.value, ALLOWED_FORMATS, 'formatDefaults');
    if (v.error) return res.status(400).json({ error: 'bad_value', message: v.error });
    patch.formatDefaults = v.value; // full replace
  } else if (key === 'rangeDefaults') {
    const v = validateMapValue(body.value, ALLOWED_RANGES, 'rangeDefaults');
    if (v.error) return res.status(400).json({ error: 'bad_value', message: v.error });
    patch.rangeDefaults = v.value;  // full replace
  }

  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  patch.byEmail   = actor.email || null;

  await ref.set(patch, { merge: true });
  const fresh = await ref.get().catch(() => null);
  const data = fresh?.exists ? fresh.data() : null;
  return res.status(200).json({ ok: true, ...normalize(data) });
}

export default withApi(handler, {
  methods: ['GET', 'POST'],
  permission: 'auth.signed_in',
  rateLimit: 60,
});
