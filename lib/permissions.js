/**
 * RBAC Permissions — granular feature-level access control.
 *
 * Each feature has actions: view, edit, delete (not all features use all actions).
 * Roles provide default permissions; per-user overrides are stored in Firestore.
 *
 * Flow: role defaults → merge with user overrides → final permission set
 */

// ── All features and their possible actions ──────────────────────────
//
// Tab-level RBAC convention
// -------------------------
// Pages with internal module tabs expose `view_<module>` sub-actions in
// addition to the page-level `view`. Example: Reports has Facial Recognition
// / PickupGuard / Onboarding Forms tabs, gated by `reports.view_attendance`,
// `reports.view_pickup`, `reports.view_forms`. Admins can grant a user the
// page (`view`) while hiding specific tabs.
// The `subModules` array drives the RBAC editor drawer so each tab is a
// named toggle group instead of a flat list of actions.
export const FEATURES = {
  dashboard:          { label: 'Dashboard',           icon: 'ph-squares-four',       actions: ['view', 'view_attendance', 'view_pickup'], path: '/v2',
                        subModules: [
                          { key: 'attendance', label: 'Facial Recognition', icon: 'ph-user-focus',   actions: ['view_attendance'] },
                          { key: 'pickup',     label: 'PickupGuard',        icon: 'ph-hand-waving',  actions: ['view_pickup'] },
                        ] },
  analytics:          { label: 'Analytics',           icon: 'ph-chart-line-up',      actions: ['view', 'view_attendance', 'view_pickup', 'export', 'view_pii'],         path: '/v2/analytics',
                        subModules: [
                          { key: 'attendance', label: 'Facial Recognition', icon: 'ph-user-focus',   actions: ['view_attendance'] },
                          { key: 'pickup',     label: 'PickupGuard',        icon: 'ph-hand-waving',  actions: ['view_pickup'] },
                        ] },
  reports:            { label: 'Reports',             icon: 'ph-file-text',          actions: ['view', 'view_attendance', 'view_pickup', 'view_forms', 'export'],         path: '/v2/reports',
                        subModules: [
                          { key: 'attendance', label: 'Facial Recognition', icon: 'ph-user-focus',     actions: ['view_attendance'] },
                          { key: 'pickup',     label: 'PickupGuard',        icon: 'ph-hand-waving',    actions: ['view_pickup'] },
                          { key: 'forms',      label: 'Onboarding Forms',   icon: 'ph-clipboard-text', actions: ['view_forms'] },
                        ] },
  attendance_monitor: { label: 'Attendance Monitor',  icon: 'ph-list-checks',        actions: ['view', 'edit'],           path: '/attendance-monitor' },
  enrollment:         { label: 'Dataset Capture',     icon: 'ph-user-circle-plus',   actions: ['view', 'edit', 'delete', 'enroll', 'bulk_enroll', 'export_pii'], path: '/enrollment' },
  mobile_enrollment:  { label: 'Mobile Enrollment',   icon: 'ph-device-mobile',      actions: ['view', 'edit'],           path: '/mobile-enrollment' },
  device_manager:     { label: 'Device Manager',      icon: 'ph-cpu',                actions: ['view', 'edit', 'add', 'remove', 'factory_reset'], path: '/device-manager' },
  hikvision:          { label: 'Hikvision',           icon: 'ph-fingerprint',        actions: ['view', 'edit'],           path: '/hikvision' },
  device_sync:        { label: 'Device Sync',         icon: 'ph-cloud-arrow-down',   actions: ['view', 'edit'],           path: '/v2/device-sync' },
  pickup_admin:       { label: 'Pickup System Review',  icon: 'ph-hand-waving',        actions: [
                          'view',
                          // Review queue
                          'approve', 'reject', 'bulk_approve', 'bulk_reject',
                          'archive_submission', 'delete_submission',
                          // Chaperone lifecycle
                          'edit_chaperone', 'suspend_chaperone', 'delete_chaperone',
                          'upload_face', 'delete_face', 'reenroll',
                          // Devices + groups
                          'pair_devices', 'manage_terminals', 'manage_kiosks', 'manage_groups',
                          // Runtime
                          'officer_override', 'gate_control',
                          // Settings
                          'settings_view', 'settings_edit',
                          // Legacy umbrella alias kept for old override docs
                          'edit',
                        ],           path: '/v2/pickup-admin',
                        aliasPaths: ['/v2/chaperones', '/v2/officer-overrides', '/v2/security', '/v2/chaperone/[id]', '/v2/terminals', '/v2/release-groups', '/v2/pickup-enroll'],
                        // Sub-modules for the RBAC editor — surface fine-grained
                        // permission clusters as named groups in the drawer
                        // (instead of one flat dump under "Pickup System Review").
                        subModules: [
                          { key: 'review',      label: 'Review Queue',           icon: 'ph-clipboard-text',  actions: ['view', 'approve', 'reject', 'bulk_approve', 'bulk_reject', 'archive_submission', 'delete_submission'] },
                          { key: 'chaperones',  label: 'Chaperone Lifecycle',    icon: 'ph-user-list',       actions: ['edit_chaperone', 'suspend_chaperone', 'delete_chaperone', 'upload_face', 'delete_face', 'reenroll'] },
                          { key: 'devices',     label: 'Terminals & Kiosks',     icon: 'ph-cpu',             actions: ['pair_devices', 'manage_terminals', 'manage_kiosks'] },
                          { key: 'groups',      label: 'Release Groups',         icon: 'ph-users-three',     actions: ['manage_groups'] },
                          { key: 'runtime',     label: 'Gate Operations',        icon: 'ph-door-open',       actions: ['officer_override', 'gate_control'] },
                          { key: 'settings',    label: 'Pickup Settings',        icon: 'ph-gear-six',        actions: ['settings_view', 'settings_edit'] },
                        ] },
  settings:           { label: 'Settings',            icon: 'ph-gear-six',           actions: ['view', 'edit'],           path: '/v2/settings' },
  user_management:    { label: 'User Management',     icon: 'ph-users',              actions: [
                          'view',
                          'create', 'edit', 'suspend', 'delete',
                          'assign_admin', 'assign_owner',
                          'bulk_import', 'revoke_sessions',
                        ], settingsTab: 'user-management',
                        aliasPaths: ['/v2/admin/rbac', '/v2/admin/security-audit', '/v2/admin/system-audit'] },
  ai_parameters:      { label: 'AI Parameters',       icon: 'ph-bounding-box',       actions: ['view', 'edit'],           settingsTab: 'ai-parameters' },
  notifications:      { label: 'Notifications',       icon: 'ph-bell-ringing',       actions: ['view', 'edit'],           settingsTab: 'notifications' },
  integrations:       { label: 'Integrations',        icon: 'ph-plugs',              actions: ['view', 'edit'],           settingsTab: 'integrations' },
  security_audit:     { label: 'Security & Audit',    icon: 'ph-shield-check',       actions: ['view'],                   settingsTab: 'security',
                        aliasPaths: ['/v2/admin/rbac', '/v2/admin/security-audit', '/v2/admin/system-audit'] },
  // ── Sensitive User Access (M0 Track D) ───────────────────────────────
  // Owner-only by default. Each action is a HIGH-RISK capability that
  // touches another person's account credentials, role, or visibility.
  // Admins must be explicitly granted each one by an Owner — there is no
  // role-default that switches them on automatically.
  sensitive_user_access: {
    label: 'Sensitive User Access',
    icon: 'ph-shield-warning',
    actions: [
      'view_rbac',              // see /v2/admin/rbac at all
      'edit_rbac',              // modify role assignments + permission overrides
      'reset_user_password',    // open + submit the admin password-reset modal
      'view_user_directory',    // see /v2/admin/users (Firebase Auth listing)
      'manage_custom_claims',   // promote/demote owner/admin custom claims
    ],
    aliasPaths: ['/v2/admin/rbac', '/v2/admin/users'],
  },
  // ── Downloads Hub (M1 — granular split) ─────────────────────────────
  // The legacy `download_operational` / `download_security` / `download_audit`
  // triplet is replaced by FOUR finer-grained features so a department can
  // (e.g.) export the chaperone roster without also getting the right to
  // pull the full system audit log. Owner keeps everything; admin keeps
  // parity with the prior unified grant; pickup_admin gets operational only.
  downloads:          { label: 'Downloads Hub',       icon: 'ph-download-simple',    actions: [
                          'view',
                          // Operational data — attendance, pickup events, terminals, system health, students roster.
                          'download_operational',
                          // Directory data — onboarding forms + students roster (the people).
                          'download_directory',
                          // Security data — access logs + security incidents.
                          'download_security',
                          // Compliance data — audit log + chaperone audit/roster.
                          'download_compliance',
                          // M6 — saved presets, share links, scheduled runs.
                          // GET (list/get) only requires any download key.
                          // POST/PUT/DELETE of a preset, and share-link mint, require this action.
                          'manage_presets',
                        ],           path: '/v2/admin/downloads',
                        subModules: [
                          { key: 'operational', label: 'Operational',          icon: 'ph-chart-bar',       actions: ['download_operational'] },
                          { key: 'directory',   label: 'Directory',            icon: 'ph-address-book',    actions: ['download_directory'] },
                          { key: 'security',    label: 'Security & Incidents', icon: 'ph-shield-warning',  actions: ['download_security'] },
                          { key: 'compliance',  label: 'Audit & Compliance',   icon: 'ph-scales',          actions: ['download_compliance'] },
                          { key: 'presets',     label: 'Presets & Sharing',    icon: 'ph-bookmarks-simple',actions: ['manage_presets'] },
                        ] },
  // ── Auth (M3) ────────────────────────────────────────────────────────
  // Canonical "just needs to be signed in" permission. Every role
  // (owner/admin/viewer/guard) gets this by default. Endpoints that
  // serve per-user UI state (e.g. /api/v2/users/me/preferences) gate
  // on `auth.signed_in` so they don't have to reach for a download
  // permission the user may not have. Deliberately omitted from
  // FEATURE_GROUPS — it's infrastructure, not a togglable feature.
  auth:               { label: 'Authentication',     icon: 'ph-lock',               actions: ['signed_in'] },
};

