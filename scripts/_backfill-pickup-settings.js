const path = require('path');
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve('../facial-attendance-binus-firebase-adminsdk.json');
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const TID = 'binus-simprug';
const PATCH = {
  cooldownSeconds: 300,
  warmupMinutes: 30,
  enforceWindow: true,
};
(async () => {
  const ref = db.doc(`tenants/${TID}/settings/pickup`);
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : {};
  const next = { ...cur };
  let changed = false;
  for (const [k, v] of Object.entries(PATCH)) {
    if (cur[k] === undefined) { next[k] = v; changed = true; }
  }
  console.log('current:', JSON.stringify(cur, null, 2));
  if (!changed) { console.log('nothing to patch — keys already present'); process.exit(0); }
  await ref.set(next, { merge: true });
  console.log('patched:', JSON.stringify(next, null, 2));
  process.exit(0);
})();
