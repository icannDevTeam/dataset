/**
 * RBAC — Granular permission catalog and check helpers.
 *
 * This is the *single source of truth* for fine-grained authorization. Every
 * sensitive API action is named here as a `feature.action` string (e.g.
 * `pickup_admin.approve`). Backend routes call `can(user.permissions, key)`;
 * the UI calls the same helper to decide what to render.
 *
 * Design goals:
 *   1. Action-level granularity, not just view/edit/delete.
 *   2. Backwards-compatible with `lib/permissions.js` — the resolved
 *      `permissions[feature]` shape is unchanged. New actions just plug in.
 *   3. Zero per-request Firestore reads during the check itself; the resolved
 *      permissions object is passed in. Caching of identity → permissions
 *      lives in `lib/api-auth.js`.
 *   4. Scope-aware. Some actions (homeroom-restricted teacher viewing) need a
 *      resource scope check on top of the action grant.
 *
 * Action naming convention:
 *   <feature>.<verb>[_<noun>]   e.g. pickup_admin.approve,
 *                                     pickup_admin.suspend_chaperone,
 *                                     user_management.assign_owner.
 *
 * If you add a new action below you MUST also add it to the matching FEATURES
 * entry in `lib/permissions.js` so the user-management UI exposes it.
 */

// ── Granular action catalog ──────────────────────────────────────────
//
// Format: 'feature.action' → human-readable label + risk tier.
// Risk tiers: 'read' | 'write' | 'destructive' | 'admin'.
// The UI groups these for the per-user override editor.