// Feature keys grouped by category for the UI
export const FEATURE_GROUPS = [
  { label: 'Main', features: ['dashboard', 'analytics', 'reports'] },
  { label: 'Operations', features: ['attendance_monitor', 'enrollment', 'mobile_enrollment'] },
  { label: 'Devices', features: ['device_manager', 'hikvision', 'device_sync'] },
  { label: 'Pickup System', features: ['pickup_admin'] },
  { label: 'Administration', features: ['settings', 'user_management', 'sensitive_user_access', 'security_audit', 'downloads', 'ai_parameters', 'notifications', 'integrations'] },
];

// ── Role defaults ────────────────────────────────────────────────────
// true = all actions for that feature; array = specific actions only
const ROLE_DEFAULTS = {
  owner: Object.fromEntries(Object.keys(FEATURES).map(f => [f, true])),
  admin: {
    dashboard: true,
    analytics: true,
    reports: true,
    attendance_monitor: true,
    enrollment: true,
    mobile_enrollment: true,
    device_manager: true,
    hikvision: true,
    device_sync: true,
    pickup_admin: true,
    settings: ['view'],
    user_management: false,
    ai_parameters: true,
    notifications: true,
    integrations: false,
    security_audit: ['view'],
    downloads: true,
    // Owner-only by default. Every sensitive_user_access action must be
    // explicitly granted by an Owner — never enabled by default for admins.
    sensitive_user_access: false,
    auth: true,
  },
  viewer: {
    dashboard: ['view', 'view_attendance', 'view_pickup'],
    analytics: ['view', 'view_attendance', 'view_pickup'],
    reports: ['view', 'view_attendance', 'view_pickup', 'view_forms'],
    attendance_monitor: ['view'],
    enrollment: false,
    mobile_enrollment: false,
    device_manager: false,
    hikvision: false,
    device_sync: false,
    pickup_admin: false,
    settings: false,
    user_management: false,
    ai_parameters: false,
    notifications: false,
    integrations: false,
    security_audit: false,
    sensitive_user_access: false,
    auth: true,
  },
  // Security guard at the gate: full pickup-system access (TV feed,
  // overrides, terminals, release groups, kiosks, chaperone enrolment,
  // security heatmap). Read-only for dashboard/analytics/reports.
  guard: {
    dashboard: ['view', 'view_attendance', 'view_pickup'],
    analytics: ['view', 'view_attendance', 'view_pickup'],
    reports: ['view', 'view_attendance', 'view_pickup', 'view_forms'],
    attendance_monitor: ['view'],
    enrollment: false,
    mobile_enrollment: false,
    device_manager: false,
    hikvision: false,
    device_sync: false,
    pickup_admin: true,
    settings: false,
    user_management: false,
    ai_parameters: false,
    notifications: false,
    integrations: false,
    security_audit: ['view'],
    sensitive_user_access: false,
    auth: true,
  },
};

