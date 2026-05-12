/**
 * /v2/admin/rbac — Redesigned Role-Based Access Control workspace.
 *
 * Layout:
 *   ┌─ Toolbar (search, role filter, add user, bulk import) ─────────────┐
 *   │                                                                     │
 *   │  ┌─ Users list ────────┐  ┌─ Selected user detail ──────────────┐  │
 *   │  │ • virtualised list  │  │ • profile + status + quick actions  │  │
 *   │  │ • search + filter   │  │ • role select                        │  │
 *   │  │ • role pills        │  │ • permission summary cards          │  │
 *   │  │                     │  │ • [Edit permissions] → opens drawer │  │
 *   │  └─────────────────────┘  └─────────────────────────────────────┘  │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 *   When [Edit permissions] is pressed a slide-in drawer covers ~70 % of the
 *   viewport with a 3-pane editor:
 *       Pane 1 (192 px): feature groups
 *       Pane 2 (240 px): features in selected group
 *       Pane 3 (flex):   actions of selected feature, grouped by risk tier
 *   Each pane scrolls independently — the user never scrolls the whole page.
 */
import Head from 'next/head';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AdminLayout from '../../../components/v2/AdminLayout';
import { useAuth } from '../../../lib/AuthContext';
import {
  FEATURES,
  FEATURE_GROUPS,
  resolvePermissions,
  diffFromDefaults,
} from '../../../lib/permissions';
import rbac from '../../../lib/rbac';
import { useReauthGate } from '../../../components/v2/ReauthGate';

const { ACTIONS } = rbac;

// ── helpers ────────────────────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

const ROLE_TONE = {
  owner: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  admin: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',
  guard: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  viewer: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
};

const RISK_META = {
  read:        { label: 'Read', color: 'emerald', icon: 'ph-eye' },
  write:       { label: 'Write', color: 'amber',  icon: 'ph-pencil-simple' },
  destructive: { label: 'Destructive', color: 'red', icon: 'ph-warning-octagon' },
  admin:       { label: 'Admin only', color: 'fuchsia', icon: 'ph-crown-simple' },
};

const RISK_PILL_ON = {
  emerald: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40 hover:bg-emerald-500/25',
  amber:   'bg-amber-500/15 text-amber-200 border-amber-500/40 hover:bg-amber-500/25',
  red:     'bg-red-500/15 text-red-200 border-red-500/40 hover:bg-red-500/25',
  fuchsia: 'bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-500/40 hover:bg-fuchsia-500/25',
};

const RISK_DOT = {
  emerald: 'bg-emerald-400',
  amber:   'bg-amber-400',
  red:     'bg-red-400',
  fuchsia: 'bg-fuchsia-400',
};

// Look up risk for a single feature.action, falling back to 'write'.
function actionRisk(featureKey, action) {
  return ACTIONS?.[`${featureKey}.${action}`]?.risk || 'write';
}

function actionLabel(featureKey, action) {
  return ACTIONS?.[`${featureKey}.${action}`]?.label || action;
}

// ── page ───────────────────────────────────────────────────────────────────

