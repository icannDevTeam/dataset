/**
 * Admin endpoint for Pickup System onboarding invite links.
 *
 *   GET    /api/pickup/admin/invite-links            → list all
 *   POST   /api/pickup/admin/invite-links            → create
 *            body: { name, description?, ttlDays?, maxUses? }
 *   PATCH  /api/pickup/admin/invite-links?id=<lid>   → update
 *            body: { name?, description?, enabled?, maxUses? }
 *   DELETE /api/pickup/admin/invite-links?id=<lid>           → revoke (soft)
 *   DELETE /api/pickup/admin/invite-links?id=<lid>&hard=1    → permanent
 *
 * Auth: requires dashboard auth (withAuth).
 *
 * The admin who calls POST gets back a fully-formed `url` and `token`
 * suitable for pasting into a parent communication. There's no need
 * to ever re-derive a URL on the client.
 */
import QRCode from 'qrcode';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi, can } from '../../../../lib/api-auth';
import * as invites from '../../../../lib/onboarding-invites';
const admin = require('firebase-admin');
const tenancy = require('../../../../lib/tenancy');

function deny(res) {
  return res.status(403).json({ error: 'forbidden' });
}

async function handler(req, res) {
  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId(req.query?.tenant);
    const perms = req.user?.permissions || {};
    const canView = req.user?.superAdmin || can(perms, 'pickup_admin.view');
    const canWrite = req.user?.superAdmin || can(perms, 'pickup_admin.edit_chaperone');

    if (req.method === 'GET' && !canView) return deny(res);
    if (req.method !== 'GET' && !canWrite) return deny(res);

    if (req.method === 'GET') {
      const id = req.query.id ? String(req.query.id) : null;
      if (id) {
        const inv = await invites.getInvite(db, tid, id);
        if (!inv) return res.status(404).json({ error: 'not_found' });
        if (req.query.qr === '1' && inv.url) {
          inv.qrDataUrl = await QRCode.toDataURL(inv.url, { width: 512, margin: 1 });
        }
        return res.status(200).json({ ok: true, invite: inv });
      }
      const list = await invites.listInvites(db, tid);
      return res.status(200).json({ ok: true, invites: list });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      const createdBy = req.user?.uid || req.user?.email || 'admin';
      const inv = await invites.createInvite(db, tid, {
        name,
        description: body.description,
        ttlDays: body.ttlDays,
        maxUses: body.maxUses,
        windowOpenAt: body.windowOpenAt,
        windowCloseAt: body.windowCloseAt,
        createdBy,
        // Make the invite URL match the host the admin is actually using,
        // so links never point to a stale env-var or rotating preview URL.
        preferredBaseUrl: invites.baseUrlFromRequest(req),
      });
      // Return a QR code with the freshly minted link so admin can
      // copy / scan / preview without a second round-trip.
      try {
        inv.qrDataUrl = await QRCode.toDataURL(inv.url, { width: 512, margin: 1 });
      } catch (qrErr) {
        console.warn('[invite-links] QR generation failed:', qrErr.message);
      }
      return res.status(201).json({ ok: true, invite: inv });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const patch = { ...(req.body || {}) };
      // Pass the live request host through so any token re-sign that
      // happens during an "extend" lands on the correct base URL.
      if (!patch.preferredBaseUrl) {
        patch.preferredBaseUrl = invites.baseUrlFromRequest(req);
      }
      const inv = await invites.updateInvite(db, tid, id, patch);
      if (!inv) return res.status(404).json({ error: 'not_found' });
      // Re-issue a QR if the URL was rotated (extension re-signs the token).
      if (req.query.qr === '1' && inv.url) {
        try {
          inv.qrDataUrl = await QRCode.toDataURL(inv.url, { width: 512, margin: 1 });
        } catch (qrErr) {
          console.warn('[invite-links] QR regenerate failed:', qrErr.message);
        }
      }
      return res.status(200).json({ ok: true, invite: inv });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (req.query.hard === '1') {
        await invites.deleteInvite(db, tid, id);
        return res.status(200).json({ ok: true, id, hard: true });
      }
      const inv = await invites.revokeInvite(db, tid, id);
      return res.status(200).json({ ok: true, invite: inv });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[pickup/admin/invite-links]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, {
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  requireUser: true,
});
