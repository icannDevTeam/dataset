/**
 * Admin endpoint for release groups (binds N terminals + 1 tablet device).
 *
 *   GET    /api/pickup/admin/release-groups                    → list groups
 *   POST   /api/pickup/admin/release-groups                    → create
 *            body: { name, gradeLabel?, terminalIds:[...] }
 *   PUT    /api/pickup/admin/release-groups?id=<groupId>       → patch
 *            body: { name?, gradeLabel?, terminalIds?, tabletDeviceId? }
 *   POST   /api/pickup/admin/release-groups?action=start-pair&id=<groupId>
 *            → mints a pending tablet_devices doc for this group, returns
 *              the 6-char pairing code that the iPad will type in.
 *   POST   /api/pickup/admin/release-groups?action=unpair&id=<groupId>
 *            → revokes the currently bound tablet device.
 *   DELETE /api/pickup/admin/release-groups?id=<groupId>       → delete group
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const tab = require('../../../../lib/tablet-devices');
const { isValidHHMM } = require('../../../../lib/terminal-gate');

const PAIRING_TTL_MS = 10 * 60 * 1000;

// Validate + normalise the list of one-off pickup-window overrides.
// Shape: [{ date:'YYYY-MM-DD', open:'HH:MM'|null, close:'HH:MM'|null,
//           closedAllDay:bool, note?:string }]
function normaliseOverrides(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('pickupOverrides must be an array');
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const date = String(r.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`override date must be YYYY-MM-DD (got "${date}")`);
    if (seen.has(date)) throw new Error(`duplicate override for ${date}`);
    seen.add(date);
    const closedAllDay = !!r.closedAllDay;
    let open = r.open ? String(r.open).trim() : null;
    let close = r.close ? String(r.close).trim() : null;
    if (!closedAllDay) {
      if (open && !isValidHHMM(open))   throw new Error(`override ${date}: open must be HH:MM`);
      if (close && !isValidHHMM(close)) throw new Error(`override ${date}: close must be HH:MM`);
      if (!open || !close) throw new Error(`override ${date}: open + close required (or mark closedAllDay)`);
    } else {
      open = null; close = null;
    }
    const note = r.note ? String(r.note).slice(0, 160) : null;
    out.push({ date, open, close, closedAllDay, note });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Validate + normalise grade-specific timing windows.
// Shape:
// {
//   "G1": { open:"12:00", close:"14:30" },
//   "EY": { start:"12:00", end:"13:30" }
// }
function normaliseGradeWindows(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('gradeWindowByLabel must be an object');
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const label = String(key || '').trim().toUpperCase();
    if (!label) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`gradeWindowByLabel.${label} must be an object`);
    }
    const open = String(value.open || value.start || '').trim();
    const close = String(value.close || value.end || '').trim();
    if (!open || !close) {
      throw new Error(`gradeWindowByLabel.${label} requires open + close`);
    }
    if (!isValidHHMM(open) || !isValidHHMM(close)) {
      throw new Error(`gradeWindowByLabel.${label} must use HH:MM`);
    }
    out[label] = { open, close };
  }
  return out;
}

// Reject if any of `ids` is already in another group's terminalIds, or if
// the terminal's gradeLabel/gradeScopes don't match `gradeLabel` of the
// group being edited. `selfId` is the current group's id (skip-conflict).
async function validateTerminalAssignment(db, tid, colRef, ids, gradeLabel, selfId) {
  if (!Array.isArray(ids)) return;
  if (ids.length === 0)   throw Object.assign(new Error('at-least-one-terminal-required'), { code: 400 });

  // 1. Exclusivity: scan all other groups for overlap.
  const allGroups = await colRef.get();
  const conflicts = [];
  for (const d of allGroups.docs) {
    if (d.id === selfId) continue;
    const otherIds = Array.isArray(d.data().terminalIds) ? d.data().terminalIds : [];
    for (const x of ids) {
      if (otherIds.includes(x)) conflicts.push({ terminalId: x, groupId: d.id, groupName: d.data().name || d.id });
    }
  }
  if (conflicts.length) {
    const e = new Error('terminal_already_bound');
    e.code = 409;
    e.conflicts = conflicts;
    throw e;
  }

  // 2. Grade-lock: each terminal must accept this group's grade.
  const wantGrade = (gradeLabel || '').trim().toUpperCase();
  if (wantGrade) {
    const mismatches = [];
    for (const x of ids) {
      const tSnap = await db.doc(tenancy.terminalDoc(x, tid)).get();
      if (!tSnap.exists) { mismatches.push({ terminalId: x, reason: 'missing' }); continue; }
      const td = tSnap.data();
      const tags = [td.gradeLabel, ...(Array.isArray(td.gradeScopes) ? td.gradeScopes : [])]
        .filter(Boolean).map((s) => String(s).trim().toUpperCase());
      if (tags.length && !tags.includes(wantGrade)) {
        mismatches.push({ terminalId: x, name: td.name || x, terminalGrades: tags, reason: 'grade_mismatch' });
      }
    }
    if (mismatches.length) {
      const e = new Error('terminal_grade_mismatch');
      e.code = 409;
      e.mismatches = mismatches;
      throw e;
    }
  }
}

function tsIso(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') return ts;
  if (ts.toDate) return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

function publicGroup(id, data) {
  if (!data) return null;
  const tabletDeviceIds = Array.isArray(data.tabletDeviceIds)
    ? data.tabletDeviceIds.filter(Boolean)
    : (data.tabletDeviceId ? [data.tabletDeviceId] : []);
  const primaryTabletDeviceId = data.tabletDeviceId || tabletDeviceIds[0] || null;
  return {
    id,
    name: data.name || id,
    gradeLabel: data.gradeLabel || null,
    terminalIds: Array.isArray(data.terminalIds) ? data.terminalIds : [],
    pickupOverrides: Array.isArray(data.pickupOverrides) ? data.pickupOverrides : [],
    gradeWindowByLabel: (data.gradeWindowByLabel && typeof data.gradeWindowByLabel === 'object' && !Array.isArray(data.gradeWindowByLabel))
      ? data.gradeWindowByLabel
      : {},
    tabletDeviceId: primaryTabletDeviceId,
    tabletDeviceIds,
    pairingCode: data.pairingCode || null,
    pairingExpiresAt: tsIso(data.pairingExpiresAt),
    status: data.status || (tabletDeviceIds.length ? 'paired' : 'unbound'),
    createdAt: tsIso(data.createdAt),
    updatedAt: tsIso(data.updatedAt),
    claimedAt: tsIso(data.claimedAt),
  };
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const colRef = db.collection(tenancy.releaseGroupsPath(tid));
  const tabletColRef = db.collection(tenancy.tabletDevicesPath(tid));

  try {
    if (req.method === 'GET') {
      const snap = await colRef.orderBy('name').get();
      const groups = snap.docs.map((d) => publicGroup(d.id, d.data()));
      return res.status(200).json({ ok: true, groups });
    }

    // ── POST: action routing ────────────────────────────────────────
    if (req.method === 'POST' && req.query.action === 'start-pair') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const groupRef = colRef.doc(id);
      const groupSnap = await groupRef.get();
      if (!groupSnap.exists) return res.status(404).json({ error: 'group not found' });

      // Allocate a pairing code that isn't already pending.
      let pairingCode = null;
      for (let i = 0; i < 6; i++) {
        const candidate = tab.genPairingCode();
        const dup = await tabletColRef
          .where('pairingCode', '==', candidate)
          .where('status', '==', 'pending')
          .limit(1).get();
        if (dup.empty) { pairingCode = candidate; break; }
      }
      if (!pairingCode) return res.status(503).json({ error: 'could not allocate pairing code' });

      const deviceId = tab.genDeviceId();
      const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + PAIRING_TTL_MS);
      const now = admin.firestore.FieldValue.serverTimestamp();
      await tabletColRef.doc(deviceId).set({
        deviceId,
        deviceLabel: `${groupSnap.data().name || id} iPad`,
        pairingCode,
        pairingExpiresAt: expiresAt,
        releaseGroupId: id,
        deviceToken: null,
        status: 'pending',
        createdAt: now,
        lastSeenAt: now,
      });

      // Stamp the pending pairing on the group so admin UI can render the code.
      await groupRef.set({
        pairingCode,
        pairingExpiresAt: expiresAt,
        pendingTabletDeviceId: deviceId,
        pendingTabletDeviceIds: admin.firestore.FieldValue.arrayUnion(deviceId),
        updatedAt: now,
      }, { merge: true });

      return res.status(201).json({
        ok: true,
        deviceId,
        pairingCode,
        expiresAt: expiresAt.toMillis(),
      });
    }

    if (req.method === 'POST' && req.query.action === 'unpair') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const groupRef = colRef.doc(id);
      const groupSnap = await groupRef.get();
      if (!groupSnap.exists) return res.status(404).json({ error: 'group not found' });
      const tabletIds = Array.isArray(groupSnap.data().tabletDeviceIds)
        ? groupSnap.data().tabletDeviceIds.filter(Boolean)
        : (groupSnap.data().tabletDeviceId ? [groupSnap.data().tabletDeviceId] : []);
      const revocationBatch = db.batch();
      for (const tabletId of tabletIds) {
        revocationBatch.set(tabletColRef.doc(tabletId), {
          status: 'revoked',
          deviceToken: null,
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      await revocationBatch.commit().catch(() => {});
      await groupRef.set({
        tabletDeviceId: null,
        tabletDeviceIds: [],
        pairingCode: null,
        pairingExpiresAt: null,
        pendingTabletDeviceId: null,
        pendingTabletDeviceIds: [],
        status: 'unbound',
        claimedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      const terminalIds = Array.isArray(req.body?.terminalIds) ? req.body.terminalIds.map(String) : [];
      const gradeLabel = req.body?.gradeLabel ? String(req.body.gradeLabel).trim() : null;

      try { await validateTerminalAssignment(db, tid, colRef, terminalIds, gradeLabel, null); }
      catch (e) {
        return res.status(e.code || 400).json({
          error: e.message, conflicts: e.conflicts, mismatches: e.mismatches,
        });
      }

      let pickupOverrides = [];
      if (req.body?.pickupOverrides !== undefined) {
        try { pickupOverrides = normaliseOverrides(req.body.pickupOverrides); }
        catch (e) { return res.status(400).json({ error: 'invalid_overrides', message: e.message }); }
      }

      let gradeWindowByLabel = {};
      if (req.body?.gradeWindowByLabel !== undefined) {
        try { gradeWindowByLabel = normaliseGradeWindows(req.body.gradeWindowByLabel); }
        catch (e) { return res.status(400).json({ error: 'invalid_grade_windows', message: e.message }); }
      }

      const docRef = await colRef.add({
        name,
        gradeLabel,
        terminalIds,
        pickupOverrides,
        gradeWindowByLabel,
        tabletDeviceId: null,
        tabletDeviceIds: [],
        status: 'unbound',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Reverse-link: stamp releaseGroupId on every terminal in the list.
      const batch = db.batch();
      for (const tid2 of terminalIds) {
        batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
          releaseGroupId: docRef.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit().catch(() => {});

      const created = (await docRef.get()).data();
      return res.status(201).json({ ok: true, group: publicGroup(docRef.id, created) });
    }

    if (req.method === 'PUT') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'group not found' });

      const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
      const effectiveGrade = req.body?.gradeLabel !== undefined
        ? (req.body.gradeLabel ? String(req.body.gradeLabel).trim() : null)
        : (snap.data().gradeLabel || null);
      if (req.body?.gradeLabel !== undefined) patch.gradeLabel = effectiveGrade;

      let oldTerminalIds = Array.isArray(snap.data().terminalIds) ? snap.data().terminalIds : [];
      let newTerminalIds = oldTerminalIds;
      if (req.body?.terminalIds !== undefined) {
        newTerminalIds = Array.isArray(req.body.terminalIds) ? req.body.terminalIds.map(String) : [];
        try { await validateTerminalAssignment(db, tid, colRef, newTerminalIds, effectiveGrade, id); }
        catch (e) {
          return res.status(e.code || 400).json({
            error: e.message, conflicts: e.conflicts, mismatches: e.mismatches,
          });
        }
        patch.terminalIds = newTerminalIds;
      }
      if (req.body?.tabletDeviceIds !== undefined) {
        if (!Array.isArray(req.body.tabletDeviceIds)) {
          return res.status(400).json({ error: 'tabletDeviceIds must be an array' });
        }
        patch.tabletDeviceIds = req.body.tabletDeviceIds.map(String).map((s) => s.trim()).filter(Boolean);
        patch.tabletDeviceId = patch.tabletDeviceIds[0] || null;
      }
      if (req.body?.pickupOverrides !== undefined) {
        try { patch.pickupOverrides = normaliseOverrides(req.body.pickupOverrides); }
        catch (e) { return res.status(400).json({ error: 'invalid_overrides', message: e.message }); }
      }
      if (req.body?.gradeWindowByLabel !== undefined) {
        try { patch.gradeWindowByLabel = normaliseGradeWindows(req.body.gradeWindowByLabel); }
        catch (e) { return res.status(400).json({ error: 'invalid_grade_windows', message: e.message }); }
      }
      await ref.set(patch, { merge: true });

      // Sync reverse links on terminals if list changed.
      if (req.body?.terminalIds !== undefined) {
        const removed = oldTerminalIds.filter((x) => !newTerminalIds.includes(x));
        const added = newTerminalIds.filter((x) => !oldTerminalIds.includes(x));
        const batch = db.batch();
        for (const tid2 of removed) {
          batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
            releaseGroupId: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        for (const tid2 of added) {
          batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
            releaseGroupId: id,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        await batch.commit().catch(() => {});
      }

      const updated = (await ref.get()).data();
      return res.status(200).json({ ok: true, group: publicGroup(id, updated) });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ref = colRef.doc(id);
      const snap = await ref.get();
      if (snap.exists) {
        // Unlink terminals.
        const terminalIds = Array.isArray(snap.data().terminalIds) ? snap.data().terminalIds : [];
        const batch = db.batch();
        for (const tid2 of terminalIds) {
          batch.set(db.doc(tenancy.terminalDoc(tid2, tid)), {
            releaseGroupId: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        // Revoke any bound tablet.
        const tabletId = snap.data().tabletDeviceId;
        if (tabletId) {
          batch.set(db.doc(tenancy.tabletDeviceDoc(tabletId, tid)), {
            status: 'revoked',
            deviceToken: null,
            revokedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        await batch.commit().catch(() => {});
      }
      await ref.delete();
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[pickup/admin/release-groups]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

// SECURITY (F-005 fix, 2026-05-13): per-method permission split.
// GET = view; every state-changing method requires manage_groups.
// Previously used `anyPermission: ['view', 'manage_groups']` for ALL methods,
// which let view-only roles unpair iPads / delete groups (DoS the gate).
function methodPermission(req) {
  if (req.method === 'GET') return 'pickup_admin.view';
  return 'pickup_admin.manage_groups';
}

export default function release_groups_route(req, res) {
  const wrapped = withApi(handler, {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    permission: methodPermission(req),
  });
  return wrapped(req, res);
}