export default function AdminRbacPage() {
  const { user, role: myRole } = useAuth();
  const isAdmin = ['owner', 'admin'].includes(myRole);
  const { requireReauth, reauthModal } = useReauthGate();

  // Users + auth
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState(null);

  // Filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // Modals / drawers
  const [showInvite, setShowInvite] = useState(false);
  const [editingPerms, setEditingPerms] = useState(null); // { email, name, role, classScopes, permissions }
  const [savingPerms, setSavingPerms] = useState(false);
  const [actionConfirm, setActionConfirm] = useState(null); // { email, action }
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [toast, setToast] = useState(null);

  // Invite form
  const [inv, setInv] = useState({ email: '', name: '', password: '', role: 'viewer', classScopes: '', sendInviteEmail: true });
  const [inviteError, setInviteError] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);

  // Bulk import
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkError, setBulkError] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState(null);

  const getAuthHeaders = useCallback(async () => {
    if (!user) return {};
    const token = await user.getIdToken();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, [user]);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', { headers });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      }
    } catch {}
    setLoadingUsers(false);
  }, [getAuthHeaders]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  // Auto-select first user when list loads / when current selection disappears
  useEffect(() => {
    if (!users.length) { setSelectedEmail(null); return; }
    if (!selectedEmail || !users.find(u => u.email === selectedEmail)) {
      setSelectedEmail(users[0].email);
    }
  }, [users, selectedEmail]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(u => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (statusFilter === 'suspended' && !u.disabled) return false;
      if (statusFilter === 'active' && (u.disabled || !u.lastLogin)) return false;
      if (statusFilter === 'invited' && (u.disabled || u.lastLogin)) return false;
      if (!q) return true;
      return (u.email || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q);
    });
  }, [users, search, roleFilter, statusFilter]);

  const selectedUser = useMemo(
    () => users.find(u => u.email === selectedEmail) || null,
    [users, selectedEmail]
  );

  const roleCounts = useMemo(() => {
    const c = { owner: 0, admin: 0, guard: 0, viewer: 0 };
    users.forEach(u => { if (c[u.role] !== undefined) c[u.role]++; });
    return c;
  }, [users]);

  function showToast(msg, tone = 'success') {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2500);
  }

  // ── mutations ───────────────────────────────────────────────────────────

  async function handleInvite(e) {
    e.preventDefault();
    if (!inv.email.trim()) {
      setInviteError('Email is required.');
      return;
    }
    if (!inv.sendInviteEmail && (!inv.password || inv.password.length < 6)) {
      setInviteError('Password (min 6 chars) required when not emailing an invite.');
      return;
    }
    setInviteLoading(true);
    setInviteError('');
    const classScopes = inv.classScopes.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    try {
      const headers = await getAuthHeaders();
      const body = {
        email: inv.email.trim(),
        name: inv.name.trim(),
        role: inv.role,
        classScopes,
        sendInviteEmail: !!inv.sendInviteEmail,
      };
      if (!inv.sendInviteEmail) body.password = inv.password;
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setShowInvite(false);
        setInv({ email: '', name: '', password: '', role: 'viewer', classScopes: '', sendInviteEmail: true });
        fetchUsers();
        showToast(data.invited ? 'User added — invite emailed.' : 'User added.');
      } else setInviteError(data.error || data.message || 'Failed to add user.');
    } catch { setInviteError('Network error.'); }
    setInviteLoading(false);
  }

  async function handleDelete(email) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', { method: 'DELETE', headers, body: JSON.stringify({ email }) });
      if (res.ok) { setDeleteConfirm(null); fetchUsers(); showToast('User deleted.', 'danger'); }
    } catch {}
  }

  async function handleUserAction(email, action) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', { method: 'PATCH', headers, body: JSON.stringify({ email, action }) });
      if (res.ok) { setActionConfirm(null); fetchUsers(); showToast(`Action: ${action}`); }
    } catch {}
  }

  // Re-issue OTP: rotate password + email a fresh one. Requires step-up
  // reauth from the admin (same gate as report exports). Endpoint reads
  // X-Reauth-Token from the request.
  async function handleReissueOtp(targetEmail) {
    const reauth = await requireReauth({
      action: `Re-send invite email to ${targetEmail}`,
      reason: 'Re-issuing a temporary password rotates the user\u2019s current login credentials.',
    });
    if (!reauth) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/auth/users/${encodeURIComponent(targetEmail)}/reissue-otp`, {
        method: 'POST',
        headers: {
          ...headers,
          'X-Reauth-Token': reauth,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast('New temporary password emailed.');
        fetchUsers();
      } else {
        showToast(data.message || data.error || 'Failed to re-send invite.', 'danger');
      }
    } catch {
      showToast('Network error while re-sending invite.', 'danger');
    }
  }

  function openPermEditor(u) {
    setEditingPerms({
      email: u.email,
      name: u.name,
      role: u.role,
      classScopes: Array.isArray(u.classScopes) ? u.classScopes : [],
      permissions: { ...u.permissions },
    });
  }

  async function savePermissions() {
    if (!editingPerms) return;
    setSavingPerms(true);
    try {
      const headers = await getAuthHeaders();
      const overrides = diffFromDefaults(editingPerms.role, editingPerms.permissions);
      const res = await fetch('/api/auth/users', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          email: editingPerms.email,
          role: editingPerms.role,
          classScopes: editingPerms.classScopes || [],
          permissions: overrides,
        }),
      });
      if (res.ok) { setEditingPerms(null); fetchUsers(); showToast('Permissions saved.'); }
    } catch {}
    setSavingPerms(false);
  }

  // Bulk import
  function handleBulkFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const lines = String(ev.target.result).split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) { setBulkError('CSV needs header + at least one row.'); return; }
        const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
        const idx = (k) => header.indexOf(k);
        if (idx('email') === -1 || idx('password') === -1) {
          setBulkError('CSV must include email + password columns.'); return;
        }
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          const c = parseCSVLine(lines[i]);
          if (!c[idx('email')]?.trim()) continue;
          rows.push({
            email: c[idx('email')]?.trim() || '',
            name: idx('name') >= 0 ? (c[idx('name')] || '').trim() : '',
            password: c[idx('password')]?.trim() || '',
            role: (idx('role') >= 0 && c[idx('role')]?.trim()) || 'viewer',
            classScopes: (idx('classscopes') >= 0 ? (c[idx('classscopes')] || '') : '')
              .split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
          });
        }
        if (!rows.length) { setBulkError('No data rows.'); return; }
        if (rows.length > 50) { setBulkError('Max 50 rows per import.'); return; }
        setBulkRows(rows); setBulkError(''); setBulkResults(null);
      } catch { setBulkError('Failed to parse CSV.'); }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  }

  async function confirmBulkImport() {
    setBulkLoading(true); setBulkError('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/bulk-import', {
        method: 'POST', headers, body: JSON.stringify({ users: bulkRows }),
      });
      const data = await res.json();
      if (!res.ok) { setBulkError(data.error || 'Import failed.'); }
      else { setBulkResults(data); setBulkRows([]); fetchUsers(); }
    } catch { setBulkError('Network error.'); }
    setBulkLoading(false);
  }

  function downloadTemplate() {
    const csv = 'email,name,password,role,classScopes\nuser@school.edu,John Doe,Pass@123,viewer,\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'user-import-template.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  // ── render ──────────────────────────────────────────────────────────────

  const headerActions = (
    <div className="flex items-center gap-2">
      {isAdmin && (
        <>
          <button onClick={downloadTemplate}
            title="Download CSV template"
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors">
            <i className="ph ph-download-simple" /> Template
          </button>
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer">
            <i className="ph ph-file-csv text-emerald-400" /> Import CSV
            <input type="file" accept=".csv" className="hidden" onChange={handleBulkFile} />
          </label>
          <button onClick={() => setShowInvite(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-brand-500 hover:bg-brand-400 rounded-lg transition-colors">
            <i className="ph ph-user-plus" /> Add user
          </button>
        </>
      )}
    </div>
  );

  return (
    <AdminLayout
      title="RBAC"
      subtitle="Roles, users, and fine-grained permissions"
      actions={headerActions}
      fullBleed
    >
      <Head><title>RBAC · Admin</title></Head>

      {/* Master/detail grid that fills the viewport */}
      <div className="h-full grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-0 min-h-0">

        {/* ── Users list (left) ─────────────────────────────────────── */}
        <aside className="border-b lg:border-b-0 lg:border-r border-slate-800/80 bg-slate-950/60 flex flex-col min-h-0 max-h-[40vh] lg:max-h-none">
          {/* Stats */}
          <div className="px-4 py-3 border-b border-slate-800/60 grid grid-cols-4 gap-2 text-center flex-shrink-0">
            {[
              { label: 'Owner', count: roleCounts.owner, tone: 'amber' },
              { label: 'Admin', count: roleCounts.admin, tone: 'indigo' },
              { label: 'Guard', count: roleCounts.guard, tone: 'sky' },
              { label: 'Viewer', count: roleCounts.viewer, tone: 'slate' },
            ].map(s => (
              <div key={s.label} className="text-[10px]">
                <div className="text-base font-semibold text-white">{s.count}</div>
                <div className="text-slate-500 uppercase tracking-wider">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Search */}
          <div className="px-3 py-2 border-b border-slate-800/60 space-y-2 flex-shrink-0">
            <div className="relative">
              <i className="ph ph-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or email"
                className="w-full pl-8 pr-3 py-2 text-xs bg-slate-900/60 border border-slate-700/60 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-brand-500"
              />
            </div>
            <div className="flex gap-1.5 text-[10px]">
              <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
                className="flex-1 bg-slate-900/60 border border-slate-700/60 rounded px-2 py-1 text-slate-300">
                <option value="all">All roles</option>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="guard">Guard</option>
                <option value="viewer">Viewer</option>
              </select>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="flex-1 bg-slate-900/60 border border-slate-700/60 rounded px-2 py-1 text-slate-300">
                <option value="all">All status</option>
                <option value="active">Active</option>
                <option value="invited">Invited</option>
                <option value="suspended">Suspended</option>
              </select>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {loadingUsers ? (
              <div className="p-8 text-center"><div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" /></div>
            ) : filteredUsers.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">No users match these filters.</div>
            ) : (
              <ul className="divide-y divide-slate-800/40">
                {filteredUsers.map(u => {
                  const isMe = u.email === user?.email?.toLowerCase();
                  const active = u.email === selectedEmail;
                  return (
                    <li key={u.email}>
                      <button
                        onClick={() => setSelectedEmail(u.email)}
                        className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors ${
                          active ? 'bg-brand-500/10 border-l-2 border-brand-400' : 'hover:bg-white/5 border-l-2 border-transparent'
                        }`}>
                        {u.photoURL ? (
                          <img src={u.photoURL} alt="" className="w-8 h-8 rounded-full flex-shrink-0 border border-slate-700" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center text-[11px] font-bold border border-brand-500/30 flex-shrink-0">
                            {(u.name || u.email).slice(0, 2).toUpperCase()}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-white truncate">{u.name || u.email}</span>
                            {isMe && <span className="text-[9px] uppercase tracking-wide text-brand-400">you</span>}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate">{u.email}</div>
                        </div>
                        <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                          <span className={`inline-block px-1.5 py-0 rounded text-[9px] uppercase font-bold border ${ROLE_TONE[u.role] || ROLE_TONE.viewer}`}>{u.role}</span>
                          {u.disabled ? (
                            <span className="text-[9px] text-red-400">Suspended</span>
                          ) : !u.lastLogin ? (
                            <span className="text-[9px] text-slate-500">Invited</span>
                          ) : (
                            <span className="text-[9px] text-emerald-400">Active</span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="px-3 py-2 border-t border-slate-800/60 text-[10px] text-slate-500 flex-shrink-0">
            {filteredUsers.length} of {users.length} users
          </div>
        </aside>

        {/* ── Detail (right) ───────────────────────────────────────── */}
        <section className="flex flex-col min-h-0 overflow-hidden">
          {!selectedUser ? (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
              <div className="text-center">
                <i className="ph ph-user-circle text-5xl text-slate-700 mb-3 block" />
                Select a user to view permissions.
              </div>
            </div>
          ) : (
            <UserDetailPanel
              key={selectedUser.email}
              user={selectedUser}
              myEmail={user?.email?.toLowerCase()}
              isAdmin={isAdmin}
              actionConfirm={actionConfirm}
              setActionConfirm={setActionConfirm}
              deleteConfirm={deleteConfirm}
              setDeleteConfirm={setDeleteConfirm}
              onAction={handleUserAction}
              onDelete={handleDelete}
              onEditPerms={() => openPermEditor(selectedUser)}
              onReissueOtp={handleReissueOtp}
            />
          )}
        </section>
      </div>

      {/* ── Invite modal ────────────────────────────────────────────── */}
      {showInvite && (
        <Modal title="Add authorized user" onClose={() => { setShowInvite(false); setInviteError(''); }}>
          <form onSubmit={handleInvite} className="space-y-3">
            {inviteError && (
              <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">{inviteError}</div>
            )}
            <Field label="Email">
              <input type="email" required value={inv.email}
                onChange={e => setInv(i => ({ ...i, email: e.target.value }))}
                className="modal-input" placeholder="user@binus.edu" />
            </Field>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-800/40 border border-slate-700">
              <input id="send-invite" type="checkbox" checked={!!inv.sendInviteEmail}
                onChange={e => setInv(i => ({ ...i, sendInviteEmail: e.target.checked }))}
                className="mt-1" />
              <label htmlFor="send-invite" className="text-xs text-slate-300 leading-snug cursor-pointer">
                <strong>Email a one-time password to the user</strong>
                <div className="text-slate-500 mt-0.5">
                  Recommended. They’ll be required to set a new password on first login. Uncheck to set a password manually below.
                </div>
              </label>
            </div>
            {!inv.sendInviteEmail && (
              <Field label="Password (min 6)">
                <input type="password" required minLength={6} value={inv.password}
                  onChange={e => setInv(i => ({ ...i, password: e.target.value }))}
                  className="modal-input" />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Display name">
                <input type="text" value={inv.name}
                  onChange={e => setInv(i => ({ ...i, name: e.target.value }))}
                  className="modal-input" placeholder="John Doe" />
              </Field>
              <Field label="Role">
                <select value={inv.role}
                  onChange={e => setInv(i => ({ ...i, role: e.target.value }))}
                  className="modal-input">
                  <option value="viewer">Viewer</option>
                  <option value="guard">Guard (pickup)</option>
                  <option value="admin">Admin</option>
                  {myRole === 'owner' && <option value="owner">Owner</option>}
                </select>
              </Field>
            </div>
            <Field label="Class scopes (comma-separated, optional)">
              <input value={inv.classScopes}
                onChange={e => setInv(i => ({ ...i, classScopes: e.target.value }))}
                className="modal-input" placeholder="4A, 4B, 5C" />
            </Field>
            <div className="flex items-center gap-2 pt-2">
              <button type="submit" disabled={inviteLoading}
                className="px-4 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold disabled:opacity-50">
                {inviteLoading ? 'Adding…' : 'Add user'}
              </button>
              <button type="button" onClick={() => { setShowInvite(false); setInviteError(''); }}
                className="px-3 py-2 text-slate-400 hover:text-white text-sm">Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Bulk import modal ───────────────────────────────────────── */}
      {(bulkRows.length > 0 || bulkResults || bulkError) && (
        <Modal
          title={bulkResults ? 'Import results' : `CSV preview — ${bulkRows.length} row${bulkRows.length !== 1 ? 's' : ''}`}
          onClose={() => { setBulkRows([]); setBulkResults(null); setBulkError(''); }}
          wide
        >
          {bulkError && !bulkResults && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
              <i className="ph ph-warning mr-1" />{bulkError}
            </div>
          )}
          {bulkResults ? (
            <BulkResultsTable results={bulkResults} />
          ) : bulkRows.length > 0 ? (
            <>
              <div className="overflow-auto max-h-[50vh] border border-slate-800 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-950/60 text-slate-400 uppercase tracking-wider text-[10px] sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Email</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Role</th>
                      <th className="px-3 py-2 text-left">Classes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {bulkRows.map((r, i) => (
                      <tr key={i} className="hover:bg-white/5">
                        <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-1.5 text-slate-200 font-mono">{r.email}</td>
                        <td className="px-3 py-1.5 text-slate-300">{r.name || '—'}</td>
                        <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase font-bold ${ROLE_TONE[r.role] || ROLE_TONE.viewer}`}>{r.role}</span></td>
                        <td className="px-3 py-1.5 text-slate-400">{(r.classScopes || []).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <button onClick={confirmBulkImport} disabled={bulkLoading}
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold disabled:opacity-50">
                  {bulkLoading ? 'Importing…' : `Import ${bulkRows.length} users`}
                </button>
                <button onClick={() => { setBulkRows([]); setBulkError(''); }}
                  className="px-3 py-2 text-slate-400 hover:text-white text-sm">Cancel</button>
              </div>
            </>
          ) : null}
        </Modal>
      )}

      {/* ── Permissions drawer ──────────────────────────────────────── */}
      {editingPerms && (
        <PermissionDrawer
          state={editingPerms}
          setState={setEditingPerms}
          onCancel={() => setEditingPerms(null)}
          onSave={savePermissions}
          saving={savingPerms}
          ownerCanGrantOwner={myRole === 'owner'}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl shadow-2xl border z-[60] text-sm ${
          toast.tone === 'danger'
            ? 'bg-red-500/15 border-red-500/30 text-red-200'
            : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
        }`}>
          <i className={`ph ${toast.tone === 'danger' ? 'ph-warning' : 'ph-check-circle'} mr-2`} />
          {toast.msg}
        </div>
      )}

      <style jsx global>{`
        .modal-input {
          width: 100%;
          background: rgba(2, 6, 23, 0.5);
          border: 1px solid rgb(51, 65, 85);
          border-radius: 0.5rem;
          padding: 0.55rem 0.75rem;
          font-size: 0.8125rem;
          color: white;
          outline: none;
        }
        .modal-input:focus {
          border-color: rgb(34, 211, 238);
          box-shadow: 0 0 0 1px rgb(34, 211, 238);
        }
      `}</style>
      {reauthModal}
    </AdminLayout>
  );
}

// ── Detail panel ───────────────────────────────────────────────────────────

function UserDetailPanel({ user, myEmail, isAdmin, actionConfirm, setActionConfirm, deleteConfirm, setDeleteConfirm, onAction, onDelete, onEditPerms, onReissueOtp }) {
  const isMe = user.email === myEmail;
  const canManage = isAdmin && !isMe && !user.superAdmin;

  // Summarise permissions: count granted actions per group
  const summary = useMemo(() => {
    return FEATURE_GROUPS.map(group => {
      let total = 0, granted = 0;
      group.features.forEach(fk => {
        const meta = FEATURES[fk];
        if (!meta) return;
        meta.actions.forEach(a => {
          total++;
          if (user.permissions?.[fk]?.[a]) granted++;
        });
      });
      return { ...group, total, granted };
    });
  }, [user]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Profile header */}
      <div className="px-6 py-5 border-b border-slate-800/80 flex items-center gap-4 flex-shrink-0">
        {user.photoURL ? (
          <img src={user.photoURL} alt="" className="w-16 h-16 rounded-full border-2 border-slate-700" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-16 h-16 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center text-xl font-bold border-2 border-brand-500/30">
            {(user.name || user.email).slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-semibold text-white truncate">{user.name || user.email}</h2>
            <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-bold border ${ROLE_TONE[user.role] || ROLE_TONE.viewer}`}>{user.role}</span>
            {user.superAdmin && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                <i className="ph ph-crown text-xs" /> Super
              </span>
            )}
            {user.disabled && (
              <span className="px-2 py-0.5 rounded-full text-[10px] uppercase font-bold bg-red-500/10 text-red-400 border border-red-500/20">Suspended</span>
            )}
            {user.mustChangePassword && (
              <span title="User has not yet changed their temporary password" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-bold bg-amber-500/10 text-amber-300 border border-amber-500/20">
                <i className="ph ph-hourglass-medium text-xs" /> Pending first login
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-1 truncate">{user.email}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            Last sign-in: {timeAgo(user.lastLogin)} {user.lastIP && <span className="font-mono ml-2">· {user.lastIP}</span>}
          </div>
        </div>

        {canManage && (
          <div className="flex flex-col gap-2 flex-shrink-0">
            <button onClick={onEditPerms}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all">
              <i className="ph ph-sliders-horizontal" /> Edit permissions
            </button>
          </div>
        )}
      </div>

      {/* Quick actions */}
      {canManage && (
        <div className="px-6 py-3 border-b border-slate-800/60 flex flex-wrap gap-2 flex-shrink-0">
          {/* Suspend / Activate */}
          {actionConfirm?.email === user.email && actionConfirm?.action === 'suspend' ? (
            <ConfirmCluster
              tone="amber"
              onConfirm={() => onAction(user.email, 'suspend')}
              onCancel={() => setActionConfirm(null)}
            />
          ) : actionConfirm?.email === user.email && actionConfirm?.action === 'unsuspend' ? (
            <ConfirmCluster
              tone="emerald"
              onConfirm={() => onAction(user.email, 'unsuspend')}
              onCancel={() => setActionConfirm(null)}
            />
          ) : user.disabled ? (
            <button onClick={() => setActionConfirm({ email: user.email, action: 'unsuspend' })}
              className="action-btn action-btn-emerald">
              <i className="ph ph-play" /> Activate
            </button>
          ) : (
            <button onClick={() => setActionConfirm({ email: user.email, action: 'suspend' })}
              className="action-btn action-btn-amber">
              <i className="ph ph-pause" /> Suspend
            </button>
          )}

          {/* Reset password */}
          {actionConfirm?.email === user.email && actionConfirm?.action === 'reset-password' ? (
            <ConfirmCluster
              tone="indigo"
              onConfirm={() => onAction(user.email, 'reset-password')}
              onCancel={() => setActionConfirm(null)}
            />
          ) : (
            <button onClick={() => setActionConfirm({ email: user.email, action: 'reset-password' })}
              className="action-btn action-btn-indigo">
              <i className="ph ph-key" /> Reset password
            </button>
          )}

          {/* Re-issue OTP & email */}
          {onReissueOtp && (
            <button onClick={() => onReissueOtp(user.email)}
              className="action-btn action-btn-indigo">
              <i className="ph ph-envelope-simple" /> Email new OTP
            </button>
          )}

          {/* Revoke */}
          {actionConfirm?.email === user.email && actionConfirm?.action === 'revoke' ? (
            <ConfirmCluster
              tone="orange"
              onConfirm={() => onAction(user.email, 'revoke')}
              onCancel={() => setActionConfirm(null)}
            />
          ) : (
            <button onClick={() => setActionConfirm({ email: user.email, action: 'revoke' })}
              className="action-btn action-btn-orange">
              <i className="ph ph-prohibit" /> Revoke sessions
            </button>
          )}

          {/* Delete */}
          {deleteConfirm === user.email ? (
            <ConfirmCluster
              tone="red"
              onConfirm={() => onDelete(user.email)}
              onCancel={() => setDeleteConfirm(null)}
            />
          ) : (
            <button onClick={() => setDeleteConfirm(user.email)}
              className="action-btn action-btn-red">
              <i className="ph ph-trash" /> Delete
            </button>
          )}
        </div>
      )}

      {/* Permissions overview cards (no edit here — opens drawer) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <div className="text-xs uppercase tracking-widest text-slate-500 mb-3">Permission overview</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {summary.map(g => {
            const pct = g.total > 0 ? Math.round((g.granted / g.total) * 100) : 0;
            const tone = pct === 100 ? 'emerald' : pct === 0 ? 'slate' : pct >= 50 ? 'amber' : 'sky';
            return (
              <div key={g.label} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-white">{g.label}</h3>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                    tone === 'emerald' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' :
                    tone === 'amber' ? 'bg-amber-500/10 text-amber-300 border-amber-500/30' :
                    tone === 'sky' ? 'bg-sky-500/10 text-sky-300 border-sky-500/30' :
                    'bg-slate-500/10 text-slate-400 border-slate-700/40'
                  }`}>{pct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden mb-2">
                  <div className={`h-full ${
                    tone === 'emerald' ? 'bg-emerald-400' :
                    tone === 'amber' ? 'bg-amber-400' :
                    tone === 'sky' ? 'bg-sky-400' : 'bg-slate-600'
                  }`} style={{ width: `${pct}%` }} />
                </div>
                <div className="text-[11px] text-slate-500">{g.granted} of {g.total} actions granted</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {g.features.map(fk => {
                    const meta = FEATURES[fk];
                    if (!meta) return null;
                    const has = meta.actions.some(a => user.permissions?.[fk]?.[a]);
                    return (
                      <span key={fk} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${
                        has ? 'text-slate-300 border-slate-700 bg-slate-800/60' : 'text-slate-600 border-slate-800 bg-slate-900/40'
                      }`}>
                        <i className={`ph ${meta.icon} text-xs`} /> {meta.label}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {Array.isArray(user.classScopes) && user.classScopes.length > 0 && (
          <div className="mt-5">
            <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">Class scopes</div>
            <div className="flex flex-wrap gap-1.5">
              {user.classScopes.map(c => (
                <span key={c} className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 border border-slate-700 text-slate-200">{c}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .action-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.4rem 0.75rem;
          font-size: 0.6875rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-radius: 0.5rem;
          border: 1px solid;
          transition: all 0.15s;
        }
        .action-btn-amber  { color: rgb(252, 211, 77); border-color: rgba(245, 158, 11, 0.25); }
        .action-btn-amber:hover  { background: rgba(245, 158, 11, 0.1); }
        .action-btn-emerald { color: rgb(110, 231, 183); border-color: rgba(16, 185, 129, 0.25); }
        .action-btn-emerald:hover { background: rgba(16, 185, 129, 0.1); }
        .action-btn-indigo { color: rgb(165, 180, 252); border-color: rgba(99, 102, 241, 0.25); }
        .action-btn-indigo:hover { background: rgba(99, 102, 241, 0.1); }
        .action-btn-orange { color: rgb(253, 186, 116); border-color: rgba(249, 115, 22, 0.25); }
        .action-btn-orange:hover { background: rgba(249, 115, 22, 0.1); }
        .action-btn-red    { color: rgb(252, 165, 165); border-color: rgba(239, 68, 68, 0.25); }
        .action-btn-red:hover    { background: rgba(239, 68, 68, 0.1); }
      `}</style>
    </div>
  );
}

function ConfirmCluster({ tone, onConfirm, onCancel }) {
  const cls = {
    amber: 'text-amber-300 bg-amber-500/15 border-amber-500/30 hover:bg-amber-500/25',
    emerald: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30 hover:bg-emerald-500/25',
    indigo: 'text-indigo-300 bg-indigo-500/15 border-indigo-500/30 hover:bg-indigo-500/25',
    orange: 'text-orange-300 bg-orange-500/15 border-orange-500/30 hover:bg-orange-500/25',
    red: 'text-red-300 bg-red-500/15 border-red-500/30 hover:bg-red-500/25',
  }[tone];
  return (
    <div className="inline-flex items-center gap-1.5">
      <button onClick={onConfirm} className={`px-3 py-1.5 text-[10px] font-semibold border rounded-lg ${cls}`}>Confirm</button>
      <button onClick={onCancel} className="px-2 py-1.5 text-[10px] text-slate-400 hover:text-white">Cancel</button>
    </div>
  );
}

// ── Permission drawer (3-pane) ─────────────────────────────────────────────

function PermissionDrawer({ state, setState, onCancel, onSave, saving, ownerCanGrantOwner }) {
  const [activeGroup, setActiveGroup] = useState(FEATURE_GROUPS[0]?.label || 'Main');
  const [activeFeature, setActiveFeature] = useState(null);
  // Sub-module key (e.g. 'review' under pickup_admin). null = show ALL actions for the feature.
  const [activeSubKey, setActiveSubKey] = useState(null);
  const [scopesInput, setScopesInput] = useState((state.classScopes || []).join(', '));

  // Pick first feature in active group when group changes (or initially)
  useEffect(() => {
    const grp = FEATURE_GROUPS.find(g => g.label === activeGroup);
    if (!grp) return;
    if (!activeFeature || !grp.features.includes(activeFeature)) {
      setActiveFeature(grp.features[0]);
    }
  }, [activeGroup, activeFeature]);

  // When the active feature changes, reset the sub-module selection.
  useEffect(() => { setActiveSubKey(null); }, [activeFeature]);

  // Sync scopes input back to state on blur
  function commitScopes() {
    setState(prev => ({
      ...prev,
      classScopes: scopesInput.split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
    }));
  }

  function togglePermAction(feature, action) {
    setState(prev => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [feature]: { ...prev.permissions[feature], [action]: !prev.permissions?.[feature]?.[action] },
      },
    }));
  }

  function setAllInFeature(feature, enabled) {
    const meta = FEATURES[feature];
    if (!meta) return;
    setState(prev => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [feature]: Object.fromEntries(meta.actions.map(a => [a, enabled])),
      },
    }));
  }

  function setAllInGroup(groupLabel, enabled) {
    const grp = FEATURE_GROUPS.find(g => g.label === groupLabel);
    if (!grp) return;
    setState(prev => {
      const next = { ...prev.permissions };
      grp.features.forEach(fk => {
        const meta = FEATURES[fk];
        if (!meta) return;
        next[fk] = Object.fromEntries(meta.actions.map(a => [a, enabled]));
      });
      return { ...prev, permissions: next };
    });
  }

  function changeRole(newRole) {
    const newPerms = resolvePermissions(newRole);
    setState(prev => ({ ...prev, role: newRole, permissions: newPerms }));
  }

  // Counts per group/feature for the badges
  const grantedPerGroup = useMemo(() => {
    const map = {};
    FEATURE_GROUPS.forEach(g => {
      let total = 0, granted = 0;
      g.features.forEach(fk => {
        const meta = FEATURES[fk]; if (!meta) return;
        meta.actions.forEach(a => { total++; if (state.permissions?.[fk]?.[a]) granted++; });
      });
      map[g.label] = { total, granted };
    });
    return map;
  }, [state.permissions]);

  const grantedPerFeature = useMemo(() => {
    const map = {};
    Object.keys(FEATURES).forEach(fk => {
      const meta = FEATURES[fk]; if (!meta) return;
      let granted = 0;
      meta.actions.forEach(a => { if (state.permissions?.[fk]?.[a]) granted++; });
      map[fk] = { total: meta.actions.length, granted };
    });
    return map;
  }, [state.permissions]);

  const featureMeta = activeFeature ? FEATURES[activeFeature] : null;
  const featurePerms = activeFeature ? (state.permissions?.[activeFeature] || {}) : {};

  // Active sub-module (when the feature defines subModules, e.g. pickup_admin).
  const activeSub = useMemo(() => {
    if (!featureMeta?.subModules || !activeSubKey) return null;
    return featureMeta.subModules.find(s => s.key === activeSubKey) || null;
  }, [featureMeta, activeSubKey]);

  // Per-sub-module granted counts for badges in pane 2.
  const grantedPerSub = useMemo(() => {
    if (!featureMeta?.subModules) return {};
    const map = {};
    featureMeta.subModules.forEach(sm => {
      let granted = 0;
      sm.actions.forEach(a => { if (featurePerms[a]) granted++; });
      map[sm.key] = { total: sm.actions.length, granted };
    });
    return map;
  }, [featureMeta, featurePerms]);

  // Group actions of selected feature (or active sub-module slice) by risk
  const actionsByRisk = useMemo(() => {
    if (!featureMeta || !activeFeature) return {};
    const out = { read: [], write: [], destructive: [], admin: [] };
    const list = activeSub ? activeSub.actions : featureMeta.actions;
    list.forEach(a => {
      const r = actionRisk(activeFeature, a);
      (out[r] || out.write).push(a);
    });
    return out;
  }, [featureMeta, activeFeature, activeSub]);

  function setAllInSub(enabled) {
    if (!featureMeta || !activeSub) return;
    setState(prev => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [activeFeature]: {
          ...prev.permissions?.[activeFeature],
          ...Object.fromEntries(activeSub.actions.map(a => [a, enabled])),
        },
      },
    }));
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-50 backdrop-blur-sm animate-fade-in" onClick={onCancel} />

      {/* Drawer */}
      <div className="fixed top-0 right-0 bottom-0 z-[55] w-full lg:w-[78vw] xl:w-[72vw] max-w-[1400px] bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col animate-slide-in-right">

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b border-slate-800 bg-slate-900/50 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center flex-shrink-0">
            <i className="ph ph-sliders-horizontal text-brand-300 text-xl" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white truncate">Edit permissions — {state.name || state.email}</h2>
            <p className="text-[11px] text-slate-500 truncate">{state.email} · changes apply on next request after Save</p>
          </div>
          <select value={state.role} onChange={e => changeRole(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-lg py-1.5 px-3 text-xs text-white focus:outline-none focus:border-brand-500">
            <option value="viewer">Viewer (defaults)</option>
            <option value="guard">Guard (defaults)</option>
            <option value="admin">Admin (defaults)</option>
            {ownerCanGrantOwner && <option value="owner">Owner (defaults)</option>}
          </select>
          <button onClick={onCancel} className="text-slate-500 hover:text-white">
            <i className="ph ph-x text-xl" />
          </button>
        </div>

        {/* 3-pane editor */}
        <div className="flex-1 min-h-0 grid grid-cols-[180px_240px_1fr] overflow-hidden">

          {/* Pane 1: Groups */}
          <div className="border-r border-slate-800 bg-slate-950/60 overflow-y-auto">
            <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-slate-600 font-semibold border-b border-slate-800/60">Categories</div>
            <ul>
              {FEATURE_GROUPS.map(g => {
                const stats = grantedPerGroup[g.label] || { total: 0, granted: 0 };
                const active = g.label === activeGroup;
                return (
                  <li key={g.label}>
                    <button onClick={() => setActiveGroup(g.label)}
                      className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-2 text-xs transition-colors border-l-2 ${
                        active
                          ? 'bg-brand-500/10 text-brand-200 border-brand-400'
                          : 'text-slate-300 hover:bg-white/5 border-transparent'
                      }`}>
                      <span className="font-medium truncate">{g.label}</span>
                      <span className={`text-[10px] font-mono ${stats.granted === stats.total ? 'text-emerald-400' : stats.granted === 0 ? 'text-slate-600' : 'text-amber-400'}`}>
                        {stats.granted}/{stats.total}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="px-3 py-2 mt-2 border-t border-slate-800/60 space-y-1">
              <button onClick={() => setAllInGroup(activeGroup, true)}
                className="w-full text-left px-2 py-1.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10 rounded">
                <i className="ph ph-check-square mr-1" /> Grant all in group
              </button>
              <button onClick={() => setAllInGroup(activeGroup, false)}
                className="w-full text-left px-2 py-1.5 text-[10px] text-slate-400 hover:bg-white/5 rounded">
                <i className="ph ph-square mr-1" /> Clear all in group
              </button>
            </div>
          </div>

          {/* Pane 2: Features in selected group */}
          <div className="border-r border-slate-800 bg-slate-950/40 overflow-y-auto">
            <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-slate-600 font-semibold border-b border-slate-800/60">{activeGroup}</div>
            <ul>
              {(FEATURE_GROUPS.find(g => g.label === activeGroup)?.features || []).map(fk => {
                const meta = FEATURES[fk]; if (!meta) return null;
                const stats = grantedPerFeature[fk] || { total: 0, granted: 0 };
                const active = fk === activeFeature;
                const tone = stats.granted === stats.total ? 'text-emerald-400'
                  : stats.granted === 0 ? 'text-slate-600' : 'text-amber-400';
                return (
                  <li key={fk}>
                    <button onClick={() => { setActiveFeature(fk); setActiveSubKey(null); }}
                      className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 text-xs transition-colors border-l-2 ${
                        active
                          ? 'bg-brand-500/10 text-brand-200 border-brand-400'
                          : 'text-slate-300 hover:bg-white/5 border-transparent'
                      }`}>
                      <i className={`ph ${meta.icon} text-base flex-shrink-0`} />
                      <span className="flex-1 truncate font-medium">{meta.label}</span>
                      <span className={`text-[10px] font-mono ${tone}`}>{stats.granted}/{stats.total}</span>
                    </button>

                    {/* Sub-modules (e.g. pickup_admin → Review Queue, Chaperones, Devices, …) */}
                    {active && Array.isArray(meta.subModules) && meta.subModules.length > 0 && (
                      <ul className="border-t border-slate-800/40 bg-slate-950/40">
                        <li>
                          <button onClick={() => setActiveSubKey(null)}
                            className={`w-full text-left pl-9 pr-3 py-1.5 flex items-center gap-2 text-[11px] transition-colors border-l-2 ${
                              activeSubKey === null
                                ? 'bg-brand-500/15 text-brand-100 border-brand-400'
                                : 'text-slate-400 hover:bg-white/5 border-transparent hover:text-slate-200'
                            }`}>
                            <i className="ph ph-list-dashes text-sm flex-shrink-0" />
                            <span className="flex-1 truncate">All actions</span>
                            <span className="text-[10px] font-mono opacity-70">{stats.granted}/{stats.total}</span>
                          </button>
                        </li>
                        {meta.subModules.map(sm => {
                          const sStats = grantedPerSub[sm.key] || { total: 0, granted: 0 };
                          const sActive = sm.key === activeSubKey;
                          const sTone = sStats.granted === sStats.total ? 'text-emerald-400'
                            : sStats.granted === 0 ? 'text-slate-600' : 'text-amber-400';
                          return (
                            <li key={sm.key}>
                              <button onClick={() => setActiveSubKey(sm.key)}
                                className={`w-full text-left pl-9 pr-3 py-1.5 flex items-center gap-2 text-[11px] transition-colors border-l-2 ${
                                  sActive
                                    ? 'bg-brand-500/15 text-brand-100 border-brand-400'
                                    : 'text-slate-400 hover:bg-white/5 border-transparent hover:text-slate-200'
                                }`}>
                                <i className={`ph ${sm.icon || 'ph-square'} text-sm flex-shrink-0`} />
                                <span className="flex-1 truncate">{sm.label}</span>
                                <span className={`text-[10px] font-mono ${sTone}`}>{sStats.granted}/{sStats.total}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Pane 3: Action toggles for selected feature */}
          <div className="overflow-y-auto bg-slate-950/20">
            {!featureMeta ? (
              <div className="p-8 text-center text-xs text-slate-500">Select a feature.</div>
            ) : (
              <div className="p-5">
                <div className="flex items-center gap-3 mb-4">
                  <i className={`ph ${activeSub?.icon || featureMeta.icon} text-2xl text-brand-300`} />
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-white">
                      {activeSub ? `${featureMeta.label} · ${activeSub.label}` : featureMeta.label}
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      {activeSub
                        ? `${activeSub.actions.length} action${activeSub.actions.length !== 1 ? 's' : ''} in this sub-module. Use the All / None buttons to bulk-toggle just this slice.`
                        : 'Toggle individual actions. Hover for full description.'}
                    </p>
                  </div>
                  {activeSub ? (
                    <>
                      <button onClick={() => setAllInSub(true)}
                        className="px-2.5 py-1 text-[10px] text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-500/10">All in module</button>
                      <button onClick={() => setAllInSub(false)}
                        className="px-2.5 py-1 text-[10px] text-slate-400 border border-slate-700 rounded hover:bg-white/5">None in module</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => setAllInFeature(activeFeature, true)}
                        className="px-2.5 py-1 text-[10px] text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-500/10">All</button>
                      <button onClick={() => setAllInFeature(activeFeature, false)}
                        className="px-2.5 py-1 text-[10px] text-slate-400 border border-slate-700 rounded hover:bg-white/5">None</button>
                    </>
                  )}
                </div>

                {['read', 'write', 'destructive', 'admin'].map(risk => {
                  const list = actionsByRisk[risk] || [];
                  if (!list.length) return null;
                  const meta = RISK_META[risk];
                  return (
                    <div key={risk} className="mb-5">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${RISK_DOT[meta.color]}`} />
                        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-400">{meta.label}</span>
                        <span className="text-[10px] text-slate-600">{list.length} action{list.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {list.map(action => {
                          const on = !!featurePerms[action];
                          return (
                            <button
                              key={action}
                              onClick={() => togglePermAction(activeFeature, action)}
                              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all ${
                                on
                                  ? RISK_PILL_ON[meta.color]
                                  : 'bg-slate-900/40 border-slate-800 text-slate-500 hover:border-slate-600 hover:text-slate-300'
                              }`}
                            >
                              <i className={`ph ${on ? 'ph-check-square' : 'ph-square'} text-base flex-shrink-0`} />
                              <div className="flex-1 min-w-0">
                                <div className="text-[11px] font-mono leading-tight truncate">{action}</div>
                                <div className="text-[10px] opacity-80 leading-tight truncate">{actionLabel(activeFeature, action)}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-3 border-t border-slate-800 bg-slate-900/50 flex items-center gap-4">
          <div className="flex-1 flex items-center gap-3">
            <label className="text-[11px] text-slate-400 uppercase tracking-wider whitespace-nowrap">Class scopes</label>
            <input
              value={scopesInput}
              onChange={e => setScopesInput(e.target.value)}
              onBlur={commitScopes}
              placeholder="e.g. 4A, 4B (empty = all classes)"
              className="flex-1 bg-slate-900/60 border border-slate-700/60 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand-500"
            />
          </div>
          <button onClick={onCancel}
            className="px-3 py-2 text-xs text-slate-400 hover:text-white">Cancel</button>
          <button onClick={() => { commitScopes(); onSave(); }} disabled={saving}
            className="inline-flex items-center gap-1.5 px-5 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-xs font-semibold disabled:opacity-50">
            {saving ? <><i className="ph ph-spinner-gap animate-spin" />Saving…</> : <><i className="ph ph-floppy-disk" />Save permissions</>}
          </button>
        </div>
      </div>

      <style jsx global>{`
        @keyframes drawer-slide-in {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes drawer-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .animate-slide-in-right { animation: drawer-slide-in 0.25s cubic-bezier(0.32, 0.72, 0.32, 1); }
        .animate-fade-in { animation: drawer-fade-in 0.2s ease-out; }
      `}</style>
    </>
  );
}

// ── Reusable bits ──────────────────────────────────────────────────────────

function Modal({ children, title, onClose, wide = false }) {
  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50 backdrop-blur-sm" onClick={onClose} />
      <div className={`fixed inset-0 z-[55] flex items-center justify-center p-4 pointer-events-none`}>
        <div className={`pointer-events-auto bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-md'} max-h-[85vh] flex flex-col`}>
          <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            <button onClick={onClose} className="text-slate-500 hover:text-white">
              <i className="ph ph-x text-lg" />
            </button>
          </div>
          <div className="p-5 overflow-y-auto">{children}</div>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[11px] text-slate-400 block mb-1 uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}

function BulkResultsTable({ results }) {
  const { total, succeeded, failed } = results;
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        {failed === 0 ? (
          <i className="ph ph-check-circle text-emerald-400 text-2xl" />
        ) : succeeded === 0 ? (
          <i className="ph ph-x-circle text-red-400 text-2xl" />
        ) : (
          <i className="ph ph-warning text-amber-400 text-2xl" />
        )}
        <div className="text-sm text-white">
          {succeeded} of {total} imported{failed > 0 ? `, ${failed} failed` : ''}
        </div>
      </div>
      <div className="overflow-auto max-h-[50vh] border border-slate-800 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-slate-950/60 text-slate-400 uppercase tracking-wider text-[10px] sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {(results.results || []).map((r, i) => (
              <tr key={i} className={r.ok ? '' : 'bg-red-500/5'}>
                <td className="px-3 py-1.5 text-slate-500">{r.row}</td>
                <td className="px-3 py-1.5 text-slate-200 font-mono">{r.email}</td>
                <td className="px-3 py-1.5">
                  {r.ok
                    ? <span className="text-emerald-400"><i className="ph ph-check-circle mr-1" />OK</span>
                    : <span className="text-red-300"><i className="ph ph-x-circle mr-1" />Failed</span>}
                </td>
                <td className="px-3 py-1.5 text-red-300">{r.error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