const ACTIONS = Object.freeze({
  // Pickup admin — approval queue
  'pickup_admin.view':                 { label: 'View pickup queue + history',     risk: 'read' },
  'pickup_admin.approve':              { label: 'Approve a single submission',     risk: 'write' },
  'pickup_admin.reject':               { label: 'Reject a single submission',      risk: 'write' },
  'pickup_admin.bulk_approve':         { label: 'Bulk approve submissions',        risk: 'write' },
  'pickup_admin.bulk_reject':          { label: 'Bulk reject submissions',         risk: 'write' },
  'pickup_admin.archive_submission':   { label: 'Archive / restore submissions',   risk: 'write' },
  'pickup_admin.delete_submission':    { label: 'Permanently delete submissions',  risk: 'destructive' },
  'pickup_admin.edit_chaperone':       { label: 'Edit chaperone details',          risk: 'write' },
  'pickup_admin.suspend_chaperone':    { label: 'Suspend a chaperone',             risk: 'write' },
  'pickup_admin.delete_chaperone':     { label: 'Delete a chaperone',              risk: 'destructive' },
  'pickup_admin.upload_face':          { label: 'Upload chaperone face photo',     risk: 'write' },
  'pickup_admin.delete_face':          { label: 'Remove chaperone face photo',     risk: 'destructive' },
  'pickup_admin.reenroll':             { label: 'Re-enrol on terminals',           risk: 'write' },

  // Pickup admin — devices + groups
  'pickup_admin.pair_devices':         { label: 'Pair TVs / iPads',                risk: 'write' },
  'pickup_admin.manage_terminals':     { label: 'Manage face terminals',           risk: 'write' },
  'pickup_admin.manage_kiosks':        { label: 'Manage kiosk profiles',           risk: 'write' },
  'pickup_admin.manage_groups':        { label: 'Manage release groups',           risk: 'write' },

  // Pickup admin — runtime control
  'pickup_admin.officer_override':     { label: 'Submit officer override',         risk: 'write' },
  'pickup_admin.gate_control':         { label: 'Open / close pickup gate',        risk: 'write' },

  // Pickup admin — settings
  'pickup_admin.settings_view':        { label: 'View pickup settings',            risk: 'read' },
  'pickup_admin.settings_edit':        { label: 'Edit pickup settings',            risk: 'admin' },

  // Enrollment / dataset
  'enrollment.view':                   { label: 'View enrollment dataset',         risk: 'read' },
  'enrollment.enroll':                 { label: 'Enrol a face',                    risk: 'write' },
  'enrollment.bulk_enroll':            { label: 'Bulk enrol many faces',           risk: 'write' },
  'enrollment.delete':                 { label: 'Delete an enrolled face',         risk: 'destructive' },
  'enrollment.export_pii':             { label: 'Export PII (names + photos)',     risk: 'admin' },

  // Device manager
  'device_manager.view':               { label: 'View devices',                    risk: 'read' },
  'device_manager.edit':               { label: 'Edit device config',              risk: 'write' },
  'device_manager.add':                { label: 'Add a device',                    risk: 'write' },
  'device_manager.remove':             { label: 'Remove a device',                 risk: 'destructive' },
  'device_manager.factory_reset':      { label: 'Factory-reset a device',          risk: 'destructive' },

  // User management
  'user_management.view':              { label: 'View dashboard users',            risk: 'read' },
  'user_management.create':            { label: 'Create a dashboard user',         risk: 'admin' },
  'user_management.edit':              { label: 'Edit a dashboard user',           risk: 'admin' },
  'user_management.suspend':           { label: 'Suspend / re-enable a user',      risk: 'admin' },
  'user_management.delete':            { label: 'Delete a dashboard user',         risk: 'destructive' },
  'user_management.assign_admin':      { label: 'Assign the admin role',           risk: 'admin' },
  'user_management.assign_owner':      { label: 'Assign the owner role',           risk: 'admin' },
  'user_management.bulk_import':       { label: 'Bulk import users (CSV)',         risk: 'admin' },
  'user_management.revoke_sessions':   { label: 'Force-logout active sessions',    risk: 'admin' },

  // Analytics + reports
  'analytics.view':                    { label: 'View analytics',                  risk: 'read' },
  'analytics.export':                  { label: 'Export analytics',                risk: 'write' },
  'analytics.view_pii':                { label: 'See unmasked names / photos',     risk: 'admin' },
  'reports.view':                      { label: 'View reports',                    risk: 'read' },
  'reports.export':                    { label: 'Export reports',                  risk: 'write' },

  // Settings (root)
  'settings.view':                     { label: 'View settings',                   risk: 'read' },
  'settings.edit':                     { label: 'Edit settings',                   risk: 'admin' },

  // Security + audit
  'security_audit.view':               { label: 'View access + audit logs',        risk: 'read' },
  'security_audit.export':             { label: 'Export audit logs',               risk: 'admin' },

  // Downloads hub — centralized data exports (/v2/admin/downloads)
  'downloads.view':                    { label: 'Open downloads hub',              risk: 'read' },
  // ── Downloads Hub ──────────────────────────────────────────────────
  // LEGACY (pre-M1, removed): downloads.download_operational was a
  //   single bucket covering attendance + chaperones + onboarding +
  //   pickup events + security incidents + audit log + access logs.
  //   M1 splits it into the four keys below. Old keys are gone; any
  //   existing per-user override doc that still names them will simply
  //   resolve to "no grant" (deny) — safe by default.
  'downloads.download_operational':    { label: 'Export operational data (attendance, terminals, pickup events, system health)', risk: 'write' },
  'downloads.download_directory':      { label: 'Export directory data (students roster, onboarding forms)',                     risk: 'write' },
  'downloads.download_security':       { label: 'Export security data (incidents, access logs)',                                 risk: 'admin' },
  'downloads.download_compliance':     { label: 'Export compliance data (audit log, chaperone roster, chaperone audit)',         risk: 'admin' },

  // ── Sensitive User Access (M0 Track D) ──────────────────────────────
  // Owner-only by default. Each toggle here directly affects another
  // person's account credentials, role, or visibility. Granting any of
  // these to an admin is logged as `rbac.sensitive_grant` (high severity).
  'sensitive_user_access.view_rbac':            { label: 'Open the RBAC console (/v2/admin/rbac)',     risk: 'admin' },
  'sensitive_user_access.edit_rbac':            { label: 'Modify role assignments + overrides',         risk: 'admin' },
  'sensitive_user_access.reset_user_password':  { label: 'Reset another user\u2019s password directly', risk: 'destructive' },
  'sensitive_user_access.view_user_directory':  { label: 'See the full users directory',                risk: 'admin' },
  'sensitive_user_access.manage_custom_claims': { label: 'Promote / demote owner + admin claims',       risk: 'destructive' },

  // ── Email Hub ────────────────────────────────────────────────────────
  'email_hub.view':             { label: 'View Email Hub (contacts, history, templates)', risk: 'read' },
  'email_hub.send':             { label: 'Send broadcast campaigns + invite links',       risk: 'write' },
  'email_hub.manage_templates': { label: 'Create / edit / delete email templates',        risk: 'write' },
  'email_hub.manage_contacts':  { label: 'Sync from forms, edit, delete contacts',        risk: 'write' },

  // ── Owner-Only Operational Modules ──────────────────────────────────
  // Raw infrastructure telemetry and service NOC views. Owner-only by
  // default — no role receives any access unless an Owner explicitly grants it.
  'system_monitor.view':      { label: 'View System Monitor (health, API status, notification log)', risk: 'admin' },
  'operation_interface.view': { label: 'View Operations Interface (terminals, live ticker, listener console)', risk: 'admin' },
  'system_interface.view':    { label: 'View Service Interfaces (Cisco NOC — Firebase, Resend, Hikvision, etc.)', risk: 'admin' },

  // ── Auth (M3) ──────────────────────────────────────────────────────
  // Canonical "just needs to be signed in" gate. Granted to every role
  // by default. Use this on endpoints that serve per-user UI state
  // (preferences, favourites, last-viewed) so the gate doesn't have to
  // borrow a stronger permission the user may not hold.
  'auth.signed_in':                              { label: 'Signed-in dashboard user',                    risk: 'read' },
});

