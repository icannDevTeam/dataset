/**
 * Tenant config loader — Phase A2.
 *
 * Reads `tenants/{tenantId}/settings/config` and caches it for 60s in-process
 * to avoid hammering Firestore from every API request. Refresh by calling
 * `loadTenantConfig({ force: true })`.
 *
 * Falls back to DEFAULT_TENANT_CONFIG (mirrored in backend/tenancy.py) if the
 * doc doesn't exist yet, so the system never crashes during initial setup.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from './firebase-admin';
import { getTenantId, tenantDoc } from './tenancy';

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // tenantId -> { value, fetchedAt }

const DEFAULT_TENANT_CONFIG = {
  name: 'BINUS School Simprug',
  slug: 'binus-simprug',
  timezone: 'Asia/Jakarta',
  lateCutoffHHmm: '07:30',
  geofence: {
    type: 'radius',
    centerLat: -6.2349,
    centerLng: 106.7956,
    radiusMeters: 250,
  },
  branding: {
    schoolName: 'BINUS School',
    logoUrl: '/logo.jpg',
    primaryColor: '#1e40af',
  },
  downstreamSink: { type: 'binus', config: {} },
  dataRetention: {
    attendanceDays: 365 * 7,
    photoDays: 365,
    spoofLogDays: 90,
    accessLogDays: 365,
  },
  currentPolicyVersionId: null,
};

export async function loadTenantConfig({ tenantId, force = false } = {}) {
  initializeFirebase();
  const tid = getTenantId(tenantId);
  const cached = cache.get(tid);
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  const db = admin.firestore();
  const snap = await db.doc(`${tenantDoc(tid)}/settings/config`).get();
  const value = snap.exists
    ? { ...DEFAULT_TENANT_CONFIG, ...snap.data(), slug: tid }
    : { ...DEFAULT_TENANT_CONFIG, slug: tid };
  cache.set(tid, { value, fetchedAt: now });
  return value;
}

/** Synchronously read whatever is cached (or default). Never hits Firestore. */
export function getCachedTenantConfig(tenantId) {
  const tid = getTenantId(tenantId);
  const cached = cache.get(tid);
  return cached ? cached.value : { ...DEFAULT_TENANT_CONFIG, slug: tid };
}

export function clearTenantConfigCache(tenantId) {
  if (tenantId) cache.delete(getTenantId(tenantId));
  else cache.clear();
}

export { DEFAULT_TENANT_CONFIG };
