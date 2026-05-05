import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState, useEffect, useCallback, useMemo } from 'react';
import V2Layout from '../../components/v2/V2Layout';
import { useAuth } from '../../lib/AuthContext';
import { getAllowedSettingsTabs, FEATURES, FEATURE_GROUPS, resolvePermissions, diffFromDefaults } from '../../lib/permissions';

export default function SettingsPage() {
  const router = useRouter();
  const { user, role, permissions } = useAuth();
  const [activeTab, setActiveTab] = useState('');
  const [users, setUsers] = useState([]);
  const [accessLogs, setAccessLogs] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviteClassScopes, setInviteClassScopes] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [actionConfirm, setActionConfirm] = useState(null); // { email, action: 'suspend'|'revoke'|'unsuspend' }
  const [editingPerms, setEditingPerms] = useState(null); // { email, role, permissions }
  const [savingPerms, setSavingPerms] = useState(false);
  const [logFilter, setLogFilter] = useState('');

  // Teacher Management tab state
  const [teacherSearch, setTeacherSearch] = useState('');
  const [addTeacherOpen, setAddTeacherOpen] = useState(false);
  const [addTeacherEmail, setAddTeacherEmail] = useState('');
  const [addTeacherName, setAddTeacherName] = useState('');
  const [addTeacherPassword, setAddTeacherPassword] = useState('');
  const [addTeacherClassScopes, setAddTeacherClassScopes] = useState('');
  const [addTeacherError, setAddTeacherError] = useState('');
  const [addTeacherLoading, setAddTeacherLoading] = useState(false);
  const [resetPasswordFor, setResetPasswordFor] = useState(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetPasswordError, setResetPasswordError] = useState('');
  const [resetPasswordLoading, setResetPasswordLoading] = useState(false);
  const [resetPasswordSuccess, setResetPasswordSuccess] = useState(null);
  const [editClassScopesFor, setEditClassScopesFor] = useState(null);
  const [editClassScopesValue, setEditClassScopesValue] = useState('');
  const [editClassScopesSaving, setEditClassScopesSaving] = useState(false);
  const [teacherActionConfirm, setTeacherActionConfirm] = useState(null);

  // Bulk import state (shared for both user + teacher tabs)
  const [bulkImportTarget, setBulkImportTarget] = useState(null); // null | 'users' | 'teachers'
  const [bulkImportRows, setBulkImportRows] = useState([]);
  const [bulkImportLoading, setBulkImportLoading] = useState(false);
  const [bulkImportResults, setBulkImportResults] = useState(null);
  const [bulkImportError, setBulkImportError] = useState('');

  const filteredLogs = useMemo(() => {
    if (!logFilter.trim()) return accessLogs;
    const q = logFilter.toLowerCase().trim();
    return accessLogs.filter(l =>
      (l.ip || '').toLowerCase().includes(q) ||
      (l.email || '').toLowerCase().includes(q) ||
      (l.name || '').toLowerCase().includes(q) ||
      (l.browser || '').toLowerCase().includes(q) ||
      (l.os || '').toLowerCase().includes(q) ||
      (l.device || '').toLowerCase().includes(q)
    );
  }, [accessLogs, logFilter]);

  const filteredTeachers = useMemo(() => {
    const teachers = users.filter(u => u.role === 'teacher');
    if (!teacherSearch.trim()) return teachers;
    const q = teacherSearch.toLowerCase().trim();
    return teachers.filter(u =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.classScopes || []).some(c => c.toLowerCase().includes(q))
    );
  }, [users, teacherSearch]);

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
  }, [getAuthHeaders, user]);

  const fetchLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const res = await fetch('/api/auth/access-log?limit=100');
      if (res.ok) {
        const data = await res.json();
        setAccessLogs(data.logs || []);
      }
    } catch {}
    setLoadingLogs(false);
  }, []);

  useEffect(() => {
    fetchUsers();
    fetchLogs();
  }, [fetchUsers, fetchLogs]);

  async function handleInvite(e) {
    e.preventDefault();
    if (!inviteEmail.trim() || !invitePassword) return;
    if (invitePassword.length < 6) {
      setInviteError('Password must be at least 6 characters.');
      return;
    }
    setInviteLoading(true);
    setInviteError('');
    const classScopes = inviteClassScopes
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);

    if (inviteRole === 'teacher' && classScopes.length === 0) {
      setInviteError('Teacher role requires at least one class scope (e.g. 4C).');
      setInviteLoading(false);
      return;
    }

    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: inviteEmail.trim(),
          name: inviteName.trim(),
          password: invitePassword,
          role: inviteRole,
          classScopes,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setShowInvite(false);
        setInviteEmail('');
        setInviteName('');
        setInvitePassword('');
        setInviteRole('viewer');
        setInviteClassScopes('');
        fetchUsers();
      } else {
        setInviteError(data.error || 'Failed to add user.');
      }
    } catch {
      setInviteError('Network error. Please try again.');
    }
    setInviteLoading(false);
  }

  async function handleDelete(email) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setDeleteConfirm(null);
        fetchUsers();
      }
    } catch {}
  }

  async function handleUserAction(email, action) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ email, action }),
      });
      if (res.ok) {
        setActionConfirm(null);
        fetchUsers();
      }
    } catch {}
  }

  async function handleAddTeacher(e) {
    e.preventDefault();
    if (!addTeacherEmail.trim() || !addTeacherPassword) return;
    if (addTeacherPassword.length < 6) {
      setAddTeacherError('Password must be at least 6 characters.');
      return;
    }
    const classScopes = addTeacherClassScopes
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    if (classScopes.length === 0) {
      setAddTeacherError('At least one class scope is required (e.g. 4C).');
      return;
    }
    setAddTeacherLoading(true);
    setAddTeacherError('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: addTeacherEmail.trim(),
          name: addTeacherName.trim(),
          password: addTeacherPassword,
          role: 'teacher',
          classScopes,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setAddTeacherOpen(false);
        setAddTeacherEmail('');
        setAddTeacherName('');
        setAddTeacherPassword('');
        setAddTeacherClassScopes('');
        fetchUsers();
      } else {
        setAddTeacherError(data.error || 'Failed to add teacher.');
      }
    } catch {
      setAddTeacherError('Network error. Please try again.');
    }
    setAddTeacherLoading(false);
  }

  async function handleResetPassword(email) {
    if (!resetPasswordValue || resetPasswordValue.length < 6) {
      setResetPasswordError('Password must be at least 6 characters.');
      return;
    }
    setResetPasswordLoading(true);
    setResetPasswordError('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ email, action: 'reset-password', newPassword: resetPasswordValue }),
      });
      const data = await res.json();
      if (res.ok) {
        setResetPasswordFor(null);
        setResetPasswordValue('');
        setResetPasswordSuccess(email);
        setTimeout(() => setResetPasswordSuccess(null), 3000);
      } else {
        setResetPasswordError(data.error || 'Failed to reset password.');
      }
    } catch {
      setResetPasswordError('Network error.');
    }
    setResetPasswordLoading(false);
  }

  async function handleUpdateClassScopes(email) {
    setEditClassScopesSaving(true);
    const scopes = editClassScopesValue
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ email, classScopes: scopes }),
      });
      if (res.ok) {
        setEditClassScopesFor(null);
        setEditClassScopesValue('');
        fetchUsers();
      }
    } catch {}
    setEditClassScopesSaving(false);
  }

  // ── Bulk import helpers ──────────────────────────────────────────────────

  function downloadTemplate(type) {
    const isTeacher = type === 'teachers';
    const header = 'email,name,password,role,classScopes';
    const sample = isTeacher
      ? `teacher.example@binus.edu,Ms. Example,Pass@123,teacher,"4C,5A"`
      : `user@school.edu,John Doe,Pass@123,viewer,`;
    const csv = `${header}\n${sample}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isTeacher ? 'teacher-import-template.csv' : 'user-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleBulkImportFile(e, target) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target.result;
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) { setBulkImportError('CSV must have a header row and at least one data row.'); return; }
        const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
        const emailIdx = header.indexOf('email');
        const nameIdx = header.indexOf('name');
        const passIdx = header.indexOf('password');
        const roleIdx = header.indexOf('role');
        const scopesIdx = header.indexOf('classscopes');
        if (emailIdx === -1 || passIdx === -1) {
          setBulkImportError('CSV must have at least "email" and "password" columns.');
          return;
        }
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          const cells = parseCSVLine(lines[i]);
          if (!cells[emailIdx]?.trim()) continue;
          // Force role to 'teacher' when importing into teacher tab
          const rawRole = roleIdx >= 0 ? cells[roleIdx]?.trim() : '';
          const role = target === 'teachers' ? 'teacher' : (rawRole || 'viewer');
          const scopesRaw = scopesIdx >= 0 ? (cells[scopesIdx] || '') : '';
          const classScopes = scopesRaw.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
          rows.push({
            email: cells[emailIdx]?.trim() || '',
            name: nameIdx >= 0 ? cells[nameIdx]?.trim() : '',
            password: cells[passIdx]?.trim() || '',
            role,
            classScopes,
          });
        }
        if (rows.length === 0) { setBulkImportError('No data rows found in CSV.'); return; }
        if (rows.length > 50) { setBulkImportError('Max 50 rows per import. Please split your file.'); return; }
        setBulkImportError('');
        setBulkImportResults(null);
        setBulkImportRows(rows);
        setBulkImportTarget(target);
      } catch {
        setBulkImportError('Failed to parse CSV. Ensure it is a valid UTF-8 comma-separated file.');
      }
    };
    reader.readAsText(file, 'utf-8');
    // Reset input so same file can be re-selected after fix
    e.target.value = '';
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

  async function handleBulkImportConfirm() {
    if (!bulkImportRows.length) return;
    setBulkImportLoading(true);
    setBulkImportError('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/bulk-import', {
        method: 'POST',
        headers,
        body: JSON.stringify({ users: bulkImportRows }),
      });
      const data = await res.json();
      if (!res.ok) { setBulkImportError(data.error || 'Import failed.'); return; }
      setBulkImportResults(data);
      setBulkImportRows([]);
      fetchUsers();
    } catch { setBulkImportError('Network error. Please try again.'); }
    setBulkImportLoading(false);
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

  function togglePermAction(feature, action) {
    setEditingPerms(prev => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [feature]: {
          ...prev.permissions[feature],
          [action]: !prev.permissions?.[feature]?.[action],
        },
      },
    }));
  }

  function toggleAllFeatureActions(feature) {
    const meta = FEATURES[feature];
    if (!meta) return;
    const current = editingPerms.permissions[feature] || {};
    const allEnabled = meta.actions.every(a => current[a]);
    setEditingPerms(prev => ({
      ...prev,
      permissions: {
        ...prev.permissions,
        [feature]: Object.fromEntries(meta.actions.map(a => [a, !allEnabled])),
      },
    }));
  }

  function changeEditRole(newRole) {
    // When role changes, reset permissions to that role's defaults
    const newPerms = resolvePermissions(newRole);
    setEditingPerms(prev => ({
      ...prev,
      role: newRole,
      classScopes: newRole === 'teacher' ? prev.classScopes : [],
      permissions: newPerms,
    }));
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
      if (res.ok) {
        setEditingPerms(null);
        fetchUsers();
      }
    } catch {}
    setSavingPerms(false);
  }

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

  const isAdmin = ['owner', 'admin'].includes(role);

  const allTabs = [
    { id: 'security', icon: 'ph-shield-check', label: 'Security & Audit' },
    { id: 'user-management', icon: 'ph-users', label: 'User Management' },
    { id: 'teacher-management', icon: 'ph-chalkboard-teacher', label: 'Teacher Management' },
    { id: 'ai-parameters', icon: 'ph-bounding-box', label: 'AI Parameters' },
    { id: 'notifications', icon: 'ph-bell-ringing', label: 'Notifications' },
    { id: 'integrations', icon: 'ph-plugs', label: 'Integrations' },
  ];

  const allowedTabIds = useMemo(() => getAllowedSettingsTabs(permissions || {}), [permissions]);
  const tabs = useMemo(() => allTabs.filter(t => allowedTabIds.includes(t.id)), [allowedTabIds]);

  // Set default active tab to first allowed tab
  useEffect(() => {
    if (tabs.length > 0 && !tabs.find(t => t.id === activeTab)) {
      setActiveTab(tabs[0].id);
    }
  }, [tabs, activeTab]);

  // Deep-link: ?tab=user-management etc.
  useEffect(() => {
    const { tab } = router.query;
    if (tab && tabs.find(t => t.id === tab)) {
      setActiveTab(tab);
    }
  }, [router.query, tabs]);

    return (
    <V2Layout>
        <Head><title>Settings — BINUS Attendance</title></Head>

    {/* Main Content */}
    <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1600px] mx-auto">
        
        {/* Hero Section */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
            <div>
                <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">System Settings</h1>
                <p className="text-slate-400 mt-2 max-w-2xl">Configure access control, monitor security events, and manage system integrations.</p>
            </div>
            {user && (
              <div className="flex items-center gap-3 glass-panel rounded-lg border border-slate-800 px-4 py-2">
                {user.photoURL && <img src={user.photoURL} alt="" className="w-7 h-7 rounded-full" referrerPolicy="no-referrer" />}
                <div className="text-sm">
                  <div className="text-white font-medium">{user.displayName}</div>
                  <div className="text-slate-500 text-xs">{role}</div>
                </div>
              </div>
            )}
        </div>

        {/* Layout Grid for Settings */}
        <div className="flex flex-col lg:flex-row gap-6">
            
            {/* Left Sidebar Navigation — horizontal on small, vertical on large */}
            <aside className="w-full lg:w-52 flex-shrink-0">
                <nav className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
                    {tabs.map(tab => (
                      <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl transition-colors text-left whitespace-nowrap ${
                          activeTab === tab.id
                            ? 'bg-white/5 text-brand-400 border border-slate-700/50'
                            : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                        }`}>
                        <i className={`ph ${tab.icon} text-lg`}></i>
                        <span className="font-medium text-sm">{tab.label}</span>
                      </button>
                    ))}
                </nav>
            </aside>

            {/* Right Content Area */}
            <div className="flex-1 min-w-0 space-y-8 pb-12">

                {/* ─── Security & Audit Tab ─── */}
                {activeTab === 'security' && (
                  <div className="space-y-6">
                    {/* Stats row */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="glass-panel rounded-xl border border-slate-800 p-5">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-9 h-9 rounded-lg bg-brand-500/10 flex items-center justify-center">
                            <i className="ph ph-users text-brand-400 text-lg"></i>
                          </div>
                          <span className="text-2xl font-bold text-white">{users.length}</span>
                        </div>
                        <p className="text-xs text-slate-400">Authorized Users</p>
                      </div>
                      <div className="glass-panel rounded-xl border border-slate-800 p-5">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                            <i className="ph ph-sign-in text-emerald-400 text-lg"></i>
                          </div>
                          <span className="text-2xl font-bold text-white">{accessLogs.length}</span>
                        </div>
                        <p className="text-xs text-slate-400">Total Access Events</p>
                      </div>
                      <div className="glass-panel rounded-xl border border-slate-800 p-5">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                            <i className="ph ph-devices text-amber-400 text-lg"></i>
                          </div>
                          <span className="text-2xl font-bold text-white">
                            {new Set(accessLogs.map(l => `${l.ip}-${l.browser}`)).size}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400">Unique Devices</p>
                      </div>
                    </div>

                    {/* Access Logs Table */}
                    <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                      <div className="px-5 py-4 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between">
                        <div>
                          <h2 className="text-lg font-semibold text-white">Access Log</h2>
                          <p className="text-sm text-slate-400 mt-1">Recent dashboard sign-in events with device & IP information.</p>
                        </div>
                        <button onClick={fetchLogs} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors">
                          <i className="ph ph-arrow-clockwise mr-1"></i> Refresh
                        </button>
                      </div>

                      {/* Filter bar */}
                      <div className="px-5 py-3 border-b border-slate-800/50 bg-slate-950/30">
                        <div className="relative max-w-sm">
                          <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"></i>
                          <input
                            type="text"
                            value={logFilter}
                            onChange={e => setLogFilter(e.target.value)}
                            placeholder="Filter by IP, user, browser, OS..."
                            className="w-full bg-slate-900/50 border border-slate-700/50 rounded-lg py-2 pl-9 pr-8 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
                          />
                          {logFilter && (
                            <button onClick={() => setLogFilter('')}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors">
                              <i className="ph ph-x text-sm"></i>
                            </button>
                          )}
                        </div>
                        {logFilter && (
                          <p className="text-[10px] text-slate-500 mt-1.5">{filteredLogs.length} of {accessLogs.length} entries</p>
                        )}
                      </div>

                      {loadingLogs ? (
                        <div className="p-12 text-center"><div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                      ) : accessLogs.length === 0 ? (
                        <div className="p-12 text-center text-slate-500">No access logs yet. Logs are recorded on each sign-in.</div>
                      ) : filteredLogs.length === 0 ? (
                        <div className="p-12 text-center text-slate-500">No logs match &ldquo;{logFilter}&rdquo;</div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left whitespace-nowrap text-sm">
                            <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800 text-[10px] uppercase tracking-wider font-semibold">
                              <tr>
                                <th className="px-4 py-3">User</th>
                                <th className="px-4 py-3">IP Address</th>
                                <th className="px-4 py-3">Device</th>
                                <th className="px-4 py-3">Browser</th>
                                <th className="px-4 py-3">OS</th>
                                <th className="px-4 py-3">Time</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/50">
                              {filteredLogs.map((log) => (
                                <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                                  <td className="px-4 py-2.5">
                                    <div className="font-medium text-white text-xs">{log.name}</div>
                                    <div className="text-[10px] text-slate-500">{log.email}</div>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <code className="text-[11px] font-mono text-slate-300 bg-slate-800/50 px-1.5 py-0.5 rounded">{log.ip}</code>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    <span className={`inline-flex items-center gap-1 text-xs ${
                                      log.device === 'Mobile' ? 'text-amber-400' :
                                      log.device === 'Tablet' ? 'text-indigo-400' : 'text-slate-300'
                                    }`}>
                                      <i className={`ph ${log.device === 'Mobile' ? 'ph-device-mobile' : log.device === 'Tablet' ? 'ph-device-tablet' : 'ph-desktop'}`}></i>
                                      {log.device}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 text-xs text-slate-300">{log.browser}</td>
                                  <td className="px-4 py-2.5 text-xs text-slate-400">{log.os}</td>
                                  <td className="px-4 py-2.5 text-xs text-slate-400">{timeAgo(log.timestamp)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ─── User Management Tab ─── */}
                {activeTab === 'user-management' && (
                  <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden shadow-lg shadow-black/20">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold text-white">Access Management</h2>
                        <p className="text-sm text-slate-400 mt-1">Manage who can sign in to this dashboard.</p>
                      </div>
                      {isAdmin && (
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-all border border-slate-700 cursor-pointer">
                            <i className="ph ph-file-csv text-lg text-emerald-400"></i>
                            Import CSV
                            <input type="file" accept=".csv" className="hidden" onChange={(e) => handleBulkImportFile(e, 'users')} />
                          </label>
                          <button onClick={() => downloadTemplate('users')}
                            className="flex items-center gap-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm border border-slate-700" title="Download CSV template">
                            <i className="ph ph-download-simple"></i>
                          </button>
                          <button onClick={() => setShowInvite(true)}
                            className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-all border border-slate-700">
                            <i className="ph ph-user-plus text-lg text-brand-400"></i>
                            Add User
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Teacher accounts callout */}
                    <div className="mx-6 mt-5 mb-1 flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-emerald-400">
                      <i className="ph ph-chalkboard-teacher text-lg flex-shrink-0"></i>
                      <p className="text-xs">Teacher accounts are managed in the <button onClick={() => setActiveTab('teacher-management')} className="font-semibold underline hover:text-emerald-300 transition-colors">Teacher Management</button> tab.</p>
                    </div>

                    {/* Invite modal */}
                    {showInvite && (
                      <div className="border-b border-slate-800 bg-slate-900/60 p-6">
                        <form onSubmit={handleInvite} className="max-w-lg space-y-4">
                          <h3 className="text-sm font-semibold text-white">Add Authorized User</h3>
                          {inviteError && (
                            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{inviteError}</div>
                          )}
                          <div>
                            <label className="text-xs text-slate-400 block mb-1">Email Address</label>
                            <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                              placeholder="user@binus.edu" required
                              className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
                          </div>
                          <div>
                            <label className="text-xs text-slate-400 block mb-1">Password</label>
                            <input type="password" value={invitePassword} onChange={e => setInvitePassword(e.target.value)}
                              placeholder="Min. 6 characters" required minLength={6}
                              className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500" />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="text-xs text-slate-400 block mb-1">Display Name (optional)</label>
                              <input type="text" value={inviteName} onChange={e => setInviteName(e.target.value)}
                                placeholder="John Doe"
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-brand-500" />
                            </div>
                            <div>
                              <label className="text-xs text-slate-400 block mb-1">Role</label>
                              <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white appearance-none focus:outline-none focus:border-brand-500 cursor-pointer">
                                <option value="viewer">Viewer</option>
                                <option value="guard">Guard (PickupGuard)</option>
                                <option value="teacher">Teacher</option>
                                <option value="admin">Admin</option>
                                {role === 'owner' && <option value="owner">Owner</option>}
                              </select>
                            </div>
                          </div>
                          {inviteRole === 'teacher' && (
                            <div>
                              <label className="text-xs text-slate-400 block mb-1">Class Scopes</label>
                              <input type="text" value={inviteClassScopes} onChange={e => setInviteClassScopes(e.target.value)}
                                placeholder="4C, 4B"
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-brand-500" />
                              <p className="text-[10px] text-slate-500 mt-1">Comma-separated classes this teacher can validate.</p>
                            </div>
                          )}
                          <div className="flex items-center gap-3 pt-2">
                            <button type="submit" disabled={inviteLoading}
                              className="px-5 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all disabled:opacity-50">
                              {inviteLoading ? 'Adding...' : 'Add User'}
                            </button>
                            <button type="button" onClick={() => { setShowInvite(false); setInviteError(''); }}
                              className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors">Cancel</button>
                          </div>
                        </form>
                      </div>
                    )}

                    {/* Bulk import preview panel (users) */}
                    {bulkImportTarget === 'users' && bulkImportRows.length > 0 && (
                      <BulkImportPreview
                        rows={bulkImportRows}
                        loading={bulkImportLoading}
                        error={bulkImportError}
                        results={bulkImportResults}
                        onConfirm={handleBulkImportConfirm}
                        onDismiss={() => { setBulkImportTarget(null); setBulkImportRows([]); setBulkImportResults(null); setBulkImportError(''); }}
                      />
                    )}
                    {bulkImportTarget === 'users' && bulkImportResults && (
                      <BulkImportResults
                        results={bulkImportResults}
                        onDismiss={() => { setBulkImportTarget(null); setBulkImportResults(null); }}
                      />
                    )}
                    {bulkImportError && bulkImportTarget === 'users' && bulkImportRows.length === 0 && (
                      <div className="mx-6 my-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
                        <i className="ph ph-warning mr-2"></i>{bulkImportError}
                      </div>
                    )}

                    {loadingUsers ? (
                      <div className="p-12 text-center"><div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left whitespace-nowrap text-sm border-collapse">
                          <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800 text-[10px] uppercase tracking-wider font-semibold">
                            <tr>
                              <th className="px-4 py-3">User</th>
                              <th className="px-4 py-3">Role</th>
                              <th className="px-4 py-3">Status</th>
                              {isAdmin && <th className="px-4 py-3">IP</th>}
                              <th className="px-4 py-3">Last Active</th>
                              {isAdmin && <th className="px-4 py-3 text-right">Actions</th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/50">
                            {users.filter(u => u.role !== 'teacher').map((u) => {
                              const isMe = u.email === user?.email?.toLowerCase();
                              return (
                                <tr key={u.email} className="hover:bg-slate-800/30 transition-colors group">
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2.5">
                                      {u.photoURL ? (
                                        <img src={u.photoURL} alt="" className="w-7 h-7 rounded-full border border-slate-700" referrerPolicy="no-referrer" />
                                      ) : (
                                        <div className="w-7 h-7 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center font-bold border border-brand-500/30 text-[10px]">
                                          {(u.name || u.email).slice(0, 2).toUpperCase()}
                                        </div>
                                      )}
                                      <div>
                                        <div className="font-medium text-white text-sm">{u.name}{isMe ? ' (You)' : ''}</div>
                                        <div className="text-[10px] text-slate-500">{u.email}</div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] uppercase font-bold border ${
                                        u.role === 'owner' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                                        u.role === 'admin' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' :
                                        u.role === 'teacher' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                                        'bg-slate-500/10 text-slate-400 border-slate-500/20'
                                      }`}>{u.role}</span>
                                      {u.superAdmin && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] uppercase font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                                          <i className="ph ph-crown text-xs"></i> Super
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] uppercase font-bold ${
                                      u.disabled ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
                                      u.lastLogin ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-500/10 text-slate-500 border border-slate-600/20'
                                    }`}>
                                      {u.disabled ? 'Suspended' : u.lastLogin ? 'Active' : 'Invited'}
                                    </span>
                                  </td>
                                  {isAdmin && (
                                    <td className="px-4 py-3">
                                      {u.lastIP ? (
                                        <code className="text-[11px] font-mono text-slate-400 bg-slate-800/50 px-1.5 py-0.5 rounded">{u.lastIP}</code>
                                      ) : (
                                        <span className="text-xs text-slate-600">—</span>
                                      )}
                                    </td>
                                  )}
                                  <td className="px-4 py-3 text-slate-400 text-xs">{u.lastLogin ? timeAgo(u.lastLogin) : 'Never'}</td>
                                  {isAdmin && (
                                    <td className="px-4 py-3 text-right">
                                      {!isMe && !u.superAdmin ? (
                                        <div className="flex items-center gap-1.5 justify-end flex-wrap">
                                          <button onClick={() => openPermEditor(u)}
                                            title="Edit permissions"
                                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 hover:text-brand-400 border border-slate-700/50 rounded-lg hover:bg-brand-500/5 hover:border-brand-500/30 transition-all">
                                            <i className="ph ph-sliders-horizontal text-xs"></i>
                                            Permissions
                                          </button>

                                          {/* Suspend / Unsuspend */}
                                          {actionConfirm?.email === u.email && actionConfirm?.action === 'suspend' ? (
                                            <div className="flex items-center gap-1.5">
                                              <button onClick={() => handleUserAction(u.email, 'suspend')}
                                                className="px-2.5 py-1.5 text-[10px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg hover:bg-amber-500/20">Confirm</button>
                                              <button onClick={() => setActionConfirm(null)}
                                                className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                            </div>
                                          ) : actionConfirm?.email === u.email && actionConfirm?.action === 'unsuspend' ? (
                                            <div className="flex items-center gap-1.5">
                                              <button onClick={() => handleUserAction(u.email, 'unsuspend')}
                                                className="px-2.5 py-1.5 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/20">Confirm</button>
                                              <button onClick={() => setActionConfirm(null)}
                                                className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                            </div>
                                          ) : u.disabled ? (
                                            <button onClick={() => setActionConfirm({ email: u.email, action: 'unsuspend' })}
                                              title="Unsuspend user"
                                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/10 transition-all">
                                              <i className="ph ph-play text-xs"></i>
                                              Activate
                                            </button>
                                          ) : (
                                            <button onClick={() => setActionConfirm({ email: u.email, action: 'suspend' })}
                                              title="Suspend user"
                                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20 rounded-lg hover:bg-amber-500/10 transition-all">
                                              <i className="ph ph-pause text-xs"></i>
                                              Suspend
                                            </button>
                                          )}

                                          {/* Revoke */}
                                          {actionConfirm?.email === u.email && actionConfirm?.action === 'revoke' ? (
                                            <div className="flex items-center gap-1.5">
                                              <button onClick={() => handleUserAction(u.email, 'revoke')}
                                                className="px-2.5 py-1.5 text-[10px] font-semibold text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg hover:bg-orange-500/20">Confirm</button>
                                              <button onClick={() => setActionConfirm(null)}
                                                className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                            </div>
                                          ) : (
                                            <button onClick={() => setActionConfirm({ email: u.email, action: 'revoke' })}
                                              title="Revoke all permissions (reset to viewer)"
                                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-orange-400 border border-orange-500/20 rounded-lg hover:bg-orange-500/10 transition-all">
                                              <i className="ph ph-prohibit text-xs"></i>
                                              Revoke
                                            </button>
                                          )}

                                          {/* Delete */}
                                          {deleteConfirm === u.email ? (
                                            <div className="flex items-center gap-1.5">
                                              <button onClick={() => handleDelete(u.email)}
                                                className="px-2.5 py-1.5 text-[10px] font-semibold text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg hover:bg-red-500/20">Confirm</button>
                                              <button onClick={() => setDeleteConfirm(null)}
                                                className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                            </div>
                                          ) : (
                                            <button onClick={() => setDeleteConfirm(u.email)}
                                              title="Delete user permanently"
                                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/10 transition-all">
                                              <i className="ph ph-trash text-xs"></i>
                                              Delete
                                            </button>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-xs text-slate-600">—</span>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* ── Permission Editor Panel ─── */}
                    {editingPerms && (
                      <div className="border-t border-slate-800 bg-slate-900/60 p-6 space-y-6 animate-fade-in-up">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                              <i className="ph ph-sliders-horizontal text-brand-400"></i>
                              Permissions for {editingPerms.name || editingPerms.email}
                            </h3>
                            <p className="text-xs text-slate-400 mt-1">Toggle features and actions this user can access.</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <select value={editingPerms.role} onChange={e => changeEditRole(e.target.value)}
                              className="bg-slate-950/50 border border-slate-700 rounded-lg py-1.5 px-3 text-xs text-white focus:outline-none focus:border-brand-500 cursor-pointer">
                              <option value="viewer">Viewer</option>
                              <option value="teacher">Teacher</option>
                              <option value="admin">Admin</option>
                              <option value="owner">Owner</option>
                            </select>
                            {editingPerms.role === 'teacher' && (
                              <input
                                type="text"
                                value={(editingPerms.classScopes || []).join(', ')}
                                onChange={(e) => {
                                  const arr = e.target.value
                                    .split(',')
                                    .map((x) => x.trim().toUpperCase())
                                    .filter(Boolean);
                                  setEditingPerms(prev => ({ ...prev, classScopes: [...new Set(arr)] }));
                                }}
                                placeholder="Class scopes, e.g. 4C, 4B"
                                className="bg-slate-950/50 border border-slate-700 rounded-lg py-1.5 px-3 text-xs text-white focus:outline-none focus:border-brand-500"
                              />
                            )}
                            <button onClick={() => setEditingPerms(null)} className="text-slate-500 hover:text-white transition-colors">
                              <i className="ph ph-x text-lg"></i>
                            </button>
                          </div>
                        </div>

                        {FEATURE_GROUPS.map(group => (
                          <div key={group.label}>
                            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-3">{group.label}</p>
                            <div className="space-y-1">
                              {group.features.map(featureKey => {
                                const meta = FEATURES[featureKey];
                                if (!meta) return null;
                                const perms = editingPerms.permissions[featureKey] || {};
                                const allOn = meta.actions.every(a => perms[a]);
                                const someOn = meta.actions.some(a => perms[a]);

                                return (
                                  <div key={featureKey}
                                    className="flex items-center gap-4 px-4 py-2.5 rounded-xl border border-slate-800/50 hover:bg-white/[0.02] transition-colors">
                                    {/* Feature toggle */}
                                    <button onClick={() => toggleAllFeatureActions(featureKey)}
                                      className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                                        allOn ? 'bg-brand-500 border-brand-500' :
                                        someOn ? 'bg-brand-500/30 border-brand-500/50' :
                                        'bg-slate-900 border-slate-700 hover:border-slate-500'
                                      }`}>
                                      {allOn && <i className="ph ph-check text-xs text-white font-bold"></i>}
                                      {someOn && !allOn && <i className="ph ph-minus text-xs text-white font-bold"></i>}
                                    </button>

                                    {/* Feature info */}
                                    <div className="flex items-center gap-2 min-w-[180px]">
                                      <i className={`ph ${meta.icon} text-base ${someOn ? 'text-slate-200' : 'text-slate-600'}`}></i>
                                      <span className={`text-sm font-medium ${someOn ? 'text-white' : 'text-slate-500'}`}>{meta.label}</span>
                                    </div>

                                    {/* Action toggles */}
                                    <div className="flex items-center gap-2 ml-auto">
                                      {meta.actions.map(action => (
                                        <button key={action} onClick={() => togglePermAction(featureKey, action)}
                                          className={`px-3 py-1 rounded-lg text-[10px] uppercase font-bold tracking-wider border transition-all ${
                                            perms[action]
                                              ? action === 'delete' ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20'
                                                : action === 'edit' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
                                                : action === 'export' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/20'
                                                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                                              : 'bg-slate-950/50 text-slate-600 border-slate-800 hover:border-slate-600 hover:text-slate-400'
                                          }`}>
                                          {action}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}

                        <div className="flex items-center gap-3 pt-2 border-t border-slate-800">
                          <button onClick={savePermissions} disabled={savingPerms}
                            className="px-5 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all disabled:opacity-50">
                            {savingPerms ? 'Saving...' : 'Save Permissions'}
                          </button>
                          <button onClick={() => setEditingPerms(null)}
                            className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* ─── Teacher Management Tab ─── */}
                {activeTab === 'teacher-management' && (
                  <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden shadow-lg shadow-black/20">

                    {/* Header */}
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                          <i className="ph ph-chalkboard-teacher text-emerald-400"></i>
                          Teacher Management
                        </h2>
                        <p className="text-sm text-slate-400 mt-1">Manage teacher accounts, class assignments, and credentials.</p>
                      </div>
                      {isAdmin && (
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-all border border-slate-700 cursor-pointer">
                            <i className="ph ph-file-csv text-lg text-emerald-400"></i>
                            Import CSV
                            <input type="file" accept=".csv" className="hidden" onChange={(e) => handleBulkImportFile(e, 'teachers')} />
                          </label>
                          <button onClick={() => downloadTemplate('teachers')}
                            className="flex items-center gap-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm border border-slate-700" title="Download CSV template">
                            <i className="ph ph-download-simple"></i>
                          </button>
                          <button onClick={() => { setAddTeacherOpen(true); setAddTeacherError(''); }}
                            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-all">
                            <i className="ph ph-user-plus text-lg"></i>
                            Add Teacher
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Add Teacher inline form */}
                    {addTeacherOpen && (
                      <div className="border-b border-slate-800 bg-slate-900/60 p-6">
                        <form onSubmit={handleAddTeacher} className="max-w-lg space-y-4">
                          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                            <i className="ph ph-chalkboard-teacher text-emerald-400"></i>
                            New Teacher Account
                          </h3>
                          {addTeacherError && (
                            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{addTeacherError}</div>
                          )}
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="text-xs text-slate-400 block mb-1">Email Address</label>
                              <input type="email" value={addTeacherEmail} onChange={e => setAddTeacherEmail(e.target.value)}
                                placeholder="teacher@binus.edu" required
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                            </div>
                            <div>
                              <label className="text-xs text-slate-400 block mb-1">Display Name (optional)</label>
                              <input type="text" value={addTeacherName} onChange={e => setAddTeacherName(e.target.value)}
                                placeholder="Ms. Anita"
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-emerald-500" />
                            </div>
                          </div>
                          <div>
                            <label className="text-xs text-slate-400 block mb-1">Password</label>
                            <input type="password" value={addTeacherPassword} onChange={e => setAddTeacherPassword(e.target.value)}
                              placeholder="Min. 6 characters" required minLength={6}
                              className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500" />
                          </div>
                          <div>
                            <label className="text-xs text-slate-400 block mb-1">Assigned Classes</label>
                            <input type="text" value={addTeacherClassScopes} onChange={e => setAddTeacherClassScopes(e.target.value)}
                              placeholder="4C, 4B" required
                              className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 px-4 text-sm text-white focus:outline-none focus:border-emerald-500" />
                            <p className="text-[10px] text-slate-500 mt-1">Comma-separated homeroom classes this teacher can validate pickups for.</p>
                          </div>
                          <div className="flex items-center gap-3 pt-2">
                            <button type="submit" disabled={addTeacherLoading}
                              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold transition-all disabled:opacity-50">
                              {addTeacherLoading ? 'Creating...' : 'Create Teacher Account'}
                            </button>
                            <button type="button" onClick={() => { setAddTeacherOpen(false); setAddTeacherError(''); }}
                              className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors">Cancel</button>
                          </div>
                        </form>
                      </div>
                    )}

                    {/* Bulk import preview panel (teachers) */}
                    {bulkImportTarget === 'teachers' && bulkImportRows.length > 0 && (
                      <BulkImportPreview
                        rows={bulkImportRows}
                        loading={bulkImportLoading}
                        error={bulkImportError}
                        results={bulkImportResults}
                        onConfirm={handleBulkImportConfirm}
                        onDismiss={() => { setBulkImportTarget(null); setBulkImportRows([]); setBulkImportResults(null); setBulkImportError(''); }}
                      />
                    )}
                    {bulkImportTarget === 'teachers' && bulkImportResults && !bulkImportRows.length && (
                      <BulkImportResults
                        results={bulkImportResults}
                        onDismiss={() => { setBulkImportTarget(null); setBulkImportResults(null); }}
                      />
                    )}
                    {bulkImportError && bulkImportTarget === 'teachers' && bulkImportRows.length === 0 && !bulkImportResults && (
                      <div className="mx-6 my-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
                        <i className="ph ph-warning mr-2"></i>{bulkImportError}
                      </div>
                    )}

                    {/* Search bar */}
                    <div className="px-6 py-3 border-b border-slate-800/50 bg-slate-950/30">
                      <div className="relative max-w-sm">
                        <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"></i>
                        <input type="text" value={teacherSearch} onChange={e => setTeacherSearch(e.target.value)}
                          placeholder="Search by name, email, or class..."
                          className="w-full bg-slate-900/50 border border-slate-700/50 rounded-lg py-2 pl-9 pr-8 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition-colors" />
                        {teacherSearch && (
                          <button onClick={() => setTeacherSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors">
                            <i className="ph ph-x text-sm"></i>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Password reset success toast */}
                    {resetPasswordSuccess && (
                      <div className="mx-6 mt-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
                        <i className="ph ph-check-circle text-base"></i>
                        Password reset successfully for {resetPasswordSuccess}
                      </div>
                    )}

                    {/* Teacher cards */}
                    {loadingUsers ? (
                      <div className="p-12 text-center"><div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                    ) : filteredTeachers.length === 0 ? (
                      <div className="p-16 text-center">
                        <i className="ph ph-chalkboard-teacher text-4xl text-slate-700 block mb-3"></i>
                        <p className="text-slate-400 font-medium">No teacher accounts yet</p>
                        <p className="text-slate-600 text-sm mt-1">Use &ldquo;Add Teacher&rdquo; to create the first teacher account.</p>
                      </div>
                    ) : (
                      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {filteredTeachers.map((t) => (
                          <div key={t.email} className="rounded-xl border border-slate-700/60 bg-slate-900/40 hover:bg-slate-900/70 transition-colors overflow-hidden">

                            {/* Card header: avatar + info + status */}
                            <div className="flex items-center gap-3 px-4 py-4">
                              <div className="w-10 h-10 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center font-bold border border-emerald-500/25 text-sm flex-shrink-0">
                                {(t.name || t.email).slice(0, 2).toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold text-white text-sm truncate">{t.name || '—'}</div>
                                <div className="text-[11px] text-slate-500 truncate">{t.email}</div>
                                <div className="text-[10px] text-slate-600 mt-0.5">Last active: {t.lastLogin ? timeAgo(t.lastLogin) : 'Never'}</div>
                              </div>
                              <span className={`flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] uppercase font-bold border ${
                                t.disabled
                                  ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                  : t.lastLogin
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                  : 'bg-slate-500/10 text-slate-400 border-slate-500/20'
                              }`}>
                                {t.disabled ? 'Suspended' : t.lastLogin ? 'Active' : 'Invited'}
                              </span>
                            </div>

                            {/* Class scopes row */}
                            <div className="px-4 pb-3">
                              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-2">Assigned Classes</div>
                              {editClassScopesFor === t.email ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="text"
                                    value={editClassScopesValue}
                                    onChange={e => setEditClassScopesValue(e.target.value)}
                                    placeholder="4C, 4B, 6A"
                                    autoFocus
                                    className="flex-1 bg-slate-800 border border-emerald-500/50 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-400"
                                  />
                                  <button
                                    onClick={() => handleUpdateClassScopes(t.email)}
                                    disabled={editClassScopesSaving}
                                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold disabled:opacity-50 transition-colors">
                                    {editClassScopesSaving ? '...' : 'Save'}
                                  </button>
                                  <button
                                    onClick={() => { setEditClassScopesFor(null); setEditClassScopesValue(''); }}
                                    className="px-2 py-1.5 text-slate-500 hover:text-white text-xs transition-colors">✕</button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 flex-wrap">
                                  {(t.classScopes || []).length > 0 ? (
                                    (t.classScopes || []).map(c => (
                                      <span key={c} className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/25">
                                        {c}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="text-xs text-slate-600 italic">No classes assigned</span>
                                  )}
                                  {isAdmin && (
                                    <button
                                      onClick={() => { setEditClassScopesFor(t.email); setEditClassScopesValue((t.classScopes || []).join(', ')); }}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] text-slate-500 hover:text-emerald-400 border border-transparent hover:border-emerald-500/20 transition-all">
                                      <i className="ph ph-pencil-simple text-xs"></i>Edit
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Password reset inline */}
                            {resetPasswordFor === t.email && (
                              <div className="mx-4 mb-3 p-3 rounded-lg bg-slate-800/80 border border-slate-700">
                                <div className="text-[11px] text-slate-400 font-medium mb-2">Set new password for {t.name || t.email}</div>
                                {resetPasswordError && (
                                  <div className="mb-2 text-[11px] text-red-400">{resetPasswordError}</div>
                                )}
                                <div className="flex items-center gap-2">
                                  <input
                                    type="password"
                                    value={resetPasswordValue}
                                    onChange={e => setResetPasswordValue(e.target.value)}
                                    placeholder="New password (min. 6 chars)"
                                    autoFocus
                                    className="flex-1 bg-slate-950/50 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand-500"
                                  />
                                  <button
                                    onClick={() => handleResetPassword(t.email)}
                                    disabled={resetPasswordLoading}
                                    className="px-3 py-1.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-xs font-semibold disabled:opacity-50 transition-colors">
                                    {resetPasswordLoading ? '...' : 'Reset'}
                                  </button>
                                  <button
                                    onClick={() => { setResetPasswordFor(null); setResetPasswordValue(''); setResetPasswordError(''); }}
                                    className="px-2 py-1.5 text-slate-500 hover:text-white text-xs transition-colors">✕</button>
                                </div>
                              </div>
                            )}

                            {/* Action buttons */}
                            {isAdmin && (
                              <div className="px-4 pb-4 flex items-center gap-1.5 flex-wrap border-t border-slate-800/60 pt-3">
                                {/* Reset password */}
                                <button
                                  onClick={() => {
                                    setResetPasswordFor(t.email);
                                    setResetPasswordValue('');
                                    setResetPasswordError('');
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-sky-400 border border-sky-500/20 rounded-lg hover:bg-sky-500/10 transition-all">
                                  <i className="ph ph-key text-xs"></i>
                                  Reset Password
                                </button>

                                {/* Suspend / Activate */}
                                {teacherActionConfirm?.email === t.email && teacherActionConfirm?.action === 'suspend' ? (
                                  <div className="flex items-center gap-1.5">
                                    <button onClick={() => { handleUserAction(t.email, 'suspend'); setTeacherActionConfirm(null); }}
                                      className="px-2.5 py-1.5 text-[10px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg hover:bg-amber-500/20">Confirm</button>
                                    <button onClick={() => setTeacherActionConfirm(null)} className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                  </div>
                                ) : teacherActionConfirm?.email === t.email && teacherActionConfirm?.action === 'unsuspend' ? (
                                  <div className="flex items-center gap-1.5">
                                    <button onClick={() => { handleUserAction(t.email, 'unsuspend'); setTeacherActionConfirm(null); }}
                                      className="px-2.5 py-1.5 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/20">Confirm</button>
                                    <button onClick={() => setTeacherActionConfirm(null)} className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                  </div>
                                ) : t.disabled ? (
                                  <button onClick={() => setTeacherActionConfirm({ email: t.email, action: 'unsuspend' })}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20 rounded-lg hover:bg-emerald-500/10 transition-all">
                                    <i className="ph ph-play text-xs"></i>Activate
                                  </button>
                                ) : (
                                  <button onClick={() => setTeacherActionConfirm({ email: t.email, action: 'suspend' })}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20 rounded-lg hover:bg-amber-500/10 transition-all">
                                    <i className="ph ph-pause text-xs"></i>Suspend
                                  </button>
                                )}

                                {/* Remove */}
                                {deleteConfirm === t.email ? (
                                  <div className="flex items-center gap-1.5">
                                    <button onClick={() => handleDelete(t.email)}
                                      className="px-2.5 py-1.5 text-[10px] font-semibold text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg hover:bg-red-500/20">Confirm</button>
                                    <button onClick={() => setDeleteConfirm(null)} className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                                  </div>
                                ) : (
                                  <button onClick={() => setDeleteConfirm(t.email)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/10 transition-all">
                                    <i className="ph ph-trash text-xs"></i>Remove
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* ─── AI Parameters Tab ─── */}
                {activeTab === 'ai-parameters' && (
                  <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40">
                        <h2 className="text-lg font-semibold text-white">Facial Recognition Engine</h2>
                        <p className="text-sm text-slate-400 mt-1">Adjust sensitivity, confidence thresholds, and processing modes.</p>
                    </div>
                    
                    <div className="p-6 space-y-8">
                        <div className="max-w-3xl">
                            <div className="flex items-center justify-between mb-2">
                                <div>
                                    <label className="text-sm font-medium text-white block">Match Confidence Threshold</label>
                                    <p className="text-xs text-slate-400 mt-1">Minimum AI confidence score required to automatically mark a student as present.</p>
                                </div>
                                <div className="px-3 py-1 bg-brand-500/10 border border-brand-500/20 text-brand-400 rounded-lg font-mono text-sm">90%</div>
                            </div>
                            <div className="relative pt-4">
                                <input type="range" min="50" max="100" defaultValue="90" className="w-full z-20 relative" />
                                <div className="flex justify-between text-[10px] text-slate-500 mt-2 font-mono">
                                    <span>50% (Lenient)</span><span>75%</span><span>100% (Strict)</span>
                                </div>
                            </div>
                        </div>

                        <hr className="border-slate-800" />

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
                            <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-slate-800 bg-slate-900/30 hover:bg-slate-800/50 transition-colors">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <i className="ph ph-face-mask text-amber-400"></i>
                                        <label className="text-sm font-medium text-white block">Liveness Detection</label>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">Active anti-spoofing mechanism to prevent bypass using 2D photos.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0 mt-1">
                                    <input type="checkbox" className="sr-only peer" defaultChecked />
                                    <div className="w-11 h-6 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-500"></div>
                                </label>
                            </div>
                            <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-slate-800 bg-slate-900/30 hover:bg-slate-800/50 transition-colors">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <i className="ph ph-users-three text-indigo-400"></i>
                                        <label className="text-sm font-medium text-white block">Crowd Processing</label>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">Enable multi-face tracking. May increase latency slightly.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0 mt-1">
                                    <input type="checkbox" className="sr-only peer" defaultChecked />
                                    <div className="w-11 h-6 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-500"></div>
                                </label>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-4xl">
                            <div>
                                <label className="text-sm font-medium text-white block mb-2">Processing Node Allocation</label>
                                <select className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 pl-4 pr-10 text-sm text-white appearance-none focus:outline-none focus:border-brand-500 cursor-pointer">
                                    <option value="hybrid">Hybrid (Edge + Cloud fallback)</option>
                                    <option value="edge">Edge Only (Lowest Latency)</option>
                                    <option value="cloud">Cloud Only (High Accuracy)</option>
                                </select>
                            </div>
                            <div>
                                <label className="text-sm font-medium text-white block mb-2">Data Retention Period</label>
                                <select className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 pl-4 pr-10 text-sm text-white appearance-none focus:outline-none focus:border-brand-500 cursor-pointer">
                                    <option value="30">30 Days (Compliance standard)</option>
                                    <option value="90">90 Days</option>
                                    <option value="365">1 Year</option>
                                </select>
                            </div>
                        </div>
                    </div>
                  </div>
                )}

                {/* ─── Notifications Tab ─── */}
                {activeTab === 'notifications' && (
                  <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40">
                        <h2 className="text-lg font-semibold text-white">System Notifications</h2>
                        <p className="text-sm text-slate-400 mt-1">Configure when and how alerts are dispatched.</p>
                    </div>
                    <div className="p-0">
                        <ul className="divide-y divide-slate-800/50">
                            <li className="p-6 flex items-start sm:items-center justify-between gap-4 hover:bg-slate-900/20 transition-colors">
                                <div>
                                    <p className="text-sm font-medium text-white">Manual Verification Required</p>
                                    <p className="text-xs text-slate-400 mt-1">Notify when a scan falls below confidence threshold.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" className="sr-only peer" defaultChecked />
                                    <div className="w-11 h-6 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-500"></div>
                                </label>
                            </li>
                            <li className="p-6 flex items-start sm:items-center justify-between gap-4 hover:bg-slate-900/20 transition-colors">
                                <div>
                                    <p className="text-sm font-medium text-white">Hardware / Node Failure</p>
                                    <p className="text-xs text-slate-400 mt-1">Immediate alerts if a camera or edge processor goes offline.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" className="sr-only peer" defaultChecked />
                                    <div className="w-11 h-6 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                                </label>
                            </li>
                            <li className="p-6 flex items-start sm:items-center justify-between gap-4 opacity-60">
                                <div>
                                    <p className="text-sm font-medium text-white">Daily Attendance Summary</p>
                                    <p className="text-xs text-slate-400 mt-1">Automated PDF report of campus-wide attendance stats.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-not-allowed">
                                    <input type="checkbox" className="sr-only peer" disabled />
                                    <div className="w-11 h-6 bg-slate-800 rounded-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-600 after:border-slate-500 after:border after:rounded-full after:h-5 after:w-5"></div>
                                </label>
                            </li>
                        </ul>
                    </div>
                  </div>
                )}

                {/* ─── Integrations Tab ─── */}
                {activeTab === 'integrations' && (
                  <div className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40">
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-white">External Integrations</h2>
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 uppercase tracking-wide">Beta</span>
                        </div>
                        <p className="text-sm text-slate-400 mt-1">Connect data directly to your institution&apos;s tech stack.</p>
                    </div>
                    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="border border-slate-700 rounded-xl p-5 bg-slate-900/50 flex flex-col justify-between group hover:border-brand-500/50 transition-colors">
                            <div>
                                <div className="w-10 h-10 rounded bg-slate-800 border border-slate-700 flex items-center justify-center mb-4">
                                    <i className="ph ph-database text-xl text-slate-300"></i>
                                </div>
                                <h3 className="text-white font-medium mb-1">Student Information System</h3>
                                <p className="text-xs text-slate-400">Sync rosters and write attendance records via BINUS API.</p>
                            </div>
                            <div className="mt-6 flex items-center justify-between">
                                <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div> Connected
                                </span>
                                <button className="text-xs font-medium text-slate-300 hover:text-white border border-slate-700 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 transition-colors">Manage</button>
                            </div>
                        </div>
                        <div className="border border-slate-800 rounded-xl p-5 bg-slate-950/30 flex flex-col justify-between group hover:border-slate-600 transition-colors">
                            <div>
                                <div className="w-10 h-10 rounded bg-[#E5E7EB] border border-slate-700 flex items-center justify-center mb-4">
                                    <i className="ph ph-chat-teardrop-dots text-xl text-slate-800"></i>
                                </div>
                                <h3 className="text-white font-medium mb-1">Slack Alerts</h3>
                                <p className="text-xs text-slate-400">Route critical security notifications to Slack channels.</p>
                            </div>
                            <div className="mt-6 flex items-center justify-between">
                                <span className="text-xs text-slate-500">Not configured</span>
                                <button className="text-xs font-medium text-slate-300 hover:text-white border border-slate-700 px-3 py-1.5 rounded bg-slate-900 hover:bg-slate-800 transition-colors">Configure</button>
                            </div>
                        </div>
                    </div>
                  </div>
                )}

            </div>
        </div>

    </div>

    {/* Footer */}
    <footer className="border-t border-slate-800/50 bg-slate-950/80 backdrop-blur-sm mt-8 py-6">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm">
                <i className="ph ph-shield-check text-brand-500 text-lg"></i>
                <span>BINUS Attendance System</span>
            </div>
            <div className="flex items-center gap-6 text-sm">
                <span className="text-slate-600">BINUS School Simprug</span>
            </div>
        </div>
    </footer>
    </V2Layout>
    );
}

// ── Bulk Import Components ────────────────────────────────────────────────────

function BulkImportPreview({ rows, loading, error, results, onConfirm, onDismiss }) {
  if (results) return null; // show BulkImportResults instead
  const ROLE_COLOR = {
    owner: 'text-red-300 bg-red-500/15 border-red-500/30',
    admin: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
    teacher: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30',
    guard: 'text-sky-300 bg-sky-500/15 border-sky-500/30',
    viewer: 'text-slate-300 bg-slate-500/15 border-slate-600/40',
  };
  return (
    <div className="border-b border-slate-800 bg-slate-900/50 px-6 py-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <i className="ph ph-file-csv text-emerald-400"></i>
            CSV Preview — {rows.length} row{rows.length !== 1 ? 's' : ''}
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">Review before importing. Duplicates and validation errors will be reported per row.</p>
        </div>
        <button onClick={onDismiss} className="text-slate-500 hover:text-white"><i className="ph ph-x"></i></button>
      </div>
      {error && (
        <div className="mb-3 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
          <i className="ph ph-warning mr-1"></i>{error}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-800 mb-4 max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-950/60 text-slate-400 uppercase tracking-wider text-[10px]">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Role</th>
              <th className="px-3 py-2 text-left">Classes</th>
              <th className="px-3 py-2 text-left">Password</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-white/5">
                <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                <td className="px-3 py-2 text-slate-200 font-mono">{r.email}</td>
                <td className="px-3 py-2 text-slate-300">{r.name || <span className="text-slate-600">—</span>}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${ROLE_COLOR[r.role] || ROLE_COLOR.viewer}`}>
                    {r.role}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-400">
                  {(r.classScopes || []).length > 0
                    ? r.classScopes.join(', ')
                    : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-3 py-2 text-slate-600 font-mono">{'•'.repeat(Math.min(r.password?.length || 0, 8))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={onConfirm} disabled={loading}
          className="px-5 py-2 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all disabled:opacity-50">
          {loading ? <><i className="ph ph-spinner-gap animate-spin mr-1"></i>Importing…</> : <><i className="ph ph-upload-simple mr-1"></i>Import {rows.length} users</>}
        </button>
        <button onClick={onDismiss} disabled={loading} className="px-4 py-2 text-slate-400 hover:text-white text-sm">Cancel</button>
      </div>
    </div>
  );
}

function BulkImportResults({ results, onDismiss }) {
  if (!results) return null;
  const { total, succeeded, failed } = results;
  return (
    <div className="border-b border-slate-800 bg-slate-900/50 px-6 py-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-3">
          {failed === 0 ? (
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <i className="ph ph-check-circle text-emerald-400 text-lg"></i>
            </div>
          ) : succeeded === 0 ? (
            <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
              <i className="ph ph-x-circle text-red-400 text-lg"></i>
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
              <i className="ph ph-warning text-amber-400 text-lg"></i>
            </div>
          )}
          <div>
            <p className="text-sm font-semibold text-white">Import complete</p>
            <p className="text-xs text-slate-400">
              {succeeded} of {total} imported successfully{failed > 0 ? `, ${failed} failed` : ''}
            </p>
          </div>
        </div>
        <button onClick={onDismiss} className="text-slate-500 hover:text-white"><i className="ph ph-x"></i></button>
      </div>
      {failed > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-800 max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-950/60 text-slate-400 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {results.results.map((r, i) => (
                <tr key={i} className={r.ok ? '' : 'bg-red-500/5'}>
                  <td className="px-3 py-2 text-slate-500">{r.row}</td>
                  <td className="px-3 py-2 text-slate-200 font-mono">{r.email}</td>
                  <td className="px-3 py-2">
                    {r.ok
                      ? <span className="text-emerald-400"><i className="ph ph-check-circle mr-1"></i>OK</span>
                      : <span className="text-red-300"><i className="ph ph-x-circle mr-1"></i>Failed</span>}
                  </td>
                  <td className="px-3 py-2 text-red-300">{r.error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