const ALL_ACTION_KEYS = Object.freeze(Object.keys(ACTIONS));

// Group actions by feature for the per-user override UI.
function actionsByFeature() {
  const out = {};
  for (const key of ALL_ACTION_KEYS) {
    const [feature, action] = key.split('.');
    if (!out[feature]) out[feature] = [];
    out[feature].push(action);
  }
  return out;
}

const ACTIONS_BY_FEATURE = Object.freeze(actionsByFeature());

// ── The single check helper ──────────────────────────────────────────

/**
 * Granular check: does this resolved-permissions object grant `feature.action`?
 *
 * The resolved permissions object is the per-feature map produced by
 * `resolvePermissions()` in `lib/permissions.js` — `{ pickup_admin: { view:
 * true, approve: true, ... } }`.
 *
 * Returns false (deny) on any malformed input. Fail-closed.
 *
 * @param {Object} permissions
 * @param {string} key  'feature.action'
 * @returns {boolean}
 */
function can(permissions, key) {
  if (!permissions || typeof permissions !== 'object') return false;
  if (typeof key !== 'string' || !key.includes('.')) return false;
  const dot = key.indexOf('.');
  const feature = key.slice(0, dot);
  const action = key.slice(dot + 1);
  const bucket = permissions[feature];
  if (!bucket || typeof bucket !== 'object') return false;
  return bucket[action] === true;
}

/**
 * Convenience: require ALL of the supplied keys.
 */
function canAll(permissions, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return false;
  return keys.every((k) => can(permissions, k));
}

/**
 * Convenience: require ANY of the supplied keys.
 */
function canAny(permissions, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return false;
  return keys.some((k) => can(permissions, k));
}

// ── Resource scope checks ────────────────────────────────────────────
//
// A user may have an action grant (e.g. pickup_admin.approve) but be scoped
// to a subset of homerooms / grades / release groups. Scopes are stored on
// the user doc as:
//   classScopes: ['4A', '4B']      — homeroom whitelist (legacy)
//   gradeScopes: [4, 5]             — grade whitelist
//   releaseGroupScopes: ['rgId']    — release group whitelist
//
// An empty / missing array means "no scope restriction" (i.e. all-access for
// that dimension). This matches the existing `classScopes` semantics.

function _arr(v) { return Array.isArray(v) ? v : []; }

function inHomeroomScope(user, homeroom) {
  const scopes = _arr(user?.classScopes);
  if (scopes.length === 0) return true;
  return homeroom && scopes.includes(String(homeroom));
}

function inGradeScope(user, grade) {
  const scopes = _arr(user?.gradeScopes);
  if (scopes.length === 0) return true;
  if (grade == null) return false;
  return scopes.includes(Number(grade)) || scopes.includes(String(grade));
}

function inReleaseGroupScope(user, releaseGroupId) {
  const scopes = _arr(user?.releaseGroupScopes);
  if (scopes.length === 0) return true;
  return releaseGroupId && scopes.includes(String(releaseGroupId));
}

module.exports = {
  ACTIONS,
  ALL_ACTION_KEYS,
  ACTIONS_BY_FEATURE,
  can,
  canAll,
  canAny,
  inHomeroomScope,
  inGradeScope,
  inReleaseGroupScope,
};

module.exports.default = module.exports;
