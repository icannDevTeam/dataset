const path = require('path');
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve('../facial-attendance-binus-firebase-adminsdk.json');
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const TID = 'binus-simprug';
(async () => {
  const groups = await db.collection(`tenants/${TID}/release_groups`).get();
  console.log(`\nrelease_groups: ${groups.size}`);
  groups.forEach(d => {
    const g = d.data();
    console.log(`  ${d.id}: name="${g.name}" grade="${g.gradeLabel}" terminals=${JSON.stringify(g.terminalIds)} pair=${g.pairingCode || '-'} pairExp=${g.pairingCodeExpiresAt?.toDate?.() || '-'}`);
  });
  const tabs = await db.collection(`tenants/${TID}/tablet_devices`).get();
  console.log(`\ntablet_devices: ${tabs.size}`);
  tabs.forEach(d => {
    const t = d.data();
    console.log(`  ${d.id}: status=${t.status} group=${t.releaseGroupId} lastSeen=${t.lastSeenAt?.toDate?.() || '-'}`);
  });
  process.exit(0);
})();
