import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { verifyCookie } from '../../auth/session';
const tenancy = require('../../../../lib/tenancy');
const { runPickupDemoSeed } = require('../../../../lib/pickup-demo-seeder');

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const p of raw.split(';').map((x) => x.trim())) {
    if (p.startsWith(`${name}=`)) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const sessionMarker = readCookie(req, '__session');
  const session = sessionMarker ? verifyCookie(sessionMarker) : null;
  if (!session?.email) return res.status(401).json({ error: 'login required' });

  try {
    initializeFirebase();
    const db = admin.firestore();
    const actorEmail = String(session.email).toLowerCase();
    const userSnap = await db.collection('dashboard_users').doc(actorEmail).get();
    if (!userSnap.exists) return res.status(403).json({ error: 'account not authorized' });

    const user = userSnap.data() || {};
    const role = String(user.role || 'viewer');
    if (!['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'insufficient role' });
    }

    const tid = req.body?.tenant ? String(req.body.tenant) : tenancy.getTenantId();
    const profileId = req.body?.profileId ? String(req.body.profileId) : null;
    const profileName = req.body?.profileName ? String(req.body.profileName) : null;
    const eventCount = req.body?.eventCount != null ? Number(req.body.eventCount) : null;

    const seed = await runPickupDemoSeed({
      db,
      tid,
      profileId,
      profileName,
      force: true,
      reason: 'manual_admin',
      actorEmail,
      eventCount,
    });

    return res.status(200).json({ ok: true, seed });
  } catch (e) {
    console.error('[pickup/admin/demo-seed]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
