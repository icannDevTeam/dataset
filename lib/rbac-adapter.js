/**
 * RBAC Adapter — Convert between student's template-based UI model and existing action-based model.
 *
 * The student component uses template presets (Operations/ACOP/IT/Individual) + read/write toggles.
 * The existing system uses 3 roles (owner/admin/viewer) + granular actions per feature.
 *
 * This module bridges the two: student UI ↔ Firestore storage ↔ permissions.js
 */

import { FEATURES, ROLE_DEFAULTS, resolvePermissions, diffFromDefaults } from './permissions';

// ─ Template ↔ Role Mapping ────────────────────────────────────────────
/**
 * Convert student component template to existing role.
 * @param {string} template - 'operations' | 'acop' | 'it' | 'individual'
 * @returns {string} - 'viewer' | 'admin' | 'owner'
 */
export function templateToRole(template) {
  const map = {
    operations: 'viewer',
    acop: 'admin',
    it: 'owner',
    individual: 'viewer', // Individual starts as viewer, permissions override it
  };
  return map[template] || 'viewer';
}

/**
 * Convert existing role to student component template.
 * @param {string} role - 'viewer' | 'admin' | 'owner'
 * @param {object} permissions - Firestore permissions object
 * @returns {string} - 'operations' | 'acop' | 'it' | 'individual'
 */
export function roleToTemplate(role, permissions) {
  // If user has custom permissions that differ from role defaults, treat as 'individual'
  if (permissions && Object.keys(permissions).length > 0) {
    const defaults = ROLE_DEFAULTS[role] || {};
    if (JSON.stringify(permissions) !== JSON.stringify(defaults)) {
      return 'individual';
    }
  }
  
  const map = {
    viewer: 'operations',
    admin: 'acop',
    owner: 'it',
  };
  return map[role] || 'operations';
}

// ─ Student Permission Format ↔ Firestore Format ─────────────────────
/**
 * Student UI uses: { 'main.operations': { read: true, write: false } }
 * Firestore uses: { 'dashboard': { 'view': true } }
 *
 * This function converts student format → Firestore format.
 */
export function convertStudentPermissionsToFirestore(studentPermissions) {
  const result = {};

  for (const [key, value] of Object.entries(studentPermissions || {})) {
    const feature = studentKeyToFeature(key);
    
    // Only add feature if at least one permission is granted
    if (feature && (value.read || value.write)) {
      result[feature] = {
        view: value.read || false,
        edit: value.write || false,
        // Additional actions like 'delete', 'create' could be added here if needed
      };
    }
  }

  return result;
}

/**
 * Reverse: Firestore format → student UI format.
 * Used when loading existing users to display in the template editor.
 */
export function convertFirestorePermissionsToStudent(firestorePermissions) {
  const result = {};

  for (const [feature, actions] of Object.entries(firestorePermissions || {})) {
    const studentKeys = featureToStudentKeys(feature);
    
    // A feature might map to multiple student keys (e.g., pickup_admin → multiple pickup items)
    for (const key of studentKeys) {
      result[key] = {
        read: actions.view || false,
        write: actions.edit || false,
      };
    }
  }

  return result;
}

/**
 * Map student UI keys → feature names.
 * 
 * Student structure: 'category.subcategory'
 * Features structure: lowercase, underscores
 */
function studentKeyToFeature(key) {
  const mapping = {
    // Main Access
    'main.operations': 'dashboard',
    'main.devices': 'device_manager',
    'main.pickupSystem': 'pickup_admin',
    'main.administration': 'settings',

    // Operations
    'operations.dashboard': 'dashboard',
    'operations.analytics': 'analytics',
    'operations.reports': 'reports',

    // Devices
    'devices.attendanceMonitor': 'attendance_monitor',
    'devices.datasetCapture': 'enrollment',
    'devices.mobileEnrollment': 'mobile_enrollment',
    'devices.deviceManager': 'device_manager',
    'devices.hikvision': 'hikvision',
    'devices.deviceSync': 'device_sync',

    // Pickup System (all map to pickup_admin for now)
    'pickupSystem.reviewQueue': 'pickup_admin',
    'pickupSystem.chaperoneLifecycle': 'pickup_admin',
    'pickupSystem.releaseGroups': 'pickup_admin',
    'pickupSystem.gateOperations': 'pickup_admin',
    'pickupSystem.pickupSettings': 'pickup_admin',
    'pickupSystem.terminalsAndKiosks': 'pickup_admin',

    // Administration
    'administration.settings': 'settings',
    'administration.userManagement': 'user_management',
    'administration.sensitiveUserAccess': 'sensitive_user_access',
    'administration.securityAndAudit': 'security_audit',
    'administration.downloadsHub': 'downloads',
    'administration.notifications': 'notifications',
    'administration.integrations': 'integrations',
  };

  return mapping[key];
}

