/**
 * scripts/cleanup-dummy-chaperones.js
 *
 * Removes "dummy" chaperone records that show up on /v2/pickup-enroll as
 * LOCKED / NEEDS PHOTO cards. These are leftover test docs in
 * `tenants/<tid>/chaperones` that have no face photos uploaded — they
 * were not produced by a real onboarding form submission.
 *
 * A chaperone is considered "dummy" when ALL of these are true:
 *   - status is 'approved' or 'approved_pending_faces'
 *   - facePaths is missing or empty (photoCount == 0)
 *   - not suspended
 *
 * Usage:
 *   node scripts/cleanup-dummy-chaperones.js              # DRY RUN — lists candidates
 *   node scripts/cleanup-dummy-chaperones.js --apply      # actually delete
 *   node scripts/cleanup-dummy-chaperones.js --apply --tenant=binus-simprug
 */
const admin = require('firebase-admin');
const path = require('path');

const SERVICE_ACCOUNT = require(
  path.join(__dirname, '..', '..', 'facial-attendance-binus-firebase-adminsdk.json')
);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TENANT = (args.find((a) => a.startsWith('--tenant=')) || '--tenant=binus-simprug').split('=')[1];

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(SERVICE_ACCOUNT) });
}
const db = admin.firestore();

(async () => {
  const colPath = `tenants/${TENANT}/chaperones`;
  console.log(`\n[cleanup] tenant=${TENANT} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[cleanup] scanning ${colPath} …\n`);

  const snap = await db.collection(colPath).get();
  if (snap.empty) {
    console.log('  (no chaperones found)');
    process.exit(0);
  }

  const candidates = [];
  const keep = [];
  snap.forEach((d) => {
    const c = d.data() || {};
    const photoCount = Array.isArray(c.facePaths) ? c.facePaths.length : 0;
    const isApproved = ['approved', 'approved_pending_faces'].includes(c.status);
    const suspended = !!c.suspendedAt;
    if (isApproved && !suspended && photoCount === 0) {
      candidates.push({ id: d.id, name: c.name, relation: c.relation, status: c.status, employeeNo: c.employeeNo, phone: c.phone });
    } else {
      keep.push({ id: d.id, name: c.name, photoCount, status: c.status, suspended });
    }
  });

  console.log(`  Total chaperones:        ${snap.size}`);
  console.log(`  Will KEEP (real/photos): ${keep.length}`);
  console.log(`  Will DELETE (no photos): ${candidates.length}\n`);

  if (candidates.length === 0) {
    console.log('  Nothing to clean up.');
    process.exit(0);
  }

  console.log('--- Candidates for deletion ---');
  candidates.forEach((c, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${c.name || '(no name)'}  [${c.relation || '?'}]  status=${c.status}  phone=${c.phone || '-'}  id=${c.id}`);
  });
  console.log('');

  if (!APPLY) {
    console.log('  DRY RUN. Re-run with --apply to actually delete these docs.');
    process.exit(0);
  }

  console.log('  Deleting …');
  let deleted = 0;
  // Firestore batch limit is 500; chunk just in case.
  for (let i = 0; i < candidates.length; i += 400) {
    const chunk = candidates.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach((c) => batch.delete(db.collection(colPath).doc(c.id)));
    await batch.commit();
    deleted += chunk.length;
  }
  console.log(`  Deleted ${deleted} dummy chaperone docs.`);
  process.exit(0);
})().catch((e) => {
  console.error('[cleanup] FAILED:', e.message);
  process.exit(1);
});
