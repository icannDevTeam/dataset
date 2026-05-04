/**
 * Kiosk profile CRUD for the admin dashboard.
 *
 *   GET     /api/pickup/admin/kiosk-profiles            → list all profiles
 *   POST    /api/pickup/admin/kiosk-profiles            → create new (body = profile)
 *   PUT     /api/pickup/admin/kiosk-profiles?id=<id>    → update existing
 *   DELETE  /api/pickup/admin/kiosk-profiles?id=<id>    → delete
 *
 * Body shape (POST/PUT):
 *   { name, gates:[], homerooms:[], showQueue?, maxCards?, beepEnabled?, accent? }
 *
 * Profile id is auto-slugged from name on POST unless body.id is given.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
const tenancy = require('../../../../lib/tenancy');
const kp = require('../../../../lib/kiosk-profiles');

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'kiosk';
}

function sanitizeProfile(body) {
  const rawCode = String(body?.kioskCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const cleanTime = (t) => {
    if (!t || typeof t !== 'string') return null;
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const mn = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
  };
  return {
    name: String(body?.name || '').trim().slice(0, 80) || 'Untitled kiosk',
    kioskCode: rawCode || null,
    gates: Array.isArray(body?.gates) ? body.gates.map((g) => String(g).slice(0, 120)).filter(Boolean) : [],
    homerooms: Array.isArray(body?.homerooms)
      ? body.homerooms.map((h) => String(h).toUpperCase().slice(0, 16)).filter(Boolean)
      : [],
    showQueue: body?.showQueue !== false,
    maxCards: Math.max(1, Math.min(8, parseInt(body?.maxCards, 10) || 5)),
    beepEnabled: body?.beepEnabled !== false,
    accent: typeof body?.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.accent) ? body.accent : '#8B1538',
    windowOpen: cleanTime(body?.windowOpen),
    windowClose: cleanTime(body?.windowClose),
    suppressOutOfWindow: body?.suppressOutOfWindow !== false,
  };
}

async function ensureCodeUnique(colRef, code, exceptId) {
  if (!code) return;
  const snap = await colRef.where('kioskCode', '==', code).get();
  const conflict = snap.docs.find((d) => d.id !== exceptId);
  if (conflict) {
    const err = new Error(`Kiosk code "${code}" is already used by "${conflict.data().name || conflict.id}"`);
    err.statusCode = 409;
    throw err;
  }
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const colRef = db.collection(kp.kioskProfilesPath(tid));

  try {
    if (req.method === 'GET') {
      const snap = await colRef.orderBy('name').get();
      const profiles = snap.docs.map((d) => kp.normalizeProfile(d.id, d.data()));
      return res.status(200).json({ ok: true, profiles });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const data = sanitizeProfile(body);
      const id = body.id ? slug(body.id) : slug(data.name);
      const ref = colRef.doc(id);
      const exists = await ref.get();
      if (exists.exists) {
        return res.status(409).json({ error: 'A profile with this id already exists', id });
      }
      await ensureCodeUnique(colRef, data.kioskCode, id);
      const now = new Date().toISOString();
      await ref.set({ ...data, createdAt: now, updatedAt: now });
      return res.status(201).json({ ok: true, profile: kp.normalizeProfile(id, { ...data, createdAt: now, updatedAt: now }) });
    }

    if (req.method === 'PUT') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id query param required' });
      const data = sanitizeProfile(req.body || {});
      const ref = colRef.doc(id);
      const exists = await ref.get();
      if (!exists.exists) return res.status(404).json({ error: 'Profile not found' });
      await ensureCodeUnique(colRef, data.kioskCode, id);
      const now = new Date().toISOString();
      await ref.set({ ...data, updatedAt: now }, { merge: true });
      const merged = { ...exists.data(), ...data, updatedAt: now };
      return res.status(200).json({ ok: true, profile: kp.normalizeProfile(id, merged) });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null;
      if (!id) return res.status(400).json({ error: 'id query param required' });
      await colRef.doc(id).delete();
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[pickup/admin/kiosk-profiles]', err.message);
    const code = err.statusCode || 500;
    return res.status(code).json({ error: code === 500 ? 'internal' : 'conflict', message: err.message });
  }
}

export default withAuth(handler, { methods: ['GET', 'POST', 'PUT', 'DELETE'] });
