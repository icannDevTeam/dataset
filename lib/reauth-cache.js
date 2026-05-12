/**
 * lib/reauth-cache.js — In-memory cache of the last successful re-auth token.
 *
 * Bridges the React `useReauthGate()` hook (which prompts for password) with
 * non-React fetch helpers and overlays that need to attach the
 * `X-Reauth-Token` header to download requests.
 *
 * The token's server-side `auth_time` claim is good for 5 min (see
 * `lib/reauth.js#DEFAULT_MAX_AGE_SEC`). We expire one minute earlier on the
 * client to avoid handing back a token that the server will reject mid-flight.
 */

const SLACK_MS = 60 * 1000;        // expire 1 min before server window closes
const DEFAULT_TTL_MS = 5 * 60 * 1000;

let _entry = null; // { token, expiresAt }

export function setReauthToken(token, ttlMs = DEFAULT_TTL_MS) {
  if (!token) { _entry = null; return; }
  _entry = { token, expiresAt: Date.now() + Math.max(0, ttlMs - SLACK_MS) };
}

export function getReauthToken() {
  if (!_entry) return null;
  if (_entry.expiresAt <= Date.now()) {
    _entry = null;
    return null;
  }
  return _entry.token;
}

export function clearReauthToken() {
  _entry = null;
}

/**
 * Fetch wrapper that auto-attaches the cached X-Reauth-Token header.
 * Use for export / download requests. Returns null token if cache empty —
 * the caller should prompt via useReauthGate() before calling.
 */
export function reauthHeaders(extra = {}) {
  const t = getReauthToken();
  return t ? { ...extra, 'X-Reauth-Token': t } : { ...extra };
}