/**
 * Reverse mapping: feature → student keys.
 * Note: Some features might map to multiple keys (e.g., pickup_admin).
 */
function featureToStudentKeys(feature) {
  const reverseMap = {
    dashboard: ['main.operations', 'operations.dashboard'],
    analytics: ['operations.analytics'],
    reports: ['operations.reports'],
    attendance_monitor: ['devices.attendanceMonitor'],
    enrollment: ['devices.datasetCapture'],
    mobile_enrollment: ['devices.mobileEnrollment'],
    device_manager: ['main.devices', 'devices.deviceManager'],
    hikvision: ['devices.hikvision'],
    device_sync: ['devices.deviceSync'],
    pickup_admin: [
      'main.pickupSystem',
      'pickupSystem.reviewQueue',
      'pickupSystem.chaperoneLifecycle',
      'pickupSystem.releaseGroups',
      'pickupSystem.gateOperations',
      'pickupSystem.pickupSettings',
      'pickupSystem.terminalsAndKiosks',
    ],
    settings: ['main.administration', 'administration.settings'],
    user_management: ['administration.userManagement'],
    sensitive_user_access: ['administration.sensitiveUserAccess'],
    security_audit: ['administration.securityAndAudit'],
    downloads: ['administration.downloadsHub'],
    notifications: ['administration.notifications'],
    integrations: ['administration.integrations'],
  };

  return reverseMap[feature] || [];
}

// ─ User Status Mapping ────────────────────────────────────────────────
/**
 * Firebase Auth status → UI status.
 */
export function statusToUIStatus(firebaseStatus, invitePending = false) {
  if (invitePending) return 'Pending';
  if (firebaseStatus === 'DISABLED') return 'Disabled';
  return 'Active';
}

// ─ Managed User Adapter ───────────────────────────────────────────────
/**
 * Convert Firebase user doc → ManagedUser for student UI.
 */
export function toManagedUser(firebaseUser, index = 0) {
  const template = roleToTemplate(firebaseUser.role, firebaseUser.permissions);
  const roleLabel = {
    viewer: 'Operations Template',
    admin: 'ACOP Template',
    owner: 'IT Template',
    individual: 'Individual Access',
  }[template] || 'Unknown';

  return {
    id: index, // Use array index as ID; ideally use uid slice
    name: firebaseUser.displayName || 'Unknown User',
    email: firebaseUser.email,
    template,
    roleLabel,
    summary: generateAccessSummary(firebaseUser.role, firebaseUser.permissions),
    status: statusToUIStatus(firebaseUser.status, firebaseUser.invited),
    lastActive: formatLastActive(firebaseUser.lastSignInTime),
  };
}

/**
 * Generate human-readable summary of user's access (e.g., "Reports, Release Groups, Dashboard").
 */
function generateAccessSummary(role, permissions) {
  const resolved = resolvePermissions(role, permissions || {});
  const enabledFeatures = Object.entries(FEATURES)
    .filter(([, feature]) => {
      // Check if user can 'view' this feature
      const actions = resolved[feature.key] || {};
      return actions.view === true;
    })
    .map(([key, feature]) => feature.label);

  if (enabledFeatures.length === 0) {
    return 'No access granted';
  }

  return enabledFeatures.slice(0, 3).join(', ') + (enabledFeatures.length > 3 ? `, +${enabledFeatures.length - 3} more` : '');
}

/**
 * Format last sign-in timestamp for UI (e.g., "2 hours ago", "Never").
 */
function formatLastActive(timestamp) {
  if (!timestamp) return 'Never';

  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Right now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
}

// ─ User Invite Payload Builder ────────────────────────────────────────
/**
 * Build POST payload for /api/auth/users from student form inputs.
 */
export function buildUserInvitePayload(draftName, draftEmail, template, permissions) {
  const role = templateToRole(template);
  const permissionOverrides = template === 'individual' 
    ? convertStudentPermissionsToFirestore(permissions)
    : {}; // Template roles rely on defaults; no custom overrides needed

  return {
    name: draftName.trim(),
    email: draftEmail.trim() || null,
    role,
    permissions: permissionOverrides,
    // Optional: password generation handled by backend
  };
}

// ─ Permission Editor Helpers ──────────────────────────────────────────
/**
 * Create an empty permission map (all read/write false).
 */
