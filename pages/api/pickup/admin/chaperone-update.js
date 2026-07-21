/**
 * POST /api/pickup/admin/chaperone-update
 *
 * Edit mutable chaperone fields and/or update lifecycle status.
 *
 * Body:
 * {
 *   chaperoneId: string,
 *   patch?: {
 *     name?: string,
 *     relation?: string,
 *     phone?: string|null,
 *     email?: string|null,
 *     idNumber?: string|null,
 *     status?: 'pending'|'approved'|'approved_pending_faces'|'suspended'
 *   }
 * }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

const ALLOWED_RELATIONS = new Set([
  'mother', 'father', 'parent', 'guardian', 'driver', 'nanny',
  'grandparent', 'sibling', 'emergency', 'other',
]);
const ALLOWED_STATUS = new Set(['pending', 'approved', 'approved_pending_faces', 'suspended']);

function cleanText(v, max = 120) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

async function handler(req, res) {
  if (!['POST', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'method' });
  }

  try {
    const { chaperoneId, patch } = req.body || {};
    if (!chaperoneId || typeof chaperoneId !== 'string') {
      return res.status(400).json({ error: 'chaperoneId required' });
    }

    const p = patch && typeof patch === 'object' ? patch : {};
    const update = {};

    if (Object.prototype.hasOwnProperty.call(p, 'name')) {
      const name = cleanText(p.name, 80);
      if (!name || name.length < 2) {
        return res.status(400).json({ error: 'invalid_name', message: 'Name must be 2-80 characters.' });
      }
      update.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(p, 'relation')) {
      const rel = cleanText(p.relation, 32)?.toLowerCase();
      if (!rel || !ALLOWED_RELATIONS.has(rel)) {
        return res.status(400).json({ error: 'invalid_relation' });
      }
      update.relation = rel;
      // Keep backward compatibility for screens using relationship.
      update.relationship = rel;
    }

    if (Object.prototype.hasOwnProperty.call(p, 'phone')) {
      const phone = cleanText(p.phone, 24);
      update.phone = phone;
    }

    if (Object.prototype.hasOwnProperty.call(p, 'email')) {
      const email = cleanText(p.email, 128);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      update.email = email ? email.toLowerCase() : null;
    }

    if (Object.prototype.hasOwnProperty.call(p, 'idNumber')) {
      update.idNumber = cleanText(p.idNumber, 32);
    }

    if (Object.prototype.hasOwnProperty.call(p, 'status')) {
      const nextStatus = cleanText(p.status, 40)?.toLowerCase();
      if (!nextStatus || !ALLOWED_STATUS.has(nextStatus)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      update.status = nextStatus;
      if (nextStatus === 'suspended') {
        update.suspended = true;
        update.suspendedAt = new Date().toISOString();
      } else {
        update.suspended = false;
        update.suspendedAt = null;
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no_editable_fields' });
    }

    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'chaperone_not_found' });

    const before = snap.data() || {};
    if (before.lifecycleStatus === 'deleted') {
      return res.status(409).json({ error: 'chaperone_deleted', message: 'Restore this chaperone first.' });
    }

    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(update, { merge: true });

    const actor = {
      uid: req.user?.email || null,
      email: req.user?.email || null,
      name: req.user?.name || null,
      role: req.user?.role || null,
    };

    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: Object.prototype.hasOwnProperty.call(update, 'status')
        ? 'chaperone.status_update'
        : 'chaperone.edit',
      target: { type: 'chaperone', id: chaperoneId, label: before.name || chaperoneId },
      before: {
        name: before.name || null,
        relation: before.relation || before.relationship || null,
        phone: before.phone || null,
        email: before.email || null,
        idNumber: before.idNumber || null,
        status: before.status || null,
        suspended: !!before.suspended,
      },
      after: {
        name: Object.prototype.hasOwnProperty.call(update, 'name') ? update.name : before.name || null,
        relation: Object.prototype.hasOwnProperty.call(update, 'relation') ? update.relation : (before.relation || before.relationship || null),
        phone: Object.prototype.hasOwnProperty.call(update, 'phone') ? update.phone : before.phone || null,
        email: Object.prototype.hasOwnProperty.call(update, 'email') ? update.email : before.email || null,
        idNumber: Object.prototype.hasOwnProperty.call(update, 'idNumber') ? update.idNumber : before.idNumber || null,
        status: Object.prototype.hasOwnProperty.call(update, 'status') ? update.status : before.status || null,
        suspended: Object.prototype.hasOwnProperty.call(update, 'suspended') ? !!update.suspended : !!before.suspended,
      },
      summary: `Updated chaperone ${before.name || chaperoneId}`,
      metadata: { changedKeys: Object.keys(update).filter((k) => k !== 'updatedAt') },
      req,
    });

    return res.status(200).json({ ok: true, chaperoneId, updated: Object.keys(update) });
  } catch (err) {
    console.error('[pickup/admin/chaperone-update]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, {
  methods: ['POST', 'PATCH'],
  permission: 'pickup_admin.edit_chaperone',
  rateLimit: 40,
});
