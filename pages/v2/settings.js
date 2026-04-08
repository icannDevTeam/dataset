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
  const [inviteError, setInviteError] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [editingPerms, setEditingPerms] = useState(null); // { email, role, permissions }
  const [savingPerms, setSavingPerms] = useState(false);

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
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: inviteEmail.trim(), name: inviteName.trim(), password: invitePassword, role: inviteRole }),
      });
      const data = await res.json();
      if (res.ok) {
        setShowInvite(false);
        setInviteEmail('');
        setInviteName('');
        setInvitePassword('');
        setInviteRole('viewer');
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

  function openPermEditor(u) {
    setEditingPerms({
      email: u.email,
      name: u.name,
      role: u.role,
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
    setEditingPerms(prev => ({ ...prev, role: newRole, permissions: newPerms }));
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

    return (
    <V2Layout>
        <Head><title>Settings — BINUSFace</title></Head>

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
        <div className="flex flex-col lg:flex-row gap-8">
            
            {/* Left Sidebar Navigation */}
            <aside className="w-full lg:w-64 flex-shrink-0">
                <nav className="space-y-1">
                    {tabs.map(tab => (
                      <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors text-left ${
                          activeTab === tab.id
                            ? 'bg-white/5 text-brand-400 border border-slate-700/50'
                            : 'text-slate-400 hover:text-slate-100 hover:bg-white/5 border border-transparent'
                        }`}>
                        <i className={`ph ${tab.icon} text-xl`}></i>
                        <span className="font-medium text-sm">{tab.label}</span>
                      </button>
                    ))}
                </nav>
            </aside>

            {/* Right Content Area */}
            <div className="flex-1 space-y-8 pb-12">

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
                      <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between">
                        <div>
                          <h2 className="text-lg font-semibold text-white">Access Log</h2>
                          <p className="text-sm text-slate-400 mt-1">Recent dashboard sign-in events with device & IP information.</p>
                        </div>
                        <button onClick={fetchLogs} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors">
                          <i className="ph ph-arrow-clockwise mr-1"></i> Refresh
                        </button>
                      </div>

                      {loadingLogs ? (
                        <div className="p-12 text-center"><div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                      ) : accessLogs.length === 0 ? (
                        <div className="p-12 text-center text-slate-500">No access logs yet. Logs are recorded on each sign-in.</div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left whitespace-nowrap text-sm">
                            <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800 text-xs uppercase tracking-wider font-semibold">
                              <tr>
                                <th className="px-6 py-4">User</th>
                                <th className="px-6 py-4">IP Address</th>
                                <th className="px-6 py-4">Device</th>
                                <th className="px-6 py-4">Browser</th>
                                <th className="px-6 py-4">OS</th>
                                <th className="px-6 py-4">Time</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/50">
                              {accessLogs.map((log) => (
                                <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                                  <td className="px-6 py-3">
                                    <div className="font-medium text-white text-xs">{log.name}</div>
                                    <div className="text-[10px] text-slate-500">{log.email}</div>
                                  </td>
                                  <td className="px-6 py-3">
                                    <code className="text-xs font-mono text-slate-300 bg-slate-800/50 px-2 py-0.5 rounded">{log.ip}</code>
                                  </td>
                                  <td className="px-6 py-3">
                                    <span className={`inline-flex items-center gap-1.5 text-xs ${
                                      log.device === 'Mobile' ? 'text-amber-400' :
                                      log.device === 'Tablet' ? 'text-indigo-400' : 'text-slate-300'
                                    }`}>
                                      <i className={`ph ${log.device === 'Mobile' ? 'ph-device-mobile' : log.device === 'Tablet' ? 'ph-device-tablet' : 'ph-desktop'}`}></i>
                                      {log.device}
                                    </span>
                                  </td>
                                  <td className="px-6 py-3 text-xs text-slate-300">{log.browser}</td>
                                  <td className="px-6 py-3 text-xs text-slate-400">{log.os}</td>
                                  <td className="px-6 py-3 text-xs text-slate-400">{timeAgo(log.timestamp)}</td>
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
                        <button onClick={() => setShowInvite(true)}
                          className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-all border border-slate-700">
                          <i className="ph ph-user-plus text-lg text-brand-400"></i>
                          Add User
                        </button>
                      )}
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
                                <option value="admin">Admin</option>
                                {role === 'owner' && <option value="owner">Owner</option>}
                              </select>
                            </div>
                          </div>
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

                    {loadingUsers ? (
                      <div className="p-12 text-center"><div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left whitespace-nowrap text-sm border-collapse">
                          <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800 text-xs uppercase tracking-wider font-semibold">
                            <tr>
                              <th className="px-6 py-4">User</th>
                              <th className="px-6 py-4">Role</th>
                              <th className="px-6 py-4">Status</th>
                              <th className="px-6 py-4">Last Active</th>
                              {isAdmin && <th className="px-6 py-4 w-12"></th>}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/50">
                            {users.map((u) => {
                              const isMe = u.email === user?.email?.toLowerCase();
                              return (
                                <tr key={u.email} className="hover:bg-slate-800/30 transition-colors group">
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-3">
                                      {u.photoURL ? (
                                        <img src={u.photoURL} alt="" className="w-8 h-8 rounded-full border border-slate-700" referrerPolicy="no-referrer" />
                                      ) : (
                                        <div className="w-8 h-8 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center font-bold border border-brand-500/30 text-xs">
                                          {(u.name || u.email).slice(0, 2).toUpperCase()}
                                        </div>
                                      )}
                                      <div>
                                        <div className="font-medium text-white">{u.name}{isMe ? ' (You)' : ''}</div>
                                        <div className="text-xs text-slate-500 mt-0.5">{u.email}</div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-2">
                                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] uppercase font-bold border ${
                                        u.role === 'owner' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                                        u.role === 'admin' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' :
                                        'bg-slate-500/10 text-slate-400 border-slate-500/20'
                                      }`}>{u.role}</span>
                                      {u.superAdmin && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] uppercase font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                                          <i className="ph ph-crown text-xs"></i> Super
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase font-bold ${
                                      u.lastLogin ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-500/10 text-slate-500 border border-slate-600/20'
                                    }`}>
                                      {u.lastLogin ? 'Active' : 'Invited'}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4 text-slate-400 text-sm">{u.lastLogin ? timeAgo(u.lastLogin) : 'Never'}</td>
                                  {isAdmin && (
                                    <td className="px-6 py-4 text-right">
                                      {!isMe && !u.superAdmin && (
                                        <div className="flex items-center gap-2 justify-end">
                                          {role === 'owner' && (
                                            <button onClick={() => openPermEditor(u)}
                                              title="Edit permissions"
                                              className="text-xs text-slate-500 hover:text-brand-400 transition-colors opacity-0 group-hover:opacity-100">
                                              <i className="ph ph-sliders-horizontal text-base"></i>
                                            </button>
                                          )}
                                          {deleteConfirm === u.email ? (
                                            <div className="flex items-center gap-2">
                                              <button onClick={() => handleDelete(u.email)}
                                                className="text-xs font-medium text-red-400 hover:text-red-300">Confirm</button>
                                              <button onClick={() => setDeleteConfirm(null)}
                                                className="text-xs text-slate-500 hover:text-white">Cancel</button>
                                            </div>
                                          ) : (
                                            <button onClick={() => setDeleteConfirm(u.email)}
                                              className="text-xs text-slate-500 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">
                                              <i className="ph ph-trash text-base"></i>
                                            </button>
                                          )}
                                        </div>
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
                              <option value="admin">Admin</option>
                              <option value="owner">Owner</option>
                            </select>
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
                <span>BINUSFace Attendance System</span>
            </div>
            <div className="flex items-center gap-6 text-sm">
                <span className="text-slate-600">BINUS School Simprug</span>
            </div>
        </div>
    </footer>
    </V2Layout>
    );
}
