/**
 * RBAC Permissions — defines what each role can see and do.
 *
 * Roles: owner > admin > viewer
 * Owner:  Full access (user management, settings, devices, enrollment, all data)
 * Admin:  Manage attendance & devices, view analytics, no user management
 * Viewer: View-only dashboard, analytics, reports, attendance monitor
 */

// Pages each role can access
const ROLE_PAGES = {
  owner: [
    '/v2', '/v2/analytics', '/v2/reports', '/v2/settings', '/v2/device-sync',
    '/enrollment', '/mobile-enrollment',
    '/device-manager', '/attendance-monitor', '/hikvision',
    '/dashboard',
  ],
  admin: [
    '/v2', '/v2/analytics', '/v2/reports', '/v2/device-sync',
    '/enrollment', '/mobile-enrollment',
    '/device-manager', '/attendance-monitor', '/hikvision',
    '/dashboard',
  ],
  viewer: [
    '/v2', '/v2/analytics', '/v2/reports',
    '/attendance-monitor',
  ],
};

// Settings tabs each role can see
const ROLE_SETTINGS_TABS = {
  owner: ['security', 'user-management', 'ai-parameters', 'notifications', 'integrations'],
  admin: ['ai-parameters', 'notifications'],
  viewer: [],
};

/**
 * Check if a role can access a given page path.
 */
export function canAccess(role, path) {
  const pages = ROLE_PAGES[role] || ROLE_PAGES.viewer;
  return pages.some(p => {
    if (p === path) return true;
    // exact match for /v2 but prefix match for /v2/something
    if (p !== '/v2' && path.startsWith(p)) return true;
    return false;
  });
}

/**
 * Get allowed settings tabs for a role.
 */
export function getAllowedSettingsTabs(role) {
  return ROLE_SETTINGS_TABS[role] || ROLE_SETTINGS_TABS.viewer;
}

/**
 * Filter nav sections to only show items the role can access.
 */
export function filterNavForRole(sections, role) {
  return sections
    .map(section => {
      const filteredItems = section.items
        .map(item => {
          if (item.children) {
            const allowedChildren = item.children.filter(c => canAccess(role, c.href));
            if (allowedChildren.length === 0) return null;
            return { ...item, children: allowedChildren };
          }
          return canAccess(role, item.href) ? item : null;
        })
        .filter(Boolean);

      if (filteredItems.length === 0) return null;
      return { ...section, items: filteredItems };
    })
    .filter(Boolean);
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