// ── Permission resolution ────────────────────────────────────────────

/**
 * Build a resolved permissions object from role defaults + per-user overrides.
 * @param {string} role - owner | admin | viewer
 * @param {Object} overrides - per-user overrides from Firestore { featureKey: true|false|['view','edit'] }
 * @returns {Object} { featureKey: { view: bool, edit: bool, delete: bool, export: bool } }
 */
export function resolvePermissions(role, overrides = {}) {
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.viewer;
  const result = {};
  // Owner is immutable — never let stale per-user overrides (e.g. an
  // explicit `sensitive_user_access: false` carried over from an old
  // admin template, or a feature that was added after the user doc
  // was last written) lock an Owner out of any feature. Owner means
  // every action on every feature, always.
  const isOwner = role === 'owner';

  for (const [feature, meta] of Object.entries(FEATURES)) {
    const defaultVal = defaults[feature];
    const override = overrides[feature];

    // Owner: ignore overrides. Otherwise: override if explicitly set.
    const val = isOwner
      ? true
      : (override !== undefined ? override : defaultVal);

    const resolved = {};
    for (const action of meta.actions) {
      if (val === true) {
        resolved[action] = true;
      } else if (val === false) {
        resolved[action] = false;
      } else if (Array.isArray(val)) {
        resolved[action] = val.includes(action);
      } else {
        resolved[action] = false;
      }
    }
    result[feature] = resolved;
  }

  return result;
}

