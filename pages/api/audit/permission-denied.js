/**
 * POST /api/audit/permission-denied
 *
 * Fire-and-forget endpoint that records UI-side permission denials so the
 * security team has visibility into denial patterns (which users hit which
 * locked pages, how often).
 *
 * Body: { feature, action, path }
 *
 * Always returns 204 — the UI never blocks on this. Auditing failures are
 * swallowed so this endpoint cannot break a user flow.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { withApi } = require('../../../lib/api-auth');

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const feature = typeof body.feature === 'string' ? body.feature.slice(0, 64) : null;
  const action  = typeof body.action  === 'string' ? body.action.slice(0, 64)  : null;
  const path    = typeof body.path    === 'string' ? body.path.slice(0, 256)   : null;

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();

    await logAudit(db, {
      tenantId: tid,
      actor: {
        email: req.user?.email || null,
        name: req.user?.name || null,
        role: req.user?.role || null,
      },
      req,
      kind: 'permission.denied',
      target: feature ? { type: 'permission', id: `${feature}.${action || '?'}`, label: `${feature}.${action || '?'}` } : null,
      summary: `UI permission denied: ${feature || '?'}.${action || '?'}${path ? ` on ${path}` : ''}`,
      metadata: { feature, action, path, source: 'ui' },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit/permission-denied] failed:', err?.message || err);
  }

  return res.status(204).end();
}

module.exports = withApi(handler, { requireUser: true });