export function createEmptyPermissions() {
  const result = {};
  // Build from the student component's RBAC_GROUPS structure
  // (If reusing, you'd pass the groups in; for now, a simplified version:)
  const keys = [
    'main.operations', 'main.devices', 'main.pickupSystem', 'main.administration',
    'operations.dashboard', 'operations.analytics', 'operations.reports',
    'devices.attendanceMonitor', 'devices.datasetCapture', 'devices.mobileEnrollment',
    'devices.deviceManager', 'devices.hikvision', 'devices.deviceSync',
    'pickupSystem.reviewQueue', 'pickupSystem.chaperoneLifecycle', 'pickupSystem.releaseGroups',
    'pickupSystem.gateOperations', 'pickupSystem.pickupSettings', 'pickupSystem.terminalsAndKiosks',
    'administration.settings', 'administration.userManagement', 'administration.sensitiveUserAccess',
    'administration.securityAndAudit', 'administration.downloadsHub', 'administration.notifications',
    'administration.integrations',
  ];

  for (const key of keys) {
    result[key] = { read: false, write: false };
  }

  return result;
}

/**
 * Load template permissions (read from hardcoded preset).
 */
export function loadTemplatePermissions(template) {
  // These could also come from TEMPLATE_PERMISSIONS in the component,
  // or be pre-computed from ROLE_DEFAULTS
  const presets = {
    operations: {
      'operations.dashboard': { read: true, write: false },
      'operations.analytics': { read: true, write: false },
      'operations.reports': { read: true, write: true },
      'pickupSystem.reviewQueue': { read: true, write: false },
      'pickupSystem.chaperoneLifecycle': { read: true, write: false },
      'pickupSystem.releaseGroups': { read: true, write: false },
      'pickupSystem.gateOperations': { read: true, write: false },
      'pickupSystem.pickupSettings': { read: true, write: false },
      'administration.downloadsHub': { read: true, write: true },
      'administration.notifications': { read: true, write: true },
    },
    acop: {
      'main.operations': { read: true, write: true },
      'main.pickupSystem': { read: true, write: true },
      'main.administration': { read: true, write: true },
      'operations.dashboard': { read: true, write: false },
      'operations.analytics': { read: true, write: false },
      'operations.reports': { read: true, write: true },
      'devices.attendanceMonitor': { read: true, write: false },
      'pickupSystem.reviewQueue': { read: true, write: true },
      'pickupSystem.chaperoneLifecycle': { read: true, write: true },
      'pickupSystem.releaseGroups': { read: true, write: true },
      'pickupSystem.gateOperations': { read: true, write: true },
      'pickupSystem.pickupSettings': { read: true, write: true },
      'administration.downloadsHub': { read: true, write: true },
      'administration.notifications': { read: true, write: true },
    },
    it: {
      // IT (owner) gets most things
      'main.operations': { read: true, write: true },
      'main.devices': { read: true, write: true },
      'main.pickupSystem': { read: true, write: true },
      'main.administration': { read: true, write: true },
      'operations.dashboard': { read: true, write: true },
      'operations.analytics': { read: true, write: true },
      'operations.reports': { read: true, write: true },
      'devices.attendanceMonitor': { read: true, write: true },
      'devices.datasetCapture': { read: true, write: false },
      'devices.deviceManager': { read: true, write: true },
      'devices.hikvision': { read: true, write: true },
      'devices.deviceSync': { read: true, write: true },
      'pickupSystem.reviewQueue': { read: true, write: true },
      'pickupSystem.chaperoneLifecycle': { read: true, write: true },
      'pickupSystem.releaseGroups': { read: true, write: true },
      'pickupSystem.gateOperations': { read: true, write: true },
      'pickupSystem.pickupSettings': { read: true, write: true },
      'pickupSystem.terminalsAndKiosks': { read: true, write: true },
      'administration.settings': { read: true, write: true },
      'administration.userManagement': { read: true, write: true },
      'administration.securityAndAudit': { read: true, write: true },
      'administration.downloadsHub': { read: true, write: true },
      'administration.notifications': { read: true, write: true },
      'administration.integrations': { read: true, write: true },
    },
    individual: {},
  };

  return { ...createEmptyPermissions(), ...(presets[template] || {}) };
}

/**
 * Count enabled read/write permissions.
 */
export function countPermissions(permissions) {
  let readable = 0;
  let writable = 0;

  for (const perm of Object.values(permissions || {})) {
    if (perm.read) readable++;
    if (perm.write) writable++;
  }

  return { readable, writable };
}

/**
 * Get list of enabled feature areas (for display).
 */
export function getEnabledAreas(permissions) {
  const areas = new Set();

  for (const [key, perm] of Object.entries(permissions || {})) {
    if (perm.read || perm.write) {
      // Extract category from key (e.g., 'main' from 'main.operations')
      const [category] = key.split('.');
      areas.add(category);
    }
  }

  return Array.from(areas).sort();
}

export default {
  templateToRole,
  roleToTemplate,
  convertStudentPermissionsToFirestore,
  convertFirestorePermissionsToStudent,
  toManagedUser,
  buildUserInvitePayload,
  createEmptyPermissions,
  loadTemplatePermissions,
  countPermissions,
  getEnabledAreas,
};
