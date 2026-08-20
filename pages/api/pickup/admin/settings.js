/**
 * GET  /api/pickup/admin/settings  — read pickup settings doc
 * POST /api/pickup/admin/settings  — update pickup settings (merge)
 *
 * Supported fields (body):
 *   allowSelfClaim  boolean  — TV can self-claim via kiosk code without admin
 *
 * RBAC: GET requires `pickup_admin.settings_view`,
 *       POST requires `pickup_admin.settings_edit`.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');
const { withApi } = require('../../../../lib/api-auth');
const { can } = require('../../../../lib/rbac');

function isValidHHMM(value) {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value);
}

async function handler(req, res) {
  // Per-method permission split is enforced inside the handler so a single
  // wrapper can serve both verbs.
  if (req.method === 'POST' && !req.user.superAdmin && !can(req.user.permissions, 'pickup_admin.settings_edit')) {
    return res.status(403).json({ error: 'forbidden', need: ['pickup_admin.settings_edit'] });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const docRef = db.doc(tenancy.pickupSettingsDoc(tid));

    if (req.method === 'GET') {
      const snap = await docRef.get();
      const data = snap.exists ? snap.data() : {};
      return res.status(200).json({
        ok: true,
        settings: {
          allowSelfClaim: data.allowSelfClaim === true,
          pickupWindow: {
            start: data?.pickupWindow?.start || '10:00',
            end: data?.pickupWindow?.end || '13:00',
          },
          pickupWindowByDay: {
            ...(data?.pickupWindowByDay || {}),
          },
        },
      });
    }

    // POST — validate and merge
    const body = req.body || {};
    const patch = {};

    if ('allowSelfClaim' in body) {
      if (typeof body.allowSelfClaim !== 'boolean') {
        return res.status(400).json({ error: 'allowSelfClaim must be a boolean' });
      }
      patch.allowSelfClaim = body.allowSelfClaim;
    }

    if ('pickupWindow' in body) {
      const start = String(body?.pickupWindow?.start || '').trim();
      const end = String(body?.pickupWindow?.end || '').trim();
      if (!isValidHHMM(start) || !isValidHHMM(end)) {
        return res.status(400).json({ error: 'pickupWindow.start/end must be HH:MM' });
      }
      patch.pickupWindow = { start, end };
    }

    if ('pickupWindowByDay' in body) {
      const byDay = body.pickupWindowByDay;
      if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) {
        return res.status(400).json({ error: 'pickupWindowByDay must be an object' });
      }
      const out = {};
      for (const [k, raw] of Object.entries(byDay)) {
        const key = String(k || '').trim().toLowerCase();
        if (!['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(key)) continue;
        if (!raw || typeof raw !== 'object') continue;
        const row = {};
        if (raw.closedAllDay === true) {
          row.closedAllDay = true;
        } else {
          const start = String(raw.start || raw.open || '').trim();
          const end = String(raw.end || raw.close || '').trim();
          if (!isValidHHMM(start) || !isValidHHMM(end)) {
            return res.status(400).json({ error: `pickupWindowByDay.${key} must contain valid start/end HH:MM` });
          }
          row.start = start;
          row.end = end;
          row.closedAllDay = false;
        }
        out[key] = row;
      }
      patch.pickupWindowByDay = out;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no valid fields in body' });
    }

    const beforeSnap = await docRef.get();
    const before = beforeSnap.exists ? beforeSnap.data() : {};

    await docRef.set(patch, { merge: true });

    // Single source of truth: when tenant-level pickup windows are edited,
    // mirror them to every terminal so admin terminal views and backend logic
    // stay aligned without per-terminal drift.
    if (patch.pickupWindow || patch.pickupWindowByDay) {
      const effectiveSettings = {
        ...(before || {}),
        ...(patch || {}),
      };
      const defaultStart = effectiveSettings?.pickupWindow?.start || null;
      const defaultEnd = effectiveSettings?.pickupWindow?.end || null;
      const fri = effectiveSettings?.pickupWindowByDay?.fri || null;

      const terms = await db.collection(tenancy.terminalsPath(tid)).get();
      const writes = [];
      for (const t of terms.docs) {
        const td = t.data() || {};
        const weekly = { ...(td.weeklyWindowByDay || {}) };
        if (fri && fri.closedAllDay === true) {
          weekly.fri = { closedAllDay: true };
        } else if (fri && isValidHHMM(fri.start) && isValidHHMM(fri.end)) {
          weekly.fri = { start: fri.start, end: fri.end, closedAllDay: false };
        }

        const termPatch = {
          weeklyWindowByDay: weekly,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (isValidHHMM(defaultStart) && isValidHHMM(defaultEnd)) {
          termPatch.windowOpen = defaultStart;
          termPatch.windowClose = defaultEnd;
        }
        writes.push(t.ref.set(termPatch, { merge: true }));
      }
      await Promise.all(writes);
    }

    await logAudit(db, {
      tenantId: tid,
      actor: { email: req.user.email, name: req.user.name, role: req.user.role },
      req,
      kind: 'settings.update',
      target: { type: 'pickup_settings', id: 'pickup', label: 'Pickup Settings' },
      before: Object.fromEntries(Object.keys(patch).map(k => [k, before[k] ?? null])),
      after: patch,
      summary: `Updated pickup settings: ${Object.keys(patch).join(', ')}`,
    });
    return res.status(200).json({ ok: true, updated: patch });
  } catch (e) {
    console.error('[pickup/admin/settings]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, {
  methods: ['GET', 'POST'],
  // GET only needs the view grant; POST also needs settings_edit (checked above).
  permission: 'pickup_admin.settings_view',
});
