/**
 * Chaperone Hikvision enrollment helper.
 *
 * Used by /api/pickup/admin/approve and /api/pickup/admin/reenroll.
 *
 * Resolution order for which devices to enrol on:
 *   1. tenants/{tid}/settings/pickup.enrollmentDevices = [{ip, passwordEnv, name}]
 *   2. tenants/{tid}/settings/pickup.gates = [{ip, passwordEnv, name, ...}]
 *   3. backend/devices.json (relative to repo root) filtered by enabled === true
 *
 * Password resolution per device:
 *   - device.password (literal, NEVER stored in Firestore in plain text — local only)
 *   - process.env[device.passwordEnv]   (preferred)
 *   - process.env.HIKVISION_PASS         (legacy fallback)
 *
 * The first photo from chaperone.facePaths is downloaded from Storage
 * and pushed to the device via the same multipart ISAPI route used by
 * /api/hikvision/batch-enroll.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { hikRequest, hikJson, isAllowedDeviceIP } from './hikvision';
import { initializeFirebase, getFirebaseStorage } from './firebase-admin';

const tenancy = require('./tenancy');

// ─── Device discovery ──────────────────────────────────────────────────────

function findBackendFile(name) {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'backend', name),
    path.resolve(process.cwd(), '..', 'backend', name),
    path.resolve(process.cwd(), 'backend', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadDevicesJson() {
  const p = findBackendFile('devices.json');
  if (!p) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function loadLocalOverrides() {
  // backend/devices.local.json (gitignored) — name → device dict
  const p = findBackendFile('devices.local.json');
  if (!p) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return {};
    const map = {};
    for (const d of raw) if (d && d.name) map[d.name] = d;
    return map;
  } catch { return {}; }
}

function resolveDevicePassword(d, override) {
  // Mirrors backend/devices_config.py priority order:
  //   1. devices.local.json override
  //   2. per-device env var (passwordEnv / password_env)
  //   3. generic HIKVISION_PASS
  //   4. plaintext password field
  if (override && override.password) return override.password;
  if (d.passwordEnv && process.env[d.passwordEnv]) return process.env[d.passwordEnv];
  if (d.password_env && process.env[d.password_env]) return process.env[d.password_env];
  if (process.env.HIKVISION_PASS) return process.env.HIKVISION_PASS;
  if (d.password) return d.password;
  return null;
}

/**
 * Returns [{ip, username, password, name}] of devices to enrol chaperones on.
 */
export async function resolveEnrollmentDevices(db, tid) {
  const settingsRef = db.doc(tenancy.pickupSettingsDoc(tid));
  const snap = await settingsRef.get();
  const settings = snap.exists ? (snap.data() || {}) : {};

  const candidateLists = [
    settings.enrollmentDevices,
    settings.gates,
  ].filter((arr) => Array.isArray(arr) && arr.length > 0);

  let raw = candidateLists[0];
  if (!raw) {
    raw = loadDevicesJson().filter((d) => d && d.enabled !== false && d.ip);
  }
  const overrides = loadLocalOverrides();

  const username = process.env.HIKVISION_USER || 'admin';
  const out = [];
  for (const d of raw) {
    if (!d || !d.ip) continue;
    if (!isAllowedDeviceIP(d.ip)) continue;
    const ov = overrides[d.name] || null;
    const password = resolveDevicePassword(d, ov);
    if (!password) continue;
    out.push({
      ip: d.ip,
      username: (ov && ov.username) || d.username || username,
      password,
      name: d.name || d.label || d.ip,
    });
  }
  return out;
}

// ─── ISAPI calls (mirrors /api/hikvision/batch-enroll) ─────────────────────

async function createUser(device, employeeNo, name) {
  const body = {
    UserInfo: {
      employeeNo,
      name,
      userType: 'normal',
      gender: 'unknown',
      Valid: {
        enable: true,
        beginTime: '2024-01-01T00:00:00',
        endTime: '2037-12-31T23:59:59',
        timeType: 'local',
      },
      doorRight: '1',
      RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
    },
  };
  try {
    await hikJson(device, 'post', '/ISAPI/AccessControl/UserInfo/Record?format=json', body);
    return { ok: true };
  } catch (e) {
    const respData = e.response?.data;
    const sub = respData?.subStatusCode || respData?.StatusString?.subStatusCode || '';
    if (sub === 'deviceUserAlreadyExist' || sub === 'employeeNoAlreadyExist') {
      return { ok: true, existed: true };
    }
    return { ok: false, error: e.message, details: respData };
  }
}

