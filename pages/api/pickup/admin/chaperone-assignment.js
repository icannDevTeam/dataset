import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { can } = require('../../../../lib/rbac');
const { logAudit } = require('../../../../lib/audit-log');

const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1h — short-lived so storage paths never leak

function normalizeScopeToken(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return [];
  // Keep matching exact. Expanding EY1/EY2/EY3 to EY caused one EY sibling
  // to match every EY terminal, which is what created the spillover.
  if (raw === 'EY') return ['EY'];
  const m = raw.match(/^(\d{1,2})/);
  if (m) return [m[1]];
  return [raw];
}

function deriveChaperoneScopes(ch) {
  const out = new Set();
  const add = (v) => normalizeScopeToken(v).forEach((x) => out.add(x));
  (ch?.studentGrades || []).forEach(add);
  (ch?.studentClasses || []).forEach(add);
  return [...out];
}

function normalizeTerminal(doc) {
  const gradeScopes = Array.isArray(doc?.gradeScopes)
    ? doc.gradeScopes.map((x) => String(x).trim()).filter(Boolean)
    : [];
  return {
    id: String(doc?.id || ''),
    name: doc?.name || doc?.deviceName || doc?.ip || 'Unknown terminal',
    ip: doc?.ip || null,
    releaseGroupId: doc?.releaseGroupId || null,
    gradeScopes,
  };
}

function terminalMatchesScopes(terminal, chaperoneScopes) {
  if (!terminal?.gradeScopes?.length) return true;
  if (!chaperoneScopes?.length) return true;
  const wanted = new Set(chaperoneScopes.map((v) => String(v).toUpperCase()));
  return terminal.gradeScopes.some((scope) => normalizeScopeToken(scope).some((tok) => wanted.has(tok)));
}

function requireEditPermission(req, res) {
  if (req.user?.superAdmin) return true;
  if (can(req.user?.permissions, 'pickup_admin.edit_chaperone')) return true;
  res.status(403).json({ error: 'forbidden', need: ['pickup_admin.edit_chaperone'] });
  return false;
}

async function loadTerminals(db, tid) {
  const snap = await db.collection(tenancy.terminalsPath(tid)).get();
  const terminals = [];
  snap.forEach((d) => terminals.push(normalizeTerminal({ id: d.id, ...(d.data() || {}) })));
  terminals.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return terminals;
}

