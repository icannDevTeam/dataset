/**
 * RBAC Permissions — granular feature-level access control.
 *
 * Each feature has actions: view, edit, delete (not all features use all actions).
 * Roles provide default permissions; per-user overrides are stored in Firestore.
 *
 * Flow: role defaults → merge with user overrides → final permission set
 */

// ── All features and their possible actions ──────────────────────────
export const FEATURES = {
  dashboard:          { label: 'Dashboard',           icon: 'ph-squares-four',       actions: ['view'],                   path: '/v2' },
  analytics:          { label: 'Analytics',           icon: 'ph-chart-line-up',      actions: ['view', 'export'],         path: '/v2/analytics' },
  reports:            { label: 'Reports',             icon: 'ph-file-text',          actions: ['view', 'export'],         path: '/v2/reports' },
  attendance_monitor: { label: 'Attendance Monitor',  icon: 'ph-list-checks',        actions: ['view', 'edit'],           path: '/attendance-monitor' },
  enrollment:         { label: 'Dataset Capture',     icon: 'ph-user-circle-plus',   actions: ['view', 'edit', 'delete'], path: '/enrollment' },
  mobile_enrollment:  { label: 'Mobile Enrollment',   icon: 'ph-device-mobile',      actions: ['view', 'edit'],           path: '/mobile-enrollment' },
  device_manager:     { label: 'Device Manager',      icon: 'ph-cpu',                actions: ['view', 'edit'],           path: '/device-manager' },
  hikvision:          { label: 'Hikvision',           icon: 'ph-fingerprint',        actions: ['view', 'edit'],           path: '/hikvision' },
  device_sync:        { label: 'Device Sync',         icon: 'ph-cloud-arrow-down',   actions: ['view', 'edit'],           path: '/v2/device-sync' },
  pickup_admin:       { label: 'PickupGuard Review',  icon: 'ph-hand-waving',        actions: ['view', 'edit'],           path: '/v2/pickup-admin',
                        aliasPaths: ['/v2/chaperones', '/v2/officer-overrides', '/v2/security', '/v2/chaperone/[id]'] },
  settings:           { label: 'Settings',            icon: 'ph-gear-six',           actions: ['view', 'edit'],           path: '/v2/settings' },
  user_management:    { label: 'User Management',     icon: 'ph-users',              actions: ['view', 'edit', 'delete'], settingsTab: 'user-management' },
  ai_parameters:      { label: 'AI Parameters',       icon: 'ph-bounding-box',       actions: ['view', 'edit'],           settingsTab: 'ai-parameters' },
  notifications:      { label: 'Notifications',       icon: 'ph-bell-ringing',       actions: ['view', 'edit'],           settingsTab: 'notifications' },
  integrations:       { label: 'Integrations',        icon: 'ph-plugs',              actions: ['view', 'edit'],           settingsTab: 'integrations' },
  security_audit:     { label: 'Security & Audit',    icon: 'ph-shield-check',       actions: ['view'],                   settingsTab: 'security' },
};

// Feature keys grouped by category for the UI
export const FEATURE_GROUPS = [
  { label: 'Main', features: ['dashboard', 'analytics', 'reports'] },
  { label: 'Operations', features: ['attendance_monitor', 'enrollment', 'mobile_enrollment'] },
  { label: 'Devices', features: ['device_manager', 'hikvision', 'device_sync'] },
  { label: 'PickupGuard', features: ['pickup_admin'] },
  { label: 'Administration', features: ['settings', 'user_management', 'security_audit', 'ai_parameters', 'notifications', 'integrations'] },
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
  },
  viewer: {
    dashboard: ['view'],
    analytics: ['view'],
    reports: ['view'],
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

  for (const [feature, meta] of Object.entries(FEATURES)) {
    const defaultVal = defaults[feature];
    const override = overrides[feature];

    // Use override if explicitly set, otherwise use default
    const val = override !== undefined ? override : defaultVal;

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