async function uploadFaceMultipart(device, employeeNo, name, jpegBase64) {
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const jsonPart = JSON.stringify({
    faceLibType: 'blackFD',
    FDID: '1',
    FPID: employeeNo,
    name,
  });
  const parts = [
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="FaceDataRecord"\r\n',
    'Content-Type: application/json\r\n\r\n',
    jsonPart + '\r\n',
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="FaceImage"; filename="face.jpg"\r\n',
    'Content-Type: image/jpeg\r\n\r\n',
  ];
  const header = Buffer.from(parts.join(''));
  const imageData = Buffer.from(jpegBase64, 'base64');
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageData, footer]);

  try {
    const { data } = await hikRequest(
      device,
      'put',
      '/ISAPI/Intelligent/FDLib/FDSetUp?format=json',
      body,
      {
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 30000,
      },
    );
    return { ok: data?.statusCode === 1 || true, data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message };
  }
}

// ─── Storage ────────────────────────────────────────────────────────────────

async function downloadFaceBytes(bucket, facePath) {
  const file = bucket.file(facePath);
  const [exists] = await file.exists();
  if (!exists) throw new Error(`face not in storage: ${facePath}`);
  const [buf] = await file.download();
  return buf;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Enrol a single chaperone on every configured device.
 * Updates chaperones/{id} with deviceEnrolled flag + per-device results.
 *
 * @returns {Promise<{ok: boolean, devices: Array<{name, ip, ok, error?}>}>}
 */
export async function enrollChaperone(db, bucket, tid, chaperoneId) {
  const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`chaperone not found: ${chaperoneId}`);
  const chap = snap.data();

  if (!chap.facePaths || chap.facePaths.length === 0) {
    throw new Error(`chaperone ${chaperoneId} has no facePaths`);
  }

  const devices = await resolveEnrollmentDevices(db, tid);
  const now = new Date().toISOString();

  if (devices.length === 0) {
    await ref.set(
      {
        deviceEnrolled: false,
        deviceEnrollAttemptedAt: now,
        deviceEnrollErrors: ['no enrollment devices configured'],
        deviceEnrollResults: [],
      },
      { merge: true },
    );
    return { ok: false, devices: [], error: 'no enrollment devices configured' };
  }

  // Use the first photo (highest quality assumption — first uploaded)
  const facePath = chap.facePaths[0];
  let jpegBase64;
  try {
    const buf = await downloadFaceBytes(bucket, facePath);
    jpegBase64 = buf.toString('base64');
  } catch (e) {
    await ref.set(
      {
        deviceEnrolled: false,
        deviceEnrollAttemptedAt: now,
        deviceEnrollErrors: [`face download failed: ${e.message}`],
      },
      { merge: true },
    );
    return { ok: false, devices: [], error: e.message };
  }

  const results = [];
  for (const d of devices) {
    const r = { name: d.name, ip: d.ip, ok: false };
    try {
      const u = await createUser(d, chap.employeeNo, chap.name);
      if (!u.ok) {
        r.error = `createUser: ${u.error || 'unknown'}`;
        results.push(r);
        continue;
      }
      r.userExisted = !!u.existed;
      const f = await uploadFaceMultipart(d, chap.employeeNo, chap.name, jpegBase64);
      if (!f.ok) {
        const errMsg = typeof f.error === 'string' ? f.error : JSON.stringify(f.error || {});
        r.error = `uploadFace: ${errMsg.slice(0, 200)}`;
        results.push(r);
        continue;
      }
      r.ok = true;
      results.push(r);
    } catch (e) {
      r.error = e.message;
      results.push(r);
    }
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);
  const errors = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`);

  await ref.set(
    {
      deviceEnrolled: allOk,
      deviceEnrollAttemptedAt: now,
      deviceEnrollResults: results,
      deviceEnrollErrors: errors.length ? errors : null,
    },
    { merge: true },
  );

  return { ok: allOk, devices: results };
}

/**
 * Convenience: enrol a list of chaperone IDs in sequence.
 */
export async function enrollChaperones(db, bucket, tid, chaperoneIds) {
  const summary = [];
  for (const id of chaperoneIds) {
    try {
      const r = await enrollChaperone(db, bucket, tid, id);
      summary.push({ chaperoneId: id, ok: r.ok, devices: r.devices, error: r.error });
    } catch (e) {
      summary.push({ chaperoneId: id, ok: false, error: e.message });
    }
  }
  return summary;
}
