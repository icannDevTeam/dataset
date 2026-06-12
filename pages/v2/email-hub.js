/**
 * /v2/email-hub — ACOP Email Broadcasting Hub
 *
 * One home for parent email outreach:
 *   - Broadcast: pick template → configure → send bulk email via email_queue
 *   - Contacts: all parent emails (auto-synced from onboarding forms) + per-row invite-link send
 *   - Templates: saved reusable subject/message templates with {name}/{studentName}
 *   - History: past campaigns with live sent/failed/pending counts
 */
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import V2Layout from '../../components/v2/V2Layout';

const TABS = [
  { key: 'broadcast', label: 'Broadcast', icon: 'ph-megaphone' },
  { key: 'contacts', label: 'Contacts', icon: 'ph-address-book' },
  { key: 'templates', label: 'Templates', icon: 'ph-file-text' },
  { key: 'history', label: 'History', icon: 'ph-clock-counter-clockwise' },
];

function fmt(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function personalize(text, contact) {
  return String(text || '')
    .replace(/\{name\}/g, contact?.name || 'Parent/Guardian')
    .replace(/\{studentName\}/g, contact?.studentName || 'your child');
}

function SourceBadge({ source }) {
  const map = {
    onboarding_form: { label: 'form', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
    import: { label: 'import', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
    manual: { label: 'manual', cls: 'bg-slate-500/15 text-slate-300 border-slate-600' },
  };
  const m = map[source] || map.manual;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${m.cls}`}>{m.label}</span>;
}

function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  const cls = toast.type === 'error'
    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100';
  return (
    <div className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border ${cls} px-4 py-3 text-sm shadow-2xl flex items-start gap-2`}>
      <i className={`ph ${toast.type === 'error' ? 'ph-warning-circle' : 'ph-check-circle'} text-lg mt-0.5`} />
      <div className="flex-1">{toast.msg}</div>
      <button onClick={onDismiss} className="text-xs opacity-60 hover:opacity-100"><i className="ph ph-x" /></button>
    </div>
  );
}

function ConfirmModal({ open, title, body, confirmLabel, busy, danger, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true"
      className="v2-dark fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <div className="text-sm text-slate-300 mt-2">{body}</div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy}
            className={`px-4 py-1.5 text-xs font-bold rounded-lg text-white disabled:opacity-50 ${danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-brand-500 hover:bg-brand-400'}`}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Email preview (classic navy card mock) ──────────────────────────
function EmailPreview({ subject, message, contact }) {
  const pSubject = personalize(subject, contact) || 'Subject preview';
  const pMessage = personalize(message, contact) || 'Your message will appear here…';
  return (
    <div className="rounded-xl overflow-hidden border border-slate-700 bg-[#F9FAFB] text-[#111827]">
      <div className="bg-[#0F2A4D] px-5 py-4">
        <div className="text-[10px] tracking-[2px] uppercase text-[#FFC107] font-bold">BINUS Simprug</div>
        <div className="text-base font-bold text-white mt-0.5">{pSubject}</div>
      </div>
      <div className="px-5 py-4">
        <p className="text-sm mb-2">Dear {contact?.name || 'Parent/Guardian'},</p>
        <p className="text-[13px] leading-relaxed text-[#374151] whitespace-pre-wrap">{pMessage}</p>
      </div>
      <div className="bg-[#F9FAFB] border-t border-[#E5E7EB] px-5 py-3 text-center">
        <div className="text-[9px] tracking-[3px] uppercase text-[#0F2A4D] font-bold">Binus Spirit</div>
        <div className="text-[10px] text-[#4B5563] mt-1 leading-relaxed">
          <b className="text-[#0F2A4D]">S</b>triving for Excellence · <b className="text-[#0F2A4D]">P</b>erseverance · <b className="text-[#0F2A4D]">I</b>ntegrity · <b className="text-[#0F2A4D]">R</b>espect · <b className="text-[#0F2A4D]">I</b>nnovation · <b className="text-[#0F2A4D]">T</b>eamwork
        </div>
        <div className="text-[9px] text-[#6B7280] italic mt-1">People · Innovation · Excellence</div>
      </div>
    </div>
  );
}

// ─── Template editor modal ───────────────────────────────────────────
function TemplateModal({ open, template, busy, onCancel, onSave }) {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (open) {
      setName(template?.name || '');
      setSubject(template?.subject || '');
      setMessage(template?.message || '');
    }
  }, [open, template]);
  if (!open) return null;
  const insertPlaceholder = (ph) => setMessage((m) => `${m}${m && !m.endsWith(' ') ? ' ' : ''}${ph}`);
  return (
    <div role="dialog" aria-modal="true"
      className="v2-dark fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <i className="ph ph-file-text text-brand-300" />
          {template?.id ? 'Edit template' : 'New template'}
        </h3>
        <label className="block mt-4 text-[11px] uppercase tracking-wider text-slate-500">Template name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
          placeholder="e.g. Early dismissal notice"
          className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400" />
        <label className="block mt-3 text-[11px] uppercase tracking-wider text-slate-500">Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200}
          placeholder="Email subject line"
          className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400" />
        <label className="block mt-3 text-[11px] uppercase tracking-wider text-slate-500">Message</label>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={7} maxLength={4000}
          placeholder={'Dear parents,\n\n…'}
          className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400" />
        <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
          Placeholders:
          {['{name}', '{studentName}'].map((ph) => (
            <button key={ph} type="button" onClick={() => insertPlaceholder(ph)}
              className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-brand-300 hover:bg-slate-700 font-mono">
              {ph}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={() => onSave({ id: template?.id, name, subject, message })}
            disabled={busy || !name.trim() || !subject.trim() || !message.trim()}
            className="px-4 py-1.5 text-xs font-bold rounded-lg bg-brand-500 hover:bg-brand-400 text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add contact modal ───────────────────────────────────────────────
function ContactModal({ open, busy, onCancel, onSave }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [group, setGroup] = useState('');
  const [studentName, setStudentName] = useState('');
  useEffect(() => { if (open) { setName(''); setEmail(''); setPhone(''); setGroup(''); setStudentName(''); } }, [open]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true"
      className="v2-dark fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <i className="ph ph-user-plus text-brand-300" />Add contact
        </h3>
        {[
          ['Name', name, setName, 'Parent name'],
          ['Email', email, setEmail, 'parent@example.com'],
          ['Phone (optional)', phone, setPhone, '+62…'],
          ['Group / class (optional)', group, setGroup, 'e.g. 4C'],
          ['Student name (optional)', studentName, setStudentName, 'Child\u2019s name'],
        ].map(([label, val, set, ph]) => (
          <div key={label}>
            <label className="block mt-3 text-[11px] uppercase tracking-wider text-slate-500">{label}</label>
            <input value={val} onChange={(e) => set(e.target.value)} placeholder={ph}
              className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400" />
          </div>
        ))}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={() => onSave({ name, email, phone, group, studentName, channel: 'email' })}
            disabled={busy || !name.trim() || !email.trim()}
            className="px-4 py-1.5 text-xs font-bold rounded-lg bg-brand-500 hover:bg-brand-400 text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Add contact'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Invite link picker modal ────────────────────────────────────────
function InviteLinkModal({ open, contacts, invites, busy, onCancel, onSend }) {
  const [linkId, setLinkId] = useState('');
  useEffect(() => {
    if (open) {
      const usable = (invites || []).filter((i) => i.enabled !== false);
      setLinkId(usable[0]?.id || '');
    }
  }, [open, invites]);
  if (!open) return null;
  const usable = (invites || []).filter((i) => i.enabled !== false);
  return (
    <div role="dialog" aria-modal="true"
      className="v2-dark fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <i className="ph ph-paper-plane-tilt text-brand-300" />Send invite link
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Emails the onboarding form link to{' '}
          <span className="text-slate-200 font-medium">
            {contacts.length === 1 ? (contacts[0]?.name || contacts[0]?.email) : `${contacts.length} contacts`}
          </span>.
        </p>
        {usable.length === 0 ? (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 p-3 text-xs">
            No active invite links. Create one in Pickup Admin → Invite Links first.
          </div>
        ) : (
          <>
            <label className="block mt-4 text-[11px] uppercase tracking-wider text-slate-500">Invite link</label>
            <select value={linkId} onChange={(e) => setLinkId(e.target.value)}
              className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400">
              {usable.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name || i.id}{i.expiresAt ? ` — expires ${fmt(i.expiresAt)}` : ''}
                </option>
              ))}
            </select>
          </>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={() => onSend(linkId)} disabled={busy || !linkId}
            className="px-4 py-1.5 text-xs font-bold rounded-lg bg-brand-500 hover:bg-brand-400 text-white disabled:opacity-50">
            {busy ? 'Queuing…' : 'Send invite email'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EmailHubPage() {
  const [tab, setTab] = useState('broadcast');
  const [toast, setToast] = useState(null);
  const pushToast = useCallback((type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 6000);
  }, []);

  // shared data
  const [contacts, setContacts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [invites, setInvites] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadContacts = useCallback(async () => {
    const r = await fetch('/api/pickup/admin/integrations?action=contacts', { credentials: 'include' });
    const j = await r.json();
    if (r.ok && j.ok) { setContacts(j.contacts || []); setGroups(j.groups || []); }
  }, []);
  const loadTemplates = useCallback(async () => {
    const r = await fetch('/api/pickup/admin/integrations?action=templates', { credentials: 'include' });
    const j = await r.json();
    if (r.ok && j.ok) setTemplates(j.templates || []);
  }, []);
  const loadInvites = useCallback(async () => {
    const r = await fetch('/api/pickup/admin/invite-links', { credentials: 'include' });
    const j = await r.json();
    if (r.ok && j.ok) setInvites(j.invites || []);
  }, []);
  const loadCampaigns = useCallback(async () => {
    const r = await fetch('/api/pickup/admin/integrations?action=campaigns', { credentials: 'include' });
    const j = await r.json();
    if (r.ok && j.ok) setCampaigns(j.campaigns || []);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([loadContacts(), loadTemplates(), loadInvites(), loadCampaigns()])
      .finally(() => setLoading(false));
  }, [loadContacts, loadTemplates, loadInvites, loadCampaigns]);

  const emailContacts = useMemo(
    () => contacts.filter((c) => c.email && (c.channel === 'email' || c.channel === 'both')),
    [contacts],
  );

  // ── Broadcast state ────────────────────────────────────────────────
  const [templateId, setTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [recipientMode, setRecipientMode] = useState('all'); // all | group | select
  const [recipientGroup, setRecipientGroup] = useState('');
  const [selected, setSelected] = useState({});
  const [confirmSend, setConfirmSend] = useState(false);
  const [sending, setSending] = useState(false);

  const applyTemplate = (id) => {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (t) { setSubject(t.subject || ''); setMessage(t.message || ''); }
  };

  const recipients = useMemo(() => {
    if (recipientMode === 'group') return emailContacts.filter((c) => (c.group || '') === recipientGroup);
    if (recipientMode === 'select') return emailContacts.filter((c) => selected[c.id]);
    return emailContacts;
  }, [recipientMode, recipientGroup, selected, emailContacts]);

  async function doSendBroadcast() {
    setSending(true);
    try {
      const body = {
        campaignName: subject.slice(0, 120) || 'Email hub broadcast',
        subject,
        message,
      };
      if (recipientMode === 'group') body.group = recipientGroup;
      if (recipientMode === 'select') body.contactIds = recipients.map((c) => c.id);
      const r = await fetch('/api/pickup/admin/integrations?action=campaign-email', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'send failed');
      pushToast('success', `Queued ${j.queued} email${j.queued === 1 ? '' : 's'} for delivery.`);
      setConfirmSend(false);
      setSelected({});
      await loadCampaigns();
      setTab('history');
    } catch (e) {
      pushToast('error', e.message || 'Failed to queue broadcast');
    } finally {
      setSending(false);
    }
  }

  // ── Contacts state ─────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [inviteTargets, setInviteTargets] = useState(null); // array of contacts
  const [inviteBusy, setInviteBusy] = useState(false);

  const visibleContacts = useMemo(() => {
    let list = contacts;
    if (groupFilter !== 'all') list = list.filter((c) => (c.group || '') === groupFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.studentName || '').toLowerCase().includes(q));
    }
    return list;
  }, [contacts, groupFilter, search]);

  async function syncFromForms() {
    setSyncing(true);
    try {
      const r = await fetch('/api/pickup/admin/integrations?action=sync-from-forms', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'sync failed');
      pushToast('success', `Sync complete — ${j.added} new contact${j.added === 1 ? '' : 's'} added, ${j.skipped} already present (${j.scanned} forms scanned).`);
      await loadContacts();
    } catch (e) {
      pushToast('error', e.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function addContact(payload) {
    setAddBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/integrations?action=contacts', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'add failed');
      pushToast('success', 'Contact added.');
      setAddOpen(false);
      await loadContacts();
    } catch (e) {
      pushToast('error', e.message || 'Failed to add contact');
    } finally {
      setAddBusy(false);
    }
  }

  async function deleteContact() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const r = await fetch(`/api/pickup/admin/integrations?action=contacts&id=${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE', credentials: 'include',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'delete failed');
      pushToast('success', `Removed ${deleteTarget.name || deleteTarget.email}.`);
      setDeleteTarget(null);
      await loadContacts();
    } catch (e) {
      pushToast('error', e.message || 'Failed to delete contact');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function sendInviteLink(linkId) {
    if (!inviteTargets?.length || !linkId) return;
    setInviteBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/integrations?action=send-invite-link', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: inviteTargets.map((c) => c.id), linkId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'send failed');
      pushToast('success', `Invite link queued for ${j.queued} contact${j.queued === 1 ? '' : 's'}.`);
      setInviteTargets(null);
      await loadCampaigns();
    } catch (e) {
      pushToast('error', e.message || 'Failed to send invite link');
    } finally {
      setInviteBusy(false);
    }
  }

  // ── Templates state ────────────────────────────────────────────────
  const [tplModal, setTplModal] = useState(null); // null | {} | template
  const [tplBusy, setTplBusy] = useState(false);
  const [tplDelete, setTplDelete] = useState(null);
  const [tplDeleteBusy, setTplDeleteBusy] = useState(false);

  async function saveTemplate(payload) {
    setTplBusy(true);
    try {
      const r = await fetch('/api/pickup/admin/integrations?action=templates', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'save failed');
      pushToast('success', payload.id ? 'Template updated.' : 'Template created.');
      setTplModal(null);
      await loadTemplates();
    } catch (e) {
      pushToast('error', e.message || 'Failed to save template');
    } finally {
      setTplBusy(false);
    }
  }

  async function deleteTemplate() {
    if (!tplDelete) return;
    setTplDeleteBusy(true);
    try {
      const r = await fetch(`/api/pickup/admin/integrations?action=templates&id=${encodeURIComponent(tplDelete.id)}`, {
        method: 'DELETE', credentials: 'include',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'delete failed');
      pushToast('success', `Deleted template “${tplDelete.name}”.`);
      setTplDelete(null);
      await loadTemplates();
    } catch (e) {
      pushToast('error', e.message || 'Failed to delete template');
    } finally {
      setTplDeleteBusy(false);
    }
  }

  const previewContact = recipients[0] || emailContacts[0] || null;

  return (
    <>
      <Head><title>Email Hub · BINUS Pickup</title></Head>
      <V2Layout>
        <div className="max-w-6xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                <i className="ph ph-megaphone text-brand-300" />Email Broadcasting Hub
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                Parent emails from pickup onboarding forms, broadcast campaigns, templates and invite links — all in one place.
              </p>
            </div>
            <div className="text-xs text-slate-400">
              <span className="text-slate-200 font-semibold tabular-nums">{emailContacts.length}</span> email contacts ·{' '}
              <span className="text-slate-200 font-semibold tabular-nums">{templates.length}</span> templates
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-slate-800 mb-5 overflow-x-auto">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  tab === t.key
                    ? 'text-white border-brand-400 bg-white/5'
                    : 'text-slate-400 border-transparent hover:text-slate-200'
                }`}>
                <i className={`ph ${t.icon} mr-1.5`} />{t.label}
              </button>
            ))}
          </div>

          {loading && <div className="text-xs text-slate-500 mb-3">Loading…</div>}

          {/* ── BROADCAST ─────────────────────────────────────────── */}
          {tab === 'broadcast' && (
            <div className="grid lg:grid-cols-2 gap-5">
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-800 bg-white/5 p-4">
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500">Start from template</label>
                  <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}
                    className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400">
                    <option value="">Blank message</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>

                  <label className="block mt-4 text-[11px] uppercase tracking-wider text-slate-500">Subject</label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200}
                    placeholder="Email subject"
                    className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400" />

                  <label className="block mt-3 text-[11px] uppercase tracking-wider text-slate-500">Message</label>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={8} maxLength={4000}
                    placeholder={'Dear parents,\n\nWrite your announcement here. Use {name} and {studentName} for personalization.'}
                    className="mt-1 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400" />
                  <div className="mt-1.5 text-[11px] text-slate-500">
                    <span className="font-mono text-brand-300">{'{name}'}</span> → parent name ·{' '}
                    <span className="font-mono text-brand-300">{'{studentName}'}</span> → child name
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Recipients</div>
                  <div className="flex gap-2 flex-wrap">
                    {[
                      ['all', `All email contacts (${emailContacts.length})`],
                      ['group', 'By group/class'],
                      ['select', 'Pick individually'],
                    ].map(([k, label]) => (
                      <button key={k} onClick={() => setRecipientMode(k)}
                        className={`px-3 py-1.5 text-xs rounded-lg border ${
                          recipientMode === k
                            ? 'bg-brand-500/20 border-brand-400 text-white'
                            : 'bg-white/5 border-slate-700 text-slate-300 hover:bg-white/10'
                        }`}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {recipientMode === 'group' && (
                    <select value={recipientGroup} onChange={(e) => setRecipientGroup(e.target.value)}
                      className="mt-3 w-full text-sm bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-brand-400">
                      <option value="">— choose group —</option>
                      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  )}

                  {recipientMode === 'select' && (
                    <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800">
                      {emailContacts.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 cursor-pointer">
                          <input type="checkbox" checked={!!selected[c.id]}
                            onChange={(e) => setSelected((s) => ({ ...s, [c.id]: e.target.checked }))} />
                          <span className="flex-1 truncate">{c.name || c.email}</span>
                          <span className="text-slate-500 truncate">{c.email}</span>
                          {c.group && <span className="text-[10px] px-1.5 rounded bg-slate-800 text-slate-400">{c.group}</span>}
                        </label>
                      ))}
                      {emailContacts.length === 0 && (
                        <div className="px-3 py-4 text-xs text-slate-500 text-center">No email contacts yet — sync from forms in the Contacts tab.</div>
                      )}
                    </div>
                  )}

                  <div className="mt-4 flex items-center justify-between">
                    <div className="text-xs text-slate-400">
                      Will send to <strong className="text-white tabular-nums">{recipients.length}</strong> recipient{recipients.length === 1 ? '' : 's'}
                    </div>
                    <button onClick={() => setConfirmSend(true)}
                      disabled={!subject.trim() || !message.trim() || recipients.length === 0}
                      className="px-4 py-2 text-xs font-bold rounded-lg bg-brand-500 hover:bg-brand-400 text-white disabled:opacity-40">
                      <i className="ph ph-paper-plane-tilt mr-1" />Send broadcast
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                  Live preview {previewContact ? <>· as seen by <span className="text-slate-300">{previewContact.name || previewContact.email}</span></> : ''}
                </div>
                <EmailPreview subject={subject} message={message} contact={previewContact} />
                <p className="text-[11px] text-slate-500 mt-2">
                  Emails are delivered through the queued pipeline (retry-safe, audited). The footer carries the BINUS SPIRIT values.
                </p>
              </div>
            </div>
          )}

          {/* ── CONTACTS ──────────────────────────────────────────── */}
          {tab === 'contacts' && (
            <div>
              <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <input value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, email, student…"
                    className="w-64 px-3 py-1.5 text-sm rounded-lg bg-white/5 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-400" />
                  <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}
                    className="text-sm bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none">
                    <option value="all">All groups</option>
                    {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={syncFromForms} disabled={syncing}
                    className="px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                    <i className="ph ph-arrows-clockwise mr-1" />{syncing ? 'Syncing…' : 'Sync from forms'}
                  </button>
                  <button onClick={() => setAddOpen(true)}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10">
                    <i className="ph ph-user-plus mr-1" />Add contact
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-white/5 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-900/60 text-[11px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Email</th>
                      <th className="px-3 py-2 text-left">Phone</th>
                      <th className="px-3 py-2 text-left">Student</th>
                      <th className="px-3 py-2 text-left">Group</th>
                      <th className="px-3 py-2 text-left">Source</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleContacts.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500 text-xs">
                        No contacts yet. Click <strong>Sync from forms</strong> to pull parent emails from submitted onboarding forms.
                      </td></tr>
                    )}
                    {visibleContacts.map((c) => (
                      <tr key={c.id} className="border-t border-slate-800 hover:bg-white/5">
                        <td className="px-3 py-2 text-slate-100 font-medium">{c.name || '—'}</td>
                        <td className="px-3 py-2 text-slate-300 text-xs">{c.email || '—'}</td>
                        <td className="px-3 py-2 text-slate-400 text-xs font-mono">{c.phone || '—'}</td>
                        <td className="px-3 py-2 text-slate-300 text-xs">{c.studentName || '—'}</td>
                        <td className="px-3 py-2 text-slate-300 text-xs">{c.group || '—'}</td>
                        <td className="px-3 py-2"><SourceBadge source={c.source} /></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {c.email && (
                            <button onClick={() => setInviteTargets([c])}
                              className="text-[11px] text-brand-300 hover:text-brand-200 mr-3"
                              title="Email this parent the onboarding form link">
                              <i className="ph ph-paper-plane-tilt mr-0.5" />Send invite link
                            </button>
                          )}
                          <button onClick={() => setDeleteTarget(c)}
                            className="text-[11px] text-rose-300 hover:text-rose-200">
                            <i className="ph ph-trash mr-0.5" />Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                Sync is read-only on the onboarding forms — it never modifies submissions. Existing contacts are never overwritten.
              </p>
            </div>
          )}

          {/* ── TEMPLATES ─────────────────────────────────────────── */}
          {tab === 'templates' && (
            <div>
              <div className="flex justify-end mb-4">
                <button onClick={() => setTplModal({})}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-brand-500 hover:bg-brand-400 text-white">
                  <i className="ph ph-plus mr-1" />New template
                </button>
              </div>
              {templates.length === 0 ? (
                <div className="rounded-xl border border-slate-800 bg-white/5 p-8 text-center text-xs text-slate-500">
                  No templates yet. Create one to reuse subjects and messages in broadcasts.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {templates.map((t) => (
                    <div key={t.id} className="rounded-xl border border-slate-800 bg-white/5 p-4 flex flex-col">
                      <div className="text-sm font-semibold text-white">{t.name}</div>
                      <div className="text-xs text-slate-400 mt-1">{t.subject}</div>
                      <div className="text-[11px] text-slate-500 mt-2 line-clamp-3 whitespace-pre-wrap flex-1">{t.message}</div>
                      <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-800">
                        <button onClick={() => { applyTemplate(t.id); setTab('broadcast'); }}
                          className="text-[11px] text-emerald-300 hover:text-emerald-200">
                          <i className="ph ph-megaphone mr-0.5" />Use
                        </button>
                        <div className="flex gap-3">
                          <button onClick={() => setTplModal(t)} className="text-[11px] text-brand-300 hover:text-brand-200">
                            <i className="ph ph-pencil-simple mr-0.5" />Edit
                          </button>
                          <button onClick={() => setTplDelete(t)} className="text-[11px] text-rose-300 hover:text-rose-200">
                            <i className="ph ph-trash mr-0.5" />Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── HISTORY ───────────────────────────────────────────── */}
          {tab === 'history' && (
            <div>
              <div className="flex justify-end mb-4">
                <button onClick={loadCampaigns}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/5 border border-slate-700 text-slate-300 hover:bg-white/10">
                  <i className="ph ph-arrows-clockwise mr-1" />Refresh
                </button>
              </div>
              <div className="rounded-xl border border-slate-800 bg-white/5 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-900/60 text-[11px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Campaign</th>
                      <th className="px-3 py-2 text-left">Type</th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-right">Recipients</th>
                      <th className="px-3 py-2 text-right">Sent</th>
                      <th className="px-3 py-2 text-right">Failed</th>
                      <th className="px-3 py-2 text-right">Pending</th>
                      <th className="px-3 py-2 text-left">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.length === 0 && (
                      <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500 text-xs">No campaigns yet.</td></tr>
                    )}
                    {campaigns.map((c) => (
                      <tr key={c.campaignId} className="border-t border-slate-800 hover:bg-white/5">
                        <td className="px-3 py-2 text-slate-100">{c.campaignName || c.campaignId}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            c.kind === 'invite_link'
                              ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
                              : 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                          }`}>
                            {c.kind === 'invite_link' ? 'invite link' : 'broadcast'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-400">{fmt(c.createdAt)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-300">{c.recipientCount ?? c.queued ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-300">{c.sent ?? 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-rose-300">{c.failed ?? 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-300">{c.pending ?? 0}</td>
                        <td className="px-3 py-2 text-xs text-slate-400">{c.createdBy || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </V2Layout>

      {/* Modals + toast */}
      <ConfirmModal
        open={confirmSend}
        title="Send broadcast?"
        body={
          <>
            This will queue <strong className="text-white tabular-nums">{recipients.length}</strong> personalized
            email{recipients.length === 1 ? '' : 's'} with the subject{' '}
            <em className="text-slate-200">“{subject}”</em>. Delivery starts immediately.
          </>
        }
        confirmLabel={`Send to ${recipients.length}`}
        busy={sending}
        onCancel={() => !sending && setConfirmSend(false)}
        onConfirm={doSendBroadcast}
      />
      <ConfirmModal
        open={!!deleteTarget}
        title="Remove contact?"
        body={<>Remove <strong className="text-white">{deleteTarget?.name || deleteTarget?.email}</strong> from the hub? This does not affect their submitted onboarding form.</>}
        confirmLabel="Remove"
        danger
        busy={deleteBusy}
        onCancel={() => !deleteBusy && setDeleteTarget(null)}
        onConfirm={deleteContact}
      />
      <ConfirmModal
        open={!!tplDelete}
        title="Delete template?"
        body={<>Delete template <strong className="text-white">“{tplDelete?.name}”</strong>? Past campaigns are unaffected.</>}
        confirmLabel="Delete"
        danger
        busy={tplDeleteBusy}
        onCancel={() => !tplDeleteBusy && setTplDelete(null)}
        onConfirm={deleteTemplate}
      />
      <TemplateModal
        open={!!tplModal}
        template={tplModal && tplModal.id ? tplModal : null}
        busy={tplBusy}
        onCancel={() => !tplBusy && setTplModal(null)}
        onSave={saveTemplate}
      />
      <ContactModal
        open={addOpen}
        busy={addBusy}
        onCancel={() => !addBusy && setAddOpen(false)}
        onSave={addContact}
      />
      <InviteLinkModal
        open={!!inviteTargets}
        contacts={inviteTargets || []}
        invites={invites}
        busy={inviteBusy}
        onCancel={() => !inviteBusy && setInviteTargets(null)}
        onSend={sendInviteLink}
      />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
