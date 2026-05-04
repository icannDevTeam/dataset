/**
 * Multi-tenancy helpers (JS / Next.js side) — Phase A1 foundation.
 *
 * Mirrors backend/tenancy.py. Every API route that previously hit a root-level
 * Firestore collection or Storage prefix should route through these helpers.
 *
 * See backend/tenancy.py for the canonical schema documentation.
 */

const DEFAULT_TENANT_ID = 'binus-simprug';

/** Resolve active tenant id (explicit > env > default). */
function getTenantId(explicit) {
  if (explicit) return explicit;
  return process.env.TENANT_ID || DEFAULT_TENANT_ID;
}

function tenantAwareEnabled() {
  return ['true', '1', 'yes'].includes(String(process.env.TENANT_AWARE || 'false').toLowerCase());
}

function legacyPathsEnabled() {
  return ['true', '1', 'yes'].includes(String(process.env.LEGACY_PATHS || 'true').toLowerCase());
}

// ─── Firestore paths ────────────────────────────────────────────────
const tenantDoc = (t) => `tenants/${getTenantId(t)}`;
const studentsPath = (t) => `${tenantDoc(t)}/students`;
const studentMetadataPath = (t) => `${tenantDoc(t)}/student_metadata`;
const faceDescriptorsPath = (t) => `${tenantDoc(t)}/face_descriptors`;
const attendanceDayDoc = (date, t) => `${tenantDoc(t)}/attendance/${date}`;
const attendanceRecordPath = (date, employeeNo, t) => `${attendanceDayDoc(date, t)}/records/${employeeNo}`;
const devicesPath = (t) => `${tenantDoc(t)}/devices`;
const consentsPath = (t) => `${tenantDoc(t)}/consents`;
const policyVersionsPath = (t) => `${tenantDoc(t)}/policy_versions`;
const dataRequestsPath = (t) => `${tenantDoc(t)}/data_requests`;
const erasureLogPath = (t) => `${tenantDoc(t)}/erasure_log`;
const biometricAccessLogPath = (t) => `${tenantDoc(t)}/biometric_access_log`;
const securityIncidentsPath = (t) => `${tenantDoc(t)}/security_incidents`;
const tenantUsersPath = (t) => `${tenantDoc(t)}/users`;

// ─── PickupGuard (chaperone pick-up) ────────────────────────────────
const chaperonesPath = (t) => `${tenantDoc(t)}/chaperones`;
const pickupEventsPath = (t) => `${tenantDoc(t)}/pickup_events`;
const pickupOverridesPath = (t) => `${tenantDoc(t)}/pickup_overrides`;
const pickupSettingsDoc = (t) => `${tenantDoc(t)}/settings/pickup`;
const pickupOnboardingPath = (t) => `${tenantDoc(t)}/pickup_onboarding`;
const idAllocationsDoc = (name, t) => `${tenantDoc(t)}/id_allocations/${name}`;
const storagePickupCapturePath = (eventId, t) =>
  `tenants/${getTenantId(t)}/pickup_captures/${eventId}.jpg`;
const storageChaperoneFacePrefix = (chaperoneId, t) =>
  `tenants/${getTenantId(t)}/chaperone_faces/${chaperoneId}`;
const CHAPERONE_EMPLOYEENO_PREFIX = '9';
const isChaperoneEmployeeNo = (employeeNo) =>
  Boolean(employeeNo) && String(employeeNo).startsWith(CHAPERONE_EMPLOYEENO_PREFIX);

// ─── Storage paths ──────────────────────────────────────────────────
const storageFaceDatasetPrefix = (t) => `tenants/${getTenantId(t)}/face_dataset`;
const storageStudentFolder = (homeroom, studentName, t) =>
  `${storageFaceDatasetPrefix(t)}/${homeroom}/${studentName}`;

// ─── Legacy constants (for dual-read window) ────────────────────────
const LEGACY_STUDENTS = 'students';
const LEGACY_STUDENT_METADATA = 'student_metadata';
const LEGACY_FACE_DESCRIPTORS = 'face_descriptors';
const LEGACY_ATTENDANCE = 'attendance';
const LEGACY_STORAGE_PREFIX = 'face_dataset';

module.exports = {
  DEFAULT_TENANT_ID,
  getTenantId,
  tenantAwareEnabled,
  legacyPathsEnabled,
  tenantDoc,
  studentsPath,
  studentMetadataPath,
  faceDescriptorsPath,
  attendanceDayDoc,
  attendanceRecordPath,
  devicesPath,
  consentsPath,
  policyVersionsPath,
  dataRequestsPath,
  erasureLogPath,
  biometricAccessLogPath,
  securityIncidentsPath,
  tenantUsersPath,
  chaperonesPath,
  pickupEventsPath,
  pickupOverridesPath,
  pickupSettingsDoc,
  pickupOnboardingPath,
  idAllocationsDoc,
  storagePickupCapturePath,
  storageChaperoneFacePrefix,
  CHAPERONE_EMPLOYEENO_PREFIX,
  isChaperoneEmployeeNo,
  storageFaceDatasetPrefix,
  storageStudentFolder,
  LEGACY_STUDENTS,
  LEGACY_STUDENT_METADATA,
  LEGACY_FACE_DESCRIPTORS,
  LEGACY_ATTENDANCE,
  LEGACY_STORAGE_PREFIX,
};
