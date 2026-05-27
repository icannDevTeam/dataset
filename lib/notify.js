/**
 * lib/notify.js — App-wide toast notifications.
 *
 * Thin wrapper over `sonner` so we have one place to:
 *   - centralize default duration & styling
 *   - map API/network errors to friendly user-facing messages
 *   - make swapping the library cheap later
 *
 * Usage:
 *   import { notify } from '../lib/notify';
 *   notify.success('Saved');
 *   notify.error('Something went wrong');
 *   notify.apiError(err, 'Failed to load report');
 */
import { toast } from 'sonner';

const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 6000;

function asString(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.message === 'string') return value.message;
  try { return String(value); } catch { return fallback; }
}

/** Map an error/status to a friendly message. */
export function describeError(err, fallback = 'Something went wrong.') {
  // Network / offline
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'You appear to be offline. Check your connection and try again.';
  }
  if (err && (err.name === 'TypeError' || err.code === 'NETWORK_ERROR')) {
    if (/failed to fetch|networkerror|load failed/i.test(asString(err))) {
      return 'Connection lost. Please retry in a moment.';
    }
  }

  const status = err?.status ?? err?.response?.status;
  switch (status) {
    case 400: return asString(err?.message, 'Invalid request. Please review the form and try again.');
    case 401: return 'Your session expired. Please sign in again.';
    case 403: return "You don't have permission to do that.";
    case 404: return 'That resource was not found.';
    case 409: return asString(err?.message, 'Conflict — the data was changed elsewhere. Refresh and retry.');
    case 422: return asString(err?.message, 'Validation failed. Please review the highlighted fields.');
    case 429: return "You're going too fast. Please wait a moment and try again.";
    case 500: return 'Server error. The team has been notified.';
    case 502:
    case 503:
    case 504: return 'Service is temporarily unavailable. Please try again shortly.';
    default: break;
  }

  return asString(err?.message, fallback);
}

export const notify = {
  success: (message, opts = {}) => toast.success(asString(message), { duration: DEFAULT_DURATION, ...opts }),
  error:   (message, opts = {}) => toast.error(asString(message),   { duration: ERROR_DURATION,   ...opts }),
  info:    (message, opts = {}) => toast(asString(message),         { duration: DEFAULT_DURATION, ...opts }),
  warning: (message, opts = {}) => toast.warning(asString(message), { duration: ERROR_DURATION,   ...opts }),
  loading: (message, opts = {}) => toast.loading(asString(message), opts),
  dismiss: (id) => toast.dismiss(id),
  /**
   * Promise-aware toast — shows loading, then success/error automatically.
   *   notify.promise(fetch(...), { loading: 'Saving…', success: 'Saved', error: (e) => describeError(e) });
   */
  promise: (p, msgs, opts = {}) => toast.promise(p, msgs, opts),
  /**
   * Toast an error from an exception with a friendly fallback message.
   * Always logs the underlying error to the console for engineers.
   */
  apiError: (err, fallback = 'Something went wrong.') => {
    // eslint-disable-next-line no-console
    console.error('[notify.apiError]', err);
    return toast.error(describeError(err, fallback), { duration: ERROR_DURATION });
  },
};

export default notify;
