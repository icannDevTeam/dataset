/**
 * Prometheus Metrics — Singleton Registry
 *
 * Tracks HTTP request count, duration, active requests & error rate
 * for every Next.js API route.  Also exposes Node.js process metrics
 * (CPU, memory, event-loop lag, GC) via prom-client defaults.
 *
 * Usage:
 *   import { withMetrics } from '../lib/metrics';
 *   export default withMetrics(handler);          // per-route wrapper
 *   // OR simply hit GET /api/metrics for the scrape endpoint
 */

const client = require('prom-client');

// ── Singleton guard (Next.js hot-reload creates duplicate registries) ──
if (!global.__promRegistry) {
  const register = new client.Registry();

  // Default Node.js metrics (CPU, memory, event-loop, GC …)
  client.collectDefaultMetrics({ register, prefix: 'nextjs_' });

  // ── Custom counters / histograms ──

  const httpRequestsTotal = new client.Counter({
    name: 'nextjs_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
  });

  const httpRequestDuration = new client.Histogram({
    name: 'nextjs_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  const httpRequestsInFlight = new client.Gauge({
    name: 'nextjs_http_requests_in_flight',
    help: 'Number of HTTP requests currently being processed',
    labelNames: ['method', 'route'],
    registers: [register],
  });

  const httpRequestErrors = new client.Counter({
    name: 'nextjs_http_request_errors_total',
    help: 'Total HTTP request errors (status >= 400)',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
  });

  // Firebase / external call tracking
  const externalCallDuration = new client.Histogram({
    name: 'nextjs_external_call_duration_seconds',
    help: 'Duration of external service calls (Firebase, Hikvision, BINUS API)',
    labelNames: ['service', 'operation'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [register],
  });

  const externalCallErrors = new client.Counter({
    name: 'nextjs_external_call_errors_total',
    help: 'Total external service call errors',
    labelNames: ['service', 'operation'],
    registers: [register],
  });

  // Request payload size
  const httpRequestSize = new client.Histogram({
    name: 'nextjs_http_request_size_bytes',
    help: 'HTTP request body size in bytes',
    labelNames: ['method', 'route'],
    buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
    registers: [register],
  });

  const httpResponseSize = new client.Histogram({
    name: 'nextjs_http_response_size_bytes',
    help: 'HTTP response body size in bytes',
    labelNames: ['method', 'route'],
    buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
    registers: [register],
  });

  // App-specific gauges
  const enrolledStudents = new client.Gauge({
    name: 'nextjs_enrolled_students_total',
    help: 'Total enrolled students in dataset',
    registers: [register],
  });

  const seededDescriptors = new client.Gauge({
    name: 'nextjs_seeded_descriptors_total',
    help: 'Total students with seeded face descriptors',
    registers: [register],
  });

  global.__promRegistry = register;
  global.__promMetrics = {
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestsInFlight,
    httpRequestErrors,
    externalCallDuration,
    externalCallErrors,
    httpRequestSize,
    httpResponseSize,
    enrolledStudents,
    seededDescriptors,
  };
}

const register = global.__promRegistry;
const metrics = global.__promMetrics;

/**
 * Derive a short route label from req.url
 * e.g. /api/hikvision/connect?foo=bar → /api/hikvision/connect
 */
function routeLabel(req) {
  const url = (req.url || '/').split('?')[0];
  return url;
}

/**
 * HOF wrapper — wraps any Next.js API handler to record Prometheus metrics.
 *
 *   export default withMetrics(async function handler(req, res) { … });
 */
function withMetrics(handler) {
  return async function metricsWrapper(req, res) {
    const route = routeLabel(req);
    const method = req.method || 'GET';
    const end = metrics.httpRequestDuration.startTimer({ method, route });

    metrics.httpRequestsInFlight.inc({ method, route });

    // Track request size
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > 0) {
      metrics.httpRequestSize.observe({ method, route }, contentLength);
    }

    // Intercept res.end to capture status code + response size
    const originalEnd = res.end;
    const originalJson = res.json;

    let responseBody = '';

    res.json = function (body) {
      responseBody = JSON.stringify(body);
      return originalJson.call(this, body);
    };

    res.end = function (chunk, encoding) {
      const statusCode = res.statusCode || 200;
      end({ status_code: statusCode });

      metrics.httpRequestsTotal.inc({ method, route, status_code: statusCode });
      metrics.httpRequestsInFlight.dec({ method, route });

      if (statusCode >= 400) {
        metrics.httpRequestErrors.inc({ method, route, status_code: statusCode });
      }

      // Track response size
      const size = chunk ? Buffer.byteLength(chunk) : (responseBody ? Buffer.byteLength(responseBody) : 0);
      if (size > 0) {
        metrics.httpResponseSize.observe({ method, route }, size);
      }

      return originalEnd.call(this, chunk, encoding);
    };

    try {
      return await handler(req, res);
    } catch (err) {
      const statusCode = res.statusCode >= 400 ? res.statusCode : 500;
      end({ status_code: statusCode });
      metrics.httpRequestsTotal.inc({ method, route, status_code: statusCode });
      metrics.httpRequestErrors.inc({ method, route, status_code: statusCode });
      metrics.httpRequestsInFlight.dec({ method, route });
      throw err;
    }
  };
}

/**
 * Track an external service call (Firebase, Hikvision, BINUS API).
 *
 *   const timer = trackExternalCall('firebase', 'getStudents');
 *   try { … } finally { timer(); }
 *   // or on error: timer({ error: true });
 */
function trackExternalCall(service, operation) {
  const end = metrics.externalCallDuration.startTimer({ service, operation });
  return function finish(opts = {}) {
    end();
    if (opts.error) {
      metrics.externalCallErrors.inc({ service, operation });
    }
  };
}

/**
 * Update app-level gauges (call periodically or on relevant operations)
 */
function updateAppGauges({ enrolledStudents: enrolled, seededDescriptors: seeded } = {}) {
  if (typeof enrolled === 'number') metrics.enrolledStudents.set(enrolled);
  if (typeof seeded === 'number') metrics.seededDescriptors.set(seeded);
}

module.exports = {
  register,
  metrics,
  withMetrics,
  trackExternalCall,
  updateAppGauges,
};
