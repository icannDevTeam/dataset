/**
 * LAN listener manager controls.
 *
 * GET  /api/pickup/admin/listeners              -> manager status + log tail
 * POST /api/pickup/admin/listeners {action}     -> start | stop | restart
 *
 * This endpoint intentionally controls only the local physical computer where
 * the Next.js dashboard is running. It is for LAN deployments, not Vercel.
 */
import { withApi, can } from '../../../../lib/api-auth';
import {
  getListenerManagerStatus,
  startListenerManager,
  stopListenerManager,
} from '../../../../lib/listener-manager.js';

function deny(res) {
  return res.status(403).json({ error: 'forbidden' });
}

async function handler(req, res) {
  const perms = req.user?.permissions || {};
  const canView = req.user?.superAdmin || can(perms, 'pickup_admin.view');
  const canManage = req.user?.superAdmin || can(perms, 'pickup_admin.manage_terminals');

  if (req.method === 'GET') {
    if (!canView) return deny(res);
    return res.status(200).json({ ok: true, status: getListenerManagerStatus() });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!canManage) return deny(res);

  const action = String(req.body?.action || '').trim().toLowerCase();
  if (action === 'start') {
    const result = startListenerManager({
      noFirebase: req.body?.noFirebase === true,
      allowPartial: req.body?.allowPartial === true,
    });
    return res.status(200).json({ ok: true, action, ...result });
  }

  if (action === 'stop') {
    const result = stopListenerManager();
    return res.status(200).json({ ok: true, action, ...result });
  }

  if (action === 'restart') {
    stopListenerManager();
    const result = startListenerManager({
      noFirebase: req.body?.noFirebase === true,
      allowPartial: req.body?.allowPartial === true,
    });
    return res.status(200).json({ ok: true, action, ...result });
  }

  return res.status(400).json({ error: 'invalid action' });
}

export default withApi(handler, { permission: 'pickup_admin.view' });