import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { createRequire } from 'module';
import { initializeFirebase } from '../lib/firebase-admin.js';

const require = createRequire(import.meta.url);
const tenancy = require('../lib/tenancy');
const { buildOnboardingSearchPrefixes } = require('../lib/pickup-search');

dotenv.config({ path: '../.env' });

function parseArgs(argv) {
  const out = { tenant: null, limit: 0, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tenant') out.tenant = argv[i + 1] || null;
    if (a === '--limit') out.limit = Math.max(0, parseInt(argv[i + 1] || '0', 10) || 0);
    if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function arrayEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function run() {
  const args = parseArgs(process.argv);
  initializeFirebase();
  const db = admin.firestore();

  const tid = args.tenant || tenancy.getTenantId();
  const path = tenancy.pickupOnboardingPath(tid);

  let processed = 0;
  let updated = 0;
  let cursor = null;
  const pageSize = 250;

  console.log(`[backfill] tenant=${tid} path=${path} dryRun=${args.dryRun}`);

  while (true) {
    let q = db.collection(path).orderBy('submittedAt', 'desc').limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    let batchWrites = 0;

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const nextPrefixes = buildOnboardingSearchPrefixes({ id: doc.id, ...data }).sort();
      const curPrefixes = Array.isArray(data.searchPrefixes) ? [...data.searchPrefixes].sort() : [];
      const needsUpdate = !arrayEqual(curPrefixes, nextPrefixes) || Number(data.searchIndexVersion || 0) !== 1;

      processed += 1;
      if (needsUpdate) {
        updated += 1;
        if (!args.dryRun) {
          batch.set(doc.ref, {
            searchPrefixes: nextPrefixes,
            searchIndexVersion: 1,
            searchIndexedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          batchWrites += 1;
        }
      }

      if (args.limit > 0 && processed >= args.limit) break;
    }

    if (!args.dryRun && batchWrites > 0) {
      await batch.commit();
    }

    cursor = snap.docs[snap.docs.length - 1];
    console.log(`[backfill] processed=${processed} updated=${updated}`);

    if (args.limit > 0 && processed >= args.limit) break;
    if (snap.size < pageSize) break;
  }

  console.log(`[backfill] done processed=${processed} updated=${updated}`);
}

run().catch((err) => {
  console.error('[backfill] failed', err.message);
  process.exit(1);
});
