/**
 * Pickup integrations + contacts admin API
 *
 *   GET  ?action=settings           → integration URLs + counts
 *   PUT  ?action=settings    body   → upsert integration settings
 *   GET  ?action=contacts           → list contacts (?channel=email|whatsapp&group=)
 *   POST ?action=contacts    body   → upsert single contact
 *   POST ?action=import      body   → bulk import (paste / CSV text)
 *   POST ?action=campaign-email body→ enqueue bulk email campaign via email_queue
 *   DELETE ?action=contacts&id=…    → remove contact
 *   POST ?action=sync-from-forms    → import guardian emails from pickup_onboarding
 *   GET/POST/DELETE ?action=templates → saved broadcast templates CRUD
 *   GET  ?action=campaigns          → campaign history with live queue counts
 *   POST ?action=send-invite-link   → email an onboarding invite link to contacts
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
const { withApi } = require('../../../../lib/api-auth');
const tenancy = require('../../../../lib/tenancy');
const inviteLinks = require('../../../../lib/onboarding-invites');

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
const TEMPLATE_PICKUP_BULK_CAMPAIGN = 'pickup_bulk_campaign';
const TEMPLATE_PICKUP_INVITE_LINK = 'pickup_invite_link';

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
    source: d.source || 'manual',
    createdAt: tsMs(d.createdAt),
    updatedAt: tsMs(d.updatedAt),
  };
}

function queueJobId(campaignId, contactId) {
  const safe = `${campaignId}-${contactId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return `campaign-${safe}`.slice(0, 180);
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

  // ─── bulk email campaign (server-side queue) ───────────────────
  // Enqueues one email_queue job per selected contact. This keeps delivery
  // retries and status tracking centralized in processEmailQueue.
  if (action === 'campaign-email') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    const subject = String(body.subject || '').trim().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 4000);
    const campaignName = String(body.campaignName || '').trim().slice(0, 120) || 'Pickup campaign';
    const selectedIds = Array.isArray(body.contactIds) ? body.contactIds.map((x) => String(x)) : [];
    const group = body.group ? String(body.group).trim() : null;

    if (!subject) return res.status(400).json({ error: 'subject required' });
    if (!message) return res.status(400).json({ error: 'message required' });
    if (selectedIds.length > 1000) return res.status(400).json({ error: 'max 1000 contacts per request' });

    const useSelected = selectedIds.length > 0;
    const selectedSet = new Set(selectedIds);
    const snap = await contactsCol.get();
    let contacts = snap.docs.map(shapeContact).filter((c) => c.email);
    if (group) contacts = contacts.filter((c) => (c.group || '') === group);
    if (useSelected) contacts = contacts.filter((c) => selectedSet.has(c.id));
    if (contacts.length === 0) return res.status(400).json({ error: 'no eligible email contacts found' });

    const campaignId = `${tid}-${Date.now()}`;
    let queued = 0;
    let skipped = 0;
    const errors = [];

    let batch = db.batch();
    let pending = 0;
    for (const c of contacts) {
      if (!c.email) { skipped++; continue; }
      const jobId = queueJobId(campaignId, c.id);
      const ref = db.doc(`email_queue/${jobId}`);
      batch.set(ref, {
        status: 'pending',
        templateType: TEMPLATE_PICKUP_BULK_CAMPAIGN,
        tenantId: tid,
        recordId: null,
        campaignId,
        campaignName,
        to: c.email,
        templateData: {
          subject,
          message,
          recipientName: c.name || null,
          studentName: c.studentName || null,
          group: c.group || null,
        },
        retryCount: 0,
        maxRetries: 3,
        source: 'pickup_admin_campaign_email',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: actor,
      }, { merge: false });
      queued++; pending++;
      if (pending >= 400) {
        try { await batch.commit(); }
        catch (e) { errors.push(e.message || 'batch commit failed'); }
        batch = db.batch();
        pending = 0;
      }
    }
    if (pending > 0) {
      try { await batch.commit(); }
      catch (e) { errors.push(e.message || 'batch commit failed'); }
    }

    await db.collection(`${tenancy.tenantDoc(tid)}/pickup_campaign_logs`).doc(campaignId).set({
      campaignId,
      campaignName,
      channel: 'email',
      subject,
      message,
      recipientCount: contacts.length,
      queued,
      skipped,
      group: group || null,
      createdBy: actor,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: false }).catch(() => null);

    return res.status(200).json({ ok: true, campaignId, queued, skipped, errors });
  }

  // ─── sync contacts from submitted onboarding forms ────────────────
  // READ-ONLY against pickup_onboarding: copies guardian emails into
  // pickup_contacts. Never writes to form records. Idempotent — emails
  // already in the contact list are skipped, manual edits preserved.
  if (action === 'sync-from-forms') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const formsSnap = await db.collection(tenancy.pickupOnboardingPath(tid))
      .where('status', 'in', ['pending', 'approved'])
      .get();

    const existingSnap = await contactsCol.select('email').get();
    const existing = new Set();
    existingSnap.forEach((d) => { const v = (d.get('email') || '').toLowerCase(); if (v) existing.add(v); });

    const results = { added: 0, skipped: 0, scanned: formsSnap.size };
    let batch = db.batch();
    let pending = 0;
    const seenThisRun = new Set();

    for (const doc of formsSnap.docs) {
      const rec = doc.data() || {};
      const email = normEmail(rec.guardian?.email);
      if (!email || existing.has(email) || seenThisRun.has(email)) { results.skipped++; continue; }
      seenThisRun.add(email);
      const students = Array.isArray(rec.students) ? rec.students : [];
      const studentNames = Array.isArray(rec.studentNames) ? rec.studentNames : [];
      const ref = contactsCol.doc();
      batch.set(ref, {
        name: String(rec.guardian?.name || email.split('@')[0]).trim().slice(0, 120),
        email,
        phone: normPhone(rec.guardian?.phone),
        channel: 'email',
        group: students[0]?.homeroom ? String(students[0].homeroom).slice(0, 80) : null,
        studentName: studentNames.length ? studentNames.join(', ').slice(0, 120) : null,
        studentId: null,
        source: 'onboarding_form',
        formNumber: rec.formNumber || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: actor,
      });
      results.added++; pending++;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();
    return res.status(200).json({ ok: true, ...results });
  }

  // ─── saved broadcast templates ─────────────────────────────────────
  if (action === 'templates') {
    const templatesCol = db.collection(tenancy.pickupEmailTemplatesPath(tid));
    if (req.method === 'GET') {
      const snap = await templatesCol.get();
      const items = snap.docs.map((d) => {
        const t = d.data() || {};
        return {
          id: d.id,
          name: t.name || '',
          subject: t.subject || '',
          message: t.message || '',
          createdBy: t.createdBy || null,
          updatedAt: tsMs(t.updatedAt),
        };
      }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return res.status(200).json({ ok: true, templates: items });
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const name = String(body.name || '').trim().slice(0, 120);
      const subject = String(body.subject || '').trim().slice(0, 200);
      const message = String(body.message || '').trim().slice(0, 4000);
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!subject) return res.status(400).json({ error: 'subject required' });
      if (!message) return res.status(400).json({ error: 'message required' });
      const doc = {
        name, subject, message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      let ref;
      if (body.id) {
        ref = templatesCol.doc(String(body.id));
        const cur = await ref.get();
        if (!cur.exists) return res.status(404).json({ error: 'not found' });
        await ref.set(doc, { merge: true });
      } else {
        doc.createdAt = admin.firestore.FieldValue.serverTimestamp();
        doc.createdBy = actor;
        ref = await templatesCol.add(doc);
      }
      return res.status(200).json({ ok: true, id: ref.id });
    }
    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : '';
      if (!id) return res.status(400).json({ error: 'id required' });
      await templatesCol.doc(id).delete();
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ─── campaign history (logs + live queue counts) ───────────────────
  if (action === 'campaigns') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const logsSnap = await db.collection(`${tenancy.tenantDoc(tid)}/pickup_campaign_logs`)
      .orderBy('createdAt', 'desc').limit(50).get();

    // Live status counts — equality-only filters, no composite index needed.
    const jobsSnap = await db.collection('email_queue')
      .where('tenantId', '==', tid)
      .where('source', 'in', ['pickup_admin_campaign_email', 'pickup_admin_invite_link'])
      .select('campaignId', 'status')
      .limit(5000)
      .get()
      .catch(() => null);

    const counts = {};
    if (jobsSnap) {
      jobsSnap.forEach((d) => {
        const cid = d.get('campaignId');
        if (!cid) return;
        const st = d.get('status') || 'pending';
        counts[cid] = counts[cid] || { sent: 0, failed: 0, pending: 0 };
        if (st === 'sent') counts[cid].sent++;
        else if (st === 'failed') counts[cid].failed++;
        else counts[cid].pending++;
      });
    }

    const campaigns = logsSnap.docs.map((d) => {
      const c = d.data() || {};
      return {
        campaignId: c.campaignId || d.id,
        campaignName: c.campaignName || '(unnamed)',
        kind: c.kind || 'broadcast',
        subject: c.subject || '',
        recipientCount: c.recipientCount || 0,
        queued: c.queued || 0,
        group: c.group || null,
        createdBy: c.createdBy || null,
        createdAt: tsMs(c.createdAt),
        ...(counts[c.campaignId || d.id] || { sent: 0, failed: 0, pending: 0 }),
      };
    });
    return res.status(200).json({ ok: true, campaigns });
  }

  // ─── one-click invite-link email to contacts ──────────────────────
  if (action === 'send-invite-link') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    const linkId = String(body.linkId || '').trim();
    const selectedIds = Array.isArray(body.contactIds) ? body.contactIds.map((x) => String(x)).filter(Boolean) : [];
    if (!linkId) return res.status(400).json({ error: 'linkId required' });
    if (!selectedIds.length) return res.status(400).json({ error: 'contactIds required' });
    if (selectedIds.length > 500) return res.status(400).json({ error: 'max 500 contacts per request' });

    const usable = await inviteLinks.assertInviteUsable(db, tid, linkId);
    if (!usable.ok) return res.status(400).json({ error: `invite link not usable: ${usable.reason}` });
    const link = await inviteLinks.getInvite(db, tid, linkId);
    if (!link?.url) return res.status(400).json({ error: 'invite link has no URL' });

    const refs = selectedIds.map((id) => contactsCol.doc(id));
    const snaps = await db.getAll(...refs);
    const contacts = snaps.filter((s) => s.exists).map(shapeContact).filter((c) => c.email);
    if (!contacts.length) return res.status(400).json({ error: 'no eligible email contacts found' });

    const campaignId = `invite-${tid}-${Date.now()}`;
    let queued = 0;
    let batch = db.batch();
    let pending = 0;
    for (const c of contacts) {
      const ref = db.doc(`email_queue/${queueJobId(campaignId, c.id)}`);
      batch.set(ref, {
        status: 'pending',
        templateType: TEMPLATE_PICKUP_INVITE_LINK,
        tenantId: tid,
        recordId: null,
        campaignId,
        campaignName: `Invite link: ${link.name || linkId}`,
        to: c.email,
        templateData: {
          recipientName: c.name || null,
          studentName: c.studentName || null,
          inviteUrl: link.url,
          linkName: link.name || null,
          expiresAt: link.expiresAt || null,
          windowCloseAt: link.windowCloseAt || null,
        },
        retryCount: 0,
        maxRetries: 3,
        source: 'pickup_admin_invite_link',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: actor,
      }, { merge: false });
      queued++; pending++;
      if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
    }
    if (pending > 0) await batch.commit();

    await db.collection(`${tenancy.tenantDoc(tid)}/pickup_campaign_logs`).doc(campaignId).set({
      campaignId,
      campaignName: `Invite link: ${link.name || linkId}`,
      kind: 'invite_link',
      channel: 'email',
      subject: 'Pickup onboarding invite link',
      linkId,
      recipientCount: contacts.length,
      queued,
      skipped: selectedIds.length - contacts.length,
      createdBy: actor,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: false }).catch(() => null);

    return res.status(200).json({ ok: true, campaignId, queued, skipped: selectedIds.length - contacts.length });
  }

  return res.status(400).json({ error: 'unknown action' });
}

export default withApi(handler, {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  permission: 'settings.edit',
});