function buildAssignmentView(ch, terminals) {
  const chaperoneScopes = deriveChaperoneScopes(ch);
  const derivedTerminalIds = terminals
    .filter((t) => terminalMatchesScopes(t, chaperoneScopes))
    .map((t) => t.id);

  const requestedOverride = Array.isArray(ch?.allowedTerminalIds)
    ? [...new Set(ch.allowedTerminalIds.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  const terminalIdSet = new Set(terminals.map((t) => t.id));
  const overrideTerminalIds = requestedOverride.filter((id) => terminalIdSet.has(id));
  const missingOverrideTerminalIds = requestedOverride.filter((id) => !terminalIdSet.has(id));

  const mode = ch?.assignmentMode === 'override' && overrideTerminalIds.length > 0
    ? 'override'
    : 'derived';

  const effectiveTerminalIds = mode === 'override' ? overrideTerminalIds : derivedTerminalIds;

  return {
    chaperoneScopes,
    derivedTerminalIds,
    overrideTerminalIds,
    missingOverrideTerminalIds,
    effectiveTerminalIds,
    assignmentMode: mode,
  };
}

async function handler(req, res) {
  const tid = tenancy.getTenantId(req.query.tenant);
  initializeFirebase();
  const db = admin.firestore();

  if (req.method === 'GET') {
    try {
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '600', 10)));
      const q = String(req.query.q || '').trim().toLowerCase();
      const terminals = await loadTerminals(db, tid);

      const snap = await db.collection(tenancy.chaperonesPath(tid)).limit(limit).get();
      const items = [];
      const facePathByItemId = {};
      snap.forEach((d) => {
        const ch = { id: d.id, ...(d.data() || {}) };
        if ((ch.lifecycleStatus || 'active') === 'deleted') return;
        const view = buildAssignmentView(ch, terminals);
        const hay = [
          ch.name,
          ch.employeeNo,
          ...(ch.studentClasses || []),
          ...(ch.studentGrades || []),
        ].filter(Boolean).join(' ').toLowerCase();
        if (q && !hay.includes(q)) return;

        // Resolve preferred face photo path (admin-uploaded > parent-uploaded).
        const facePath =
          (Array.isArray(ch.facePaths) && ch.facePaths[0]) ||
          (typeof ch.photoUrl === 'string' && ch.photoUrl) ||
          (Array.isArray(ch.photoUrls) && ch.photoUrls[0]) ||
          null;
        if (facePath) facePathByItemId[ch.id] = facePath;

        items.push({
          id: ch.id,
          employeeNo: ch.employeeNo || null,
          name: ch.name || '—',
          relation: ch.relation || ch.relationship || null,
          status: ch.status || null,
          studentClasses: Array.isArray(ch.studentClasses) ? ch.studentClasses : [],
          studentGrades: Array.isArray(ch.studentGrades) ? ch.studentGrades : [],
          allowedTerminalIds: Array.isArray(ch.allowedTerminalIds) ? ch.allowedTerminalIds : [],
          assignmentUpdatedAt: ch.assignmentUpdatedAt || null,
          assignmentUpdatedBy: ch.assignmentUpdatedBy || null,
          deviceEnrolled: ch.deviceEnrolled === true,
          deviceEnrollAttemptedAt: ch.deviceEnrollAttemptedAt || null,
          deviceEnrollErrors: Array.isArray(ch.deviceEnrollErrors) ? ch.deviceEnrollErrors : [],
          deviceUnenrollAttemptedAt: ch.deviceUnenrollAttemptedAt || null,
          ...view,
        });
      });

      // Sign one face URL per chaperone in parallel (TTL 1h). Best-effort:
      // a missing storage object never breaks the row — UI falls back to initials.
      const bucket = admin.storage().bucket();
      const photoUrlById = {};
      await Promise.all(Object.entries(facePathByItemId).map(async ([itemId, p]) => {
        try {
          if (/^https?:\/\//.test(p)) { photoUrlById[itemId] = p; return; }
          const [u] = await bucket.file(p).getSignedUrl({
            action: 'read',
            expires: Date.now() + SIGNED_URL_TTL_MS,
          });
          photoUrlById[itemId] = u;
        } catch { /* best-effort */ }
      }));
      items.forEach((it) => { it.photoUrl = photoUrlById[it.id] || null; });

      items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return res.status(200).json({
        ok: true,
        tenantId: tid,
        terminals,
        total: items.length,
        items,
      });
    } catch (err) {
      console.error('[pickup/admin/chaperone-assignment:get]', err.message, err.stack);
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    if (!requireEditPermission(req, res)) return;
    try {
      const { chaperoneId, allowedTerminalIds } = req.body || {};
      if (!chaperoneId || typeof chaperoneId !== 'string') {
        return res.status(400).json({ error: 'chaperoneId required' });
      }
      if (!Array.isArray(allowedTerminalIds) || allowedTerminalIds.length === 0) {
        return res.status(400).json({ error: 'allowedTerminalIds must be a non-empty array' });
      }

      const terminals = await loadTerminals(db, tid);
      const terminalIdSet = new Set(terminals.map((t) => t.id));
      const deduped = [...new Set(allowedTerminalIds.map((x) => String(x).trim()).filter(Boolean))];
      if (deduped.length > 20) {
        return res.status(400).json({ error: 'too_many_terminals', message: 'Maximum 20 terminals per override.' });
      }
      const invalid = deduped.filter((id) => !terminalIdSet.has(id));
      if (invalid.length) {
        return res.status(400).json({ error: 'invalid_terminal_ids', invalid });
      }

      const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'chaperone_not_found' });
      const before = snap.data() || {};

      const update = {
        assignmentMode: 'override',
        allowedTerminalIds: deduped,
        assignmentUpdatedAt: new Date().toISOString(),
        assignmentUpdatedBy: req.user?.email || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await ref.set(update, { merge: true });

      await logAudit(db, {
        tenantId: tid,
        req,
        actor: {
          email: req.user?.email || null,
          name: req.user?.name || null,
          role: req.user?.role || null,
        },
        kind: 'chaperone.assignment_override',
        target: { type: 'chaperone', id: chaperoneId, label: before.name || chaperoneId },
        before: {
          assignmentMode: before.assignmentMode || 'derived',
          allowedTerminalIds: Array.isArray(before.allowedTerminalIds) ? before.allowedTerminalIds : [],
        },
        after: {
          assignmentMode: 'override',
          allowedTerminalIds: deduped,
        },
        summary: `Set terminal override for ${before.name || chaperoneId}`,
      });

      const nextDoc = { ...before, ...update };
      const view = buildAssignmentView(nextDoc, terminals);
      return res.status(200).json({
        ok: true,
        chaperoneId,
        assignmentMode: view.assignmentMode,
        effectiveTerminalIds: view.effectiveTerminalIds,
        allowedTerminalIds: deduped,
      });
    } catch (err) {
      console.error('[pickup/admin/chaperone-assignment:put]', err.message, err.stack);
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  }

  if (req.method === 'DELETE') {
    if (!requireEditPermission(req, res)) return;
    try {
      const chaperoneId = String(req.query.chaperoneId || req.body?.chaperoneId || '').trim();
      if (!chaperoneId) return res.status(400).json({ error: 'chaperoneId required' });

      const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'chaperone_not_found' });
      const before = snap.data() || {};

      await ref.set({
        assignmentMode: 'derived',
        allowedTerminalIds: [],
        assignmentUpdatedAt: new Date().toISOString(),
        assignmentUpdatedBy: req.user?.email || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await logAudit(db, {
        tenantId: tid,
        req,
        actor: {
          email: req.user?.email || null,
          name: req.user?.name || null,
          role: req.user?.role || null,
        },
        kind: 'chaperone.assignment_clear',
        target: { type: 'chaperone', id: chaperoneId, label: before.name || chaperoneId },
        before: {
          assignmentMode: before.assignmentMode || 'derived',
          allowedTerminalIds: Array.isArray(before.allowedTerminalIds) ? before.allowedTerminalIds : [],
        },
        after: { assignmentMode: 'derived', allowedTerminalIds: [] },
        summary: `Cleared terminal override for ${before.name || chaperoneId}`,
      });

      return res.status(200).json({ ok: true, chaperoneId, assignmentMode: 'derived', allowedTerminalIds: [] });
    } catch (err) {
      console.error('[pickup/admin/chaperone-assignment:delete]', err.message, err.stack);
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}

export default withApi(handler, {
  methods: ['GET', 'PUT', 'PATCH', 'DELETE'],
  permission: 'pickup_admin.view',
  rateLimit: 120,
});
