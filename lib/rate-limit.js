/**
 * Tiny in-memory per-IP rate limiter for public API routes.
 *
 * Survives only within a single Node process. Good enough for our
 * dashboard footprint (single Vercel/Node instance per region) — for
 * multi-instance deployments swap the bucket store for Redis.
 *
 * Usage:
 *   import { enforceRateLimit, clientIp } from '../../../lib/rate-limit';
 *   const limited = enforceRateLimit('pickup:poll-pair', clientIp(req), { max: 30, windowMs: 60_000 });
 *   if (!limited.allowed) return res.status(429).json({ error: 'rate_limited', retryAfter: limited.retryAfter });
 */

const buckets = new Map(); // bucketName -> Map<key, {start, count}>

// Best-effort per-instance telemetry (resets on cold start)
const stats = { allowedTotal: 0, blockedTotal: 0, startedAt: Date.now() };
const recentBlocks = []; // { at, bucket, key }

function maskIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + '::*';
  }
  const o = ip.split('.');
  return o.length === 4 ? `${o[0]}.${o[1]}.x.x` : ip;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.headers['x-real-ip']
      || req.socket?.remoteAddress
      || 'unknown';
}

function enforceRateLimit(bucketName, key, { max, windowMs }) {
  if (!key) key = 'unknown';
  let bucket = buckets.get(bucketName);
  if (!bucket) {
    bucket = new Map();
    buckets.set(bucketName, bucket);
  }
  const now = Date.now();
  const entry = bucket.get(key);

  if (!entry || now - entry.start > windowMs) {
    bucket.set(key, { start: now, count: 1 });
    stats.allowedTotal += 1;
    return { allowed: true, remaining: max - 1, retryAfter: 0 };
  }

  entry.count += 1;
  if (entry.count > max) {
    stats.blockedTotal += 1;
    recentBlocks.push({ at: now, bucket: bucketName, key });
    if (recentBlocks.length > 100) recentBlocks.shift();
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((entry.start + windowMs - now) / 1000),
    };
  }
  stats.allowedTotal += 1;
  return { allowed: true, remaining: Math.max(0, max - entry.count), retryAfter: 0 };
}

function getRateLimitStats() {
  const now = Date.now();
  return {
    allowedTotal: stats.allowedTotal,
    blockedTotal: stats.blockedTotal,
    blockedLast15min: recentBlocks.filter((b) => now - b.at < 15 * 60 * 1000).length,
    uptimeSec: Math.round((now - stats.startedAt) / 1000),
    buckets: Array.from(buckets.entries()).map(([name, b]) => ({ name, trackedKeys: b.size })),
    recentBlocks: recentBlocks.slice(-10).reverse().map((b) => ({
      at: new Date(b.at).toISOString(),
      bucket: b.bucket,
      ip: maskIp(b.key),
    })),
  };
}

// Periodic cleanup so old IPs don't bloat memory forever.
setInterval(() => {
  const now = Date.now();
  for (const [, bucket] of buckets) {
    for (const [k, entry] of bucket) {
      if (now - entry.start > 10 * 60 * 1000) bucket.delete(k);
    }
  }
}, 5 * 60 * 1000).unref?.();

module.exports = { clientIp, enforceRateLimit, getRateLimitStats };
