/**
 * Pickup integrations + contacts admin API
 *
 *   GET  ?action=settings           → integration URLs + counts
 *   PUT  ?action=settings    body   → upsert integration settings
 *   GET  ?action=contacts           → list contacts (?channel=email|whatsapp&group=)
 *   POST ?action=contacts    body   → upsert single contact
 *   POST ?action=import      body   → bulk import (paste / CSV text)
 *   DELETE ?action=contacts&id=…    → remove contact
 *
 * Settings shape (tenants/{tid}/settings/pickup_integrations):
 *   {
 *     whatsappBroadcastUrl: string,   // optional WA Business / Wati / Twilio webhook
 *     toddleAccountUrl:     string,   // school's Toddle URL for the "Open Toddle" button
 *     defaultEmailSubject:  string,
 *     defaultMessageBody:   string,   // supports {url} {name} {ttl} placeholders
 *     defaultGroups:        [string], // labels admins can pick when importing
 *     updatedAt, updatedBy
 *   }
 *
 * Contact shape (tenants/{tid}/pickup_contacts/{auto-id}):
 *   {
 *     name, email|null, phone|null,    // phone is E.164 ("+62…")
 *     channel: 'email' | 'whatsapp' | 'both',
 *     group: string | null,            // e.g. "Grade 4 — March 2026"
 *     studentName, studentId,          // optional pairing for personalised broadcasts
 *     createdAt, updatedAt, createdBy
 *   }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const { withAuth } = require('../../../../lib/auth-middleware');
const tenancy = require('../../../../lib/tenancy');

const DEFAULTS = {
  whatsappBroadcastUrl: '',
  toddleAccountUrl: '',
  defaultEmailSubject: 'Pickup form for {studentName} — please complete',
  defaultMessageBody:
    'Hi {name},\n\nPlease complete the pickup-authorization form for {studentName} at the link below. ' +
    'It only takes a couple of minutes — guardians, chaperones, and a quick face capture.\n\n' +
    '{url}\n\nThe form closes on {closeDate}.\n\nThank you,\nBINUS School Simprug',
  defaultGroups: [],
};

function normEmail(s) {
  if (!s) return null;
  const e = String(s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
function normPhone(s) {
  if (!s) return null;
  // Strip everything except + and digits, force E.164ish
  let p = String(s).replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('0')) p = '+62' + p.slice(1);             // ID default
  if (!p.startsWith('+')) p = '+' + p;
  return /^\+\d{6,15}$/.test(p) ? p : null;
}

function tsMs(v) {
  return v && typeof v.toMillis === 'function' ? v.toMillis() : (v || null);
}
function shapeContact(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    name: d.name || '',
    email: d.email || null,
    phone: d.phone || null,
    channel: d.channel || (d.phone && d.email ? 'both' : d.email ? 'email' : 'whatsapp'),
    group: d.group || null,
    studentName: d.studentName || null,
    studentId: d.studentId || null,
    createdAt: tsMs(d.createdAt),
    updatedAt: tsMs(d.updatedAt),
  };
}

async function handler(req, res) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId(req.body?.tenant || req.query?.tenant);
  const action = String(req.query.action || '').toLowerCase();
  const settingsRef = db.doc(tenancy.pickupIntegrationsDoc(tid));
  const contactsCol = db.collection(tenancy.pickupContactsPath(tid));
  const actor = req.user?.email || req.user?.uid || 'admin';

  // ─── settings ────────────────────────────────────────────────────
  if (action === 'settings') {
    if (req.method === 'GET') {
      const snap = await settingsRef.get();
      const data = snap.exists ? snap.data() : {};
      const merged = { ...DEFAULTS, ...data };
      // counts (cheap aggregation)
      const all = await contactsCol.select('channel').get();
      let email = 0, whatsapp = 0, both = 0;
      all.forEach((d) => {
        const c = d.get('channel');
        if (c === 'email') email++;
        else if (c === 'whatsapp') whatsapp++;
        else if (c === 'both') both++;
      });
      return res.status(200).json({
        ok: true,
        settings: {
          whatsappBroadcastUrl: merged.whatsappBroadcastUrl || '',
          toddleAccountUrl: merged.toddleAccountUrl || '',
          defaultEmailSubject: merged.defaultEmailSubject || DEFAULTS.defaultEmailSubject,
          defaultMessageBody: merged.defaultMessageBody || DEFAULTS.defaultMessageBody,
          defaultGroups: Array.isArray(merged.defaultGroups) ? merged.defaultGroups : [],
          updatedAt: tsMs(merged.updatedAt),
          updatedBy: merged.updatedBy || null,
        },
        counts: { email, whatsapp, both, total: email + whatsapp + both },
      });
    }
    if (req.method === 'PUT') {
      const body = req.body || {};
      const patch = {
        whatsappBroadcastUrl: String(body.whatsappBroadcastUrl || '').trim().slice(0, 500),
        toddleAccountUrl: String(body.toddleAccountUrl || '').trim().slice(0, 500),
        defaultEmailSubject: String(body.defaultEmailSubject || '').trim().slice(0, 200),
        defaultMessageBody: String(body.defaultMessageBody || '').trim().slice(0, 4000),
        defaultGroups: Array.isArray(body.defaultGroups)
          ? body.defaultGroups.map((g) => String(g).trim()).filter(Boolean).slice(0, 50)
          : [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: actor,
      };
      // Validate URLs (allow blank)
      for (const [k, v] of Object.entries(patch)) {
        if (k.endsWith('Url') && v) {
          try { new URL(v); } catch { return res.status(400).json({ error: `${k} is not a valid URL` }); }
        }
      }
      await settingsRef.set(patch, { merge: true });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ─── contacts ────────────────────────────────────────────────────
  if (action === 'contacts') {
    if (req.method === 'GET') {
      let q = contactsCol;
      const channel = req.query.channel ? String(req.query.channel) : null;
      const group = req.query.group ? String(req.query.group) : null;
      if (channel && ['email', 'whatsapp', 'both'].includes(channel)) {
        // server-side filter: returning channel=email/whatsapp also includes 'both'
        if (channel === 'both') q = q.where('channel', '==', 'both');
      }
      const snap = await q.get();
      let items = snap.docs.map(shapeContact);
      if (channel === 'email') items = items.filter((c) => (c.channel === 'email' || c.channel === 'both') && c.email);
      if (channel === 'whatsapp') items = items.filter((c) => (c.channel === 'whatsapp' || c.channel === 'both') && c.phone);
      if (group) items = items.filter((c) => (c.group || '') === group);
      items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      // distinct groups for filter UI
      const groups = Array.from(new Set(snap.docs.map((d) => d.get('group')).filter(Boolean))).sort();
      return res.status(200).json({ ok: true, contacts: items, groups });
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 120);
      const email = normEmail(body.email);
      const phone = normPhone(body.phone);
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!email && !phone) return res.status(400).json({ error: 'either email or phone required' });
      const channel =
        email && phone ? 'both' :
        email ? 'email' : 'whatsapp';
      const doc = {
        name, email, phone, channel,
        group: body.group ? String(body.group).trim().slice(0, 80) : null,
        studentName: body.studentName ? String(body.studentName).trim().slice(0, 120) : null,
        studentId: body.studentId ? String(body.studentId).trim().slice(0, 32) : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: actor,
      };
      let ref;
      if (body.id) {
        ref = contactsCol.doc(String(body.id));
        const cur = await ref.get();
        if (!cur.exists) return res.status(404).json({ error: 'not found' });
        delete doc.createdAt; delete doc.createdBy;
        await ref.set(doc, { merge: true });
      } else {
        ref = await contactsCol.add(doc);
      }
      const fresh = await ref.get();
      return res.status(200).json({ ok: true, contact: shapeContact(fresh) });
    }
    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : '';
      if (!id) return res.status(400).json({ error: 'id required' });
      await contactsCol.doc(id).delete();
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ─── bulk import (emails only) ───────────────────────────────────
  // Pulls every email-shaped token from the pasted blob, regardless of
  // the surrounding text (commas, semicolons, newlines, "Name <email>",
  // CSV cells, …). Names default to the local part. No phones, no
  // headers, no groups — just emails.
  if (action === 'import') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    const text = String(body.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'text required' });

    const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;
    const found = (text.match(EMAIL_RE) || []).map((e) => e.toLowerCase());
    const seen = new Set();
    const emails = [];
    for (const e of found) {
      if (!seen.has(e) && normEmail(e)) { seen.add(e); emails.push(e); }
    }

    // Skip duplicates already in Firestore
    const existingSnap = await contactsCol.where('email', '!=', null).select('email').get().catch(() => null);
    const existing = new Set();
    if (existingSnap) existingSnap.forEach((d) => { const v = (d.data().email || '').toLowerCase(); if (v) existing.add(v); });

    const results = { added: 0, skipped: 0, errors: [] };
    let batch = db.batch();
    let pending = 0;
    for (const email of emails) {
      if (existing.has(email)) { results.skipped++; continue; }
      const ref = contactsCol.doc();
      batch.set(ref, {
        name: email.split('@')[0],
        email,
        phone: null,
        channel: 'email',
        group: null,
        studentName: null,
        studentId: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: actor,
        importedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      results.added++; pending++;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    return res.status(200).json({ ok: true, ...results });
  }

  return res.status(400).json({ error: 'unknown action' });
}

export default withAuth(handler, { methods: ['GET', 'POST', 'PUT', 'DELETE'] });
