/**
 * lib/http.js — fetch wrapper that throws structured errors on non-2xx.
 *
 * The default `fetch` resolves on HTTP errors, forcing every caller to
 * check `res.ok`. We centralise that here so callers can simply:
 *
 *   import { fetchJson } from '../lib/http';
 *   const data = await fetchJson('/api/x');
 *
 * On failure the thrown error carries:
 *   { name: 'HttpError', status, statusText, url, body, message, code? }
 * so `notify.apiError(err)` can map it to a friendly message.
 */

export class HttpError extends Error {
  constructor({ status, statusText, url, body, message, code }) {
    super(message || `HTTP ${status} ${statusText}`.trim());
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
    if (code) this.code = code;
  }
}

async function readBody(res) {
  const ct = res.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) return await res.json();
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  }
}

function pickMessage(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body;
  if (typeof body.error === 'string') return body.error;
  if (typeof body.message === 'string') return body.message;
  if (body.error && typeof body.error.message === 'string') return body.error.message;
  return fallback;
}

/**
 * `fetch` wrapper that:
 *   - sends credentials by default (cookies for our session auth)
 *   - returns parsed JSON when the response is JSON, else text/null
 *   - throws HttpError on non-2xx
 */
export async function fetchJson(input, init = {}) {
  const opts = { credentials: 'include', ...init };
  // Auto-JSON body
  if (opts.body != null && typeof opts.body === 'object' && !(opts.body instanceof FormData) && !(opts.body instanceof Blob)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }

  let res;
  try {
    res = await fetch(input, opts);
  } catch (networkErr) {
    throw new HttpError({
      status: 0,
      statusText: 'Network Error',
      url: typeof input === 'string' ? input : input?.url,
      body: null,
      message: networkErr?.message || 'Network request failed',
      code: 'NETWORK_ERROR',
    });
  }

  const body = await readBody(res);
  if (!res.ok) {
    throw new HttpError({
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      body,
      message: pickMessage(body, `Request failed (${res.status})`),
    });
  }
  return body;
}

/** Same as fetchJson but returns the raw Response (for blobs/streams). */
export async function fetchRaw(input, init = {}) {
  const opts = { credentials: 'include', ...init };
  let res;
  try {
    res = await fetch(input, opts);
  } catch (networkErr) {
    throw new HttpError({
      status: 0,
      statusText: 'Network Error',
      url: typeof input === 'string' ? input : input?.url,
      body: null,
      message: networkErr?.message || 'Network request failed',
      code: 'NETWORK_ERROR',
    });
  }
  if (!res.ok) {
    const body = await readBody(res);
    throw new HttpError({
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      body,
      message: pickMessage(body, `Request failed (${res.status})`),
    });
  }
  return res;
}

export default { fetchJson, fetchRaw, HttpError };
