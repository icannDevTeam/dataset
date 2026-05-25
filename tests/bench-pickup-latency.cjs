#!/usr/bin/env node
/**
 * End-to-end pickup latency benchmark.
 *
 * Measures wall-clock time from "pickup_events doc written" → "iPad would
 * see it" under two delivery paths:
 *
 *   OLD (pre-fix): polling-only. SSE was broken in prod because
 *                  INTERNAL_NOTIFY_URL was never set — bus.broadcast() was
 *                  only invoked by the dead /api/pickup/internal/notify
 *                  endpoint. iPad effectively fell back to POLL_MS=2500ms,
 *                  so detection latency ~= U(0, 2500] ms with mean ~1250ms.
 *
 *   NEW (current): Firestore onSnapshot listener inside lib/pickup-event-bus.js
 *                  fires the moment the write commits. SSE frame is pushed
 *                  to the subscriber immediately — no polling cycle wait.
 *
 * Both paths are exercised against REAL Firestore using a synthetic
 * pickup_events doc written to a `_bench/` namespace so production logic
 * is not polluted. Docs are deleted after each iteration.
 *
 * Usage:
 *   node tests/bench-pickup-latency.cjs           # 5 iterations
 *   ITER=20 node tests/bench-pickup-latency.cjs   # 20 iterations
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_JSON env (the project default).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const admin = require('firebase-admin');

// Inline init (lib/firebase-admin.js is ESM and can't be require()'d from CJS).
function clean(v) {
  if (v == null) return '';
  let s = String(v);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}
if (!admin.apps.length) {
  const privateKey = clean(process.env.FIREBASE_PRIVATE_KEY)
    .replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      type: 'service_account',
      project_id: clean(process.env.FIREBASE_PROJECT_ID),
      private_key_id: clean(process.env.FIREBASE_PRIVATE_KEY_ID),
      private_key: privateKey,
      client_email: clean(process.env.FIREBASE_CLIENT_EMAIL),
      client_id: clean(process.env.FIREBASE_CLIENT_ID),
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
    storageBucket: clean(process.env.FIREBASE_STORAGE_BUCKET),
  });
}
const db = admin.firestore();

const TENANT_ID = process.env.BENCH_TENANT_ID || 'binus-simprug';
const ITER = parseInt(process.env.ITER || '5', 10);
const OLD_POLL_MS = 2500;

const COLL = `_bench/pickup-latency/${TENANT_ID}`;

// ── Path A: NEW (onSnapshot inside bus) ─────────────────────────────────────
async function measureSnapshot() {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const marker = `bench-${process.pid}-${startMs}-${Math.random().toString(36).slice(2, 8)}`;
    const ref = db.collection(COLL);

    // Listen only for OUR marker to avoid cross-talk between iterations.
    const startTs = admin.firestore.Timestamp.fromMillis(startMs - 1000);
    const unsub = ref
      .where('recordedAt', '>=', startTs)
      .onSnapshot((snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const data = change.doc.data();
          if (data.marker !== marker) continue;
          const elapsed = Date.now() - startMs;
          unsub();
          ref.doc(change.doc.id).delete().catch(() => {});
          resolve(elapsed);
          return;
        }
      }, reject);

    // Tiny delay so the listener is fully attached before we write.
    setTimeout(() => {
      ref.add({
        marker,
        recordedAt: admin.firestore.Timestamp.fromMillis(Date.now()),
        path: 'NEW_snapshot',
      }).catch(reject);
    }, 50);

    setTimeout(() => { unsub(); reject(new Error('timeout NEW')); }, 10_000);
  });
}

// ── Path B: OLD (poll a Firestore query every POLL_MS) ──────────────────────
async function measurePolling() {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const marker = `bench-${process.pid}-${startMs}-${Math.random().toString(36).slice(2, 8)}`;
    const ref = db.collection(COLL);

    // Schedule the write at t≈0 so polling has to "catch" it on a future tick.
    ref.add({
      marker,
      recordedAt: admin.firestore.Timestamp.fromMillis(Date.now()),
      path: 'OLD_polling',
    }).catch(reject);

    let interval;
    let timedOut = false;
    const startTs = admin.firestore.Timestamp.fromMillis(startMs - 1000);

    const poll = async () => {
      if (timedOut) return;
      const snap = await ref
        .where('recordedAt', '>=', startTs)
        .get();
      for (const d of snap.docs) {
        if (d.data().marker === marker) {
          clearInterval(interval);
          const elapsed = Date.now() - startMs;
          d.ref.delete().catch(() => {});
          return resolve(elapsed);
        }
      }
    };

    interval = setInterval(poll, OLD_POLL_MS);
    setTimeout(() => {
      timedOut = true;
      clearInterval(interval);
      reject(new Error('timeout OLD'));
    }, 15_000);
  });
}

// ── Stats ───────────────────────────────────────────────────────────────────
function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    label,
    n: samples.length,
    min: sorted[0],
    p50: p(0.5),
    p95: p(0.95),
    max: sorted[sorted.length - 1],
    mean: Math.round(mean),
  };
}

function fmt(row) {
  return `${row.label.padEnd(18)} n=${row.n}  min=${String(row.min).padStart(5)}ms  ` +
         `p50=${String(row.p50).padStart(5)}ms  p95=${String(row.p95).padStart(5)}ms  ` +
         `max=${String(row.max).padStart(5)}ms  mean=${String(row.mean).padStart(5)}ms`;
}

// ── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nPickup-event latency benchmark`);
  console.log(`  tenant=${TENANT_ID}  iterations=${ITER}  oldPoll=${OLD_POLL_MS}ms`);
  console.log(`  collection=${COLL}\n`);

  const newSamples = [];
  const oldSamples = [];

  for (let i = 0; i < ITER; i++) {
    process.stdout.write(`  iter ${i + 1}/${ITER}: `);
    try {
      const t = await measureSnapshot();
      newSamples.push(t);
      process.stdout.write(`NEW=${String(t).padStart(4)}ms  `);
    } catch (e) {
      process.stdout.write(`NEW=ERR(${e.message})  `);
    }
    try {
      const t = await measurePolling();
      oldSamples.push(t);
      process.stdout.write(`OLD=${String(t).padStart(4)}ms\n`);
    } catch (e) {
      process.stdout.write(`OLD=ERR(${e.message})\n`);
    }
  }

  console.log('\nResults');
  console.log('  ' + fmt(summarize('NEW (onSnapshot)', newSamples)));
  console.log('  ' + fmt(summarize('OLD (poll 2500ms)', oldSamples)));

  if (newSamples.length && oldSamples.length) {
    const newP95 = summarize('', newSamples).p95;
    const oldP95 = summarize('', oldSamples).p95;
    const speedup = (oldP95 / newP95).toFixed(1);
    console.log(`\n  p95 speedup: ${speedup}x  (${oldP95}ms → ${newP95}ms)`);
  }

  process.exit(0);
})().catch((e) => {
  console.error('bench failed:', e);
  process.exit(1);
});
