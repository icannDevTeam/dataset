/**
 * Shared Hikvision ISAPI helper using HTTP Digest Authentication.
 *
 * The DS-K1T341AMF requires HTTP Digest Auth (not Basic Auth).
 * We implement the digest handshake manually because third-party
 * npm digest-auth libraries fail with this device.
 *
 * Challenges are cached per device IP so only the first request
 * does a probe round-trip — subsequent calls reuse the nonce.
 */

import axios from 'axios';
import crypto from 'crypto';

const md5 = (str) => crypto.createHash('md5').update(str).digest('hex');

/**
 * Parse a WWW-Authenticate: Digest header into its parts.
 */
function parseDigestHeader(header) {
  const obj = {};
  const parts = header.replace(/^Digest\s+/i, '');
  const re = /(\w+)=(?:"([^"]*)"|([\w]+))/g;
  let m;
  while ((m = re.exec(parts))) {
    obj[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return obj;
}

// Cached digest challenge per device IP
const challengeCache = {};
// Per-device nonce counter
const ncCounters = {};

/**
 * Obtain a digest challenge from the device via a lightweight GET.
 */
async function getChallenge(device) {
  const cached = challengeCache[device.ip];
  if (cached) return cached;

  const probe = await axios.get(`http://${device.ip}/ISAPI/System/deviceInfo`, {
    validateStatus: (s) => s === 401,
    timeout: 10000,
  });

  const wwwAuth = probe.headers['www-authenticate'];
  if (!wwwAuth || !wwwAuth.toLowerCase().startsWith('digest')) {
    throw new Error('Device did not return a Digest challenge');
  }

  const challenge = parseDigestHeader(wwwAuth);
  challengeCache[device.ip] = challenge;
  return challenge;
}

/**
 * Invalidate the cached challenge for a device (called on stale nonce / 401).
 */
function invalidateChallenge(device) {
  delete challengeCache[device.ip];
}

/**
 * Build the Authorization: Digest header value.
 */
function buildDigestAuth(username, password, method, uri, challenge) {
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  const qop = challenge.qop || 'auth';
  const opaque = challenge.opaque || '';

  const key = `${realm}:${nonce}`;
  ncCounters[key] = (ncCounters[key] || 0) + 1;
  const nc = String(ncCounters[key]).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  return [
    `Digest username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
    `opaque="${opaque}"`,
  ].join(', ');
}

/**
 * Make an authenticated request to a Hikvision device.
 *
 * Flow:
 *   1. Get digest challenge (cached or via lightweight GET probe)
 *   2. Build Authorization header and send the real request
 *   3. On 401 (stale nonce), re-probe and retry once
 *
 * @param {Object} device - { ip, username, password }
 * @param {string} method - HTTP method (get, post, put, delete)
 * @param {string} apiPath - ISAPI path, e.g. /ISAPI/System/deviceInfo
 * @param {Object|Buffer|null} data - Request body
 * @param {Object} extraOpts - Extra axios options (headers, timeout, etc.)
 * @returns {Promise<{status: number, data: any}>}
 */
export async function hikRequest(device, method, apiPath, data = null, extraOpts = {}) {
  const url = `http://${device.ip}${apiPath}`;
  const httpMethod = method.toUpperCase();

  const baseOpts = {
    method: httpMethod,
    url,
    timeout: 15000,
    ...extraOpts,
  };
  if (data) baseOpts.data = data;
  if (!baseOpts.headers) baseOpts.headers = {};
  if (!baseOpts.headers['Content-Type']) baseOpts.headers['Content-Type'] = 'application/json';

  // Try up to 2 times (initial + retry on stale nonce)
  for (let attempt = 0; attempt < 2; attempt++) {
    const challenge = await getChallenge(device);
    const authHeader = buildDigestAuth(
      device.username,
      device.password,
      httpMethod,
      apiPath,
      challenge,
    );

    const resp = await axios({
      ...baseOpts,
      validateStatus: (s) => s < 500,
      headers: {
        ...baseOpts.headers,
        Authorization: authHeader,
      },
    });

    if (resp.status === 401) {
      // Nonce may be stale — invalidate and retry
      invalidateChallenge(device);
      if (attempt === 0) continue;
      const err = new Error('Authentication failed');
      err.response = resp;
      throw err;
    }

    if (resp.status >= 400) {
      const err = new Error(`ISAPI ${httpMethod} ${apiPath} returned ${resp.status}`);
      err.response = resp;
      throw err;
    }

    return { status: resp.status, data: resp.data };
  }
}

/**
 * Shortcut: make a JSON request and return just the data.
 */
export async function hikJson(device, method, apiPath, data = null) {
  const { data: responseData } = await hikRequest(device, method, apiPath, data);
  return responseData;
}