/**
 * Check if permissions allow a specific action on a feature.
 */
export function hasPermission(permissions, feature, action = 'view') {
  return permissions?.[feature]?.[action] === true;
}

/**
 * Check if permissions allow access to a page path.
 */
export function canAccessPath(permissions, path) {
  // Strip querystring/hash so links like '/v2/pickup-admin?view=kiosks'
  // still match the underlying feature path.
  const cleanPath = String(path || '').split('?')[0].split('#')[0];

  // Owner bypass: if every feature has view=true (owner-equivalent),
  // grant access to anything under /v2 — prevents lockouts when new
  // pages are added before their alias entries land.
  if (permissions && Object.keys(FEATURES).every(
    (f) => permissions[f]?.view === true,
  )) {
    return true;
  }

  for (const [feature, meta] of Object.entries(FEATURES)) {
    if (meta.path && meta.path === cleanPath) {
      return hasPermission(permissions, feature, 'view');
    }
    if (meta.aliasPaths && meta.aliasPaths.includes(cleanPath)) {
      return hasPermission(permissions, feature, 'view');
    }
  }
  // If no feature maps to this path, deny
  return false;
}

/**
 * Get allowed settings tabs based on permissions.
 */
export function getAllowedSettingsTabs(permissions) {
  const tabs = [];
  for (const [feature, meta] of Object.entries(FEATURES)) {
    if (meta.settingsTab && hasPermission(permissions, feature, 'view')) {
      tabs.push(meta.settingsTab);
    }
  }
  // The Audit Trail tab is gated by the same permission as the Security tab —
  // if you can see Security & Access logs, you can see the mutation log.
  if (hasPermission(permissions, 'security_audit', 'view') && !tabs.includes('audit-trail')) {
    tabs.push('audit-trail');
  }
  return tabs;
}

/**
 * Filter nav sections to only show items the user has view access to.
 */
export function filterNavForRole(sections, permissions) {
  if (!permissions) return [];
  return sections
    .map(section => {
      const filteredItems = section.items
        .map(item => {
          if (item.children) {
            const allowedChildren = item.children.filter(c => canAccessPath(permissions, c.href));
            if (allowedChildren.length === 0) return null;
            return { ...item, children: allowedChildren };
          }
          return canAccessPath(permissions, item.href) ? item : null;
        })
        .filter(Boolean);

      if (filteredItems.length === 0) return null;
      return { ...section, items: filteredItems };
    })
    .filter(Boolean);
}

/**
 * Convert resolved permissions back to a storable overrides object.
 * Only stores values that differ from the role default.
 */
export function diffFromDefaults(role, permissions) {
  const defaults = resolvePermissions(role, {});
  const diff = {};

  for (const [feature, meta] of Object.entries(FEATURES)) {
    const defActions = defaults[feature];
    const curActions = permissions[feature];
    if (!curActions) continue;

    const changed = meta.actions.some(a => defActions[a] !== curActions[a]);
    if (changed) {
      // Store as array of enabled actions, or false if none
      const enabled = meta.actions.filter(a => curActions[a]);
      diff[feature] = enabled.length === meta.actions.length ? true :
                      enabled.length === 0 ? false : enabled;
    }
  }

  return diff;
}

/**
 * Check if role is admin-level (owner or admin).
 */
export function isAdminRole(role) {
  return role === 'owner' || role === 'admin';
}

/**
 * Check if role is owner.
 */
export function isOwnerRole(role) {
  return role === 'owner';
}

// ── Legacy compat ────────────────────────────────────────────────────
// canAccess is still used by _app.js AuthGate
export function canAccess(role, path) {
  const perms = resolvePermissions(role);
  return canAccessPath(perms, path);
}
