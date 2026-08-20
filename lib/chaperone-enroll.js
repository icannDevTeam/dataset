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
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { hikRequest, hikJson, isAllowedDeviceIP } from './hikvision.js';
import { initializeFirebase, getFirebaseStorage } from './firebase-admin.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    for (const d of raw) {
      if (!d || !d.name) continue;
      map[d.name] = d;
      map[normalizeDeviceName(d.name)] = d;
    }
    return map;
  } catch { return {}; }
}

function normalizeDeviceName(value) {
  const raw = String(value || '').trim().toLowerCase();
  const parts = raw.split(/\s+/);
  if (parts.length === 2 && parts[0] === 'terminal' && /^\d+$/.test(parts[1])) {
    return `terminal ${Number(parts[1])}`;
  }
  return raw;
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
 * Map a free-form gradeLabel string from the terminals registry into a
 * gradeScopes array. Examples:
 *   'Grade 4'   → ['4']
 *   '4-6'       → ['4','5','6']
 *   '1,2,3'     → ['1','2','3']
 *   'all'       → []   (= shared gate, every grade)
 *   null/empty  → []
 */
function parseGradeLabel(label) {
  if (!label) return [];
  const s = String(label).trim().toLowerCase();
  if (!s || s === 'all' || s === 'shared' || s === 'any') return [];

  const out = new Set();

  const range = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
  if (range) {
    const [a, b] = [parseInt(range[1], 10), parseInt(range[2], 10)].sort((x, y) => x - y);
    for (let g = a; g <= b; g += 1) out.add(String(g));
  }

  // Accept letter-only and alphanumeric class labels too (e.g. A, 4A, 10B).
  for (const m of s.toUpperCase().matchAll(/\b\d+[A-Z]?\b|\b[A-Z]\b/g)) {
    out.add(m[0]);
  }
  return Array.from(out);
}

function normalizeTerminalId(value) {
  const s = String(value || '').trim();
  return s || null;
}

function expandScopeToken(token) {
  const t = String(token || '').trim().toUpperCase();
  if (!t) return [];
  const out = [t];

  // 4A -> [4A, 4, A] so class-only or grade-only terminal labels can match.
  const classMatch = t.match(/^(\d+)([A-Z])$/);
  if (classMatch) {
    out.push(classMatch[1]);
    out.push(classMatch[2]);
  }

  return out;
}

function normalizeScopes(scopes) {
  const out = new Set();
  for (const raw of scopes || []) {
    const value = String(raw || '').trim().toUpperCase();
    if (!value) continue;
    if (/^EY\d+$/.test(value)) {
      out.add(value);
      out.add('EY');
      continue;
    }
    for (const token of expandScopeToken(raw)) out.add(token);
  }
  return Array.from(out);
}

/**
 * Read terminals from the v2 terminal-registry collection
 * (tenants/{tid}/terminals). This is what /v2/terminals.js writes to.
 */
async function loadTerminalsCollection(db, tid) {
  try {
    const snap = await db.collection(tenancy.terminalsPath(tid)).get();
    const out = [];
    snap.forEach((d) => {
      const t = d.data() || {};
      if (!t.ip) return;
      if (t.enabled === false) return;
      // Prefer the canonical `gradeScopes` array (string[] like ['1','2','5']).
      // Fall back to parsing the legacy free-text `gradeLabel` for old docs.
      let scopes;
      if (Array.isArray(t.gradeScopes)) {
        scopes = t.gradeScopes.map(String).map((s) => s.trim()).filter(Boolean);
      } else {
        scopes = parseGradeLabel(t.gradeLabel);
      }
      out.push({
        terminalId: d.id,
        name: t.name || t.deviceName || t.ip,
        ip: t.ip,
        gradeScopes: scopes,
        section: t.gateLabel || null,
        enabled: true,
      });
    });
    return out;
  } catch { return []; }
}

/**
 * Returns [{ip, username, password, name}] of devices to enrol chaperones on.
 *
 * Sources, in priority (later sources overwrite earlier on IP collision):
 *   1. backend/devices.json                       (local repo bootstrap)
 *   2. tenants/{tid}/settings/pickup.gates        (legacy settings doc)
 *   3. tenants/{tid}/settings/pickup.enrollmentDevices (legacy settings doc)
 *   4. tenants/{tid}/terminals (collection)       (v2 terminals UI — authoritative)
 */
export async function resolveEnrollmentDevices(db, tid) {
  const settingsRef = db.doc(tenancy.pickupSettingsDoc(tid));
  const snap = await settingsRef.get();
  const settings = snap.exists ? (snap.data() || {}) : {};

  const sources = [];
  sources.push(loadDevicesJson().filter((d) => d && d.enabled !== false && d.ip));
  if (Array.isArray(settings.gates))             sources.push(settings.gates);
  if (Array.isArray(settings.enrollmentDevices)) sources.push(settings.enrollmentDevices);
  sources.push(await loadTerminalsCollection(db, tid));

  // Merge by IP — later sources fill in missing fields without losing
  // earlier credentials/grade info.
  const byIp = new Map();
  for (const list of sources) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (!d || !d.ip) continue;
      const prev = byIp.get(d.ip) || {};
      byIp.set(d.ip, {
        ...prev,
        ...d,
        terminalId: normalizeTerminalId(d.terminalId) || prev.terminalId || null,
        gradeScopes: (Array.isArray(d.gradeScopes) && d.gradeScopes.length
          ? d.gradeScopes
          : prev.gradeScopes) || [],
        // preserve credential fields from earlier sources if newer one omits them
        password: d.password || prev.password,
        passwordEnv: d.passwordEnv || d.password_env || prev.passwordEnv,
        username: d.username || prev.username,
      });
    }
  }

  const overrides = loadLocalOverrides();
  const username = process.env.HIKVISION_USER || 'admin';
  const out = [];
  for (const d of byIp.values()) {
    if (!isAllowedDeviceIP(d.ip)) continue;
    const ov = overrides[d.name] || overrides[normalizeDeviceName(d.name)] || null;
    const password = resolveDevicePassword(d, ov);
    if (!password) continue;
    out.push({
      ip: d.ip,
      username: (ov && ov.username) || d.username || username,
      password,
      terminalId: normalizeTerminalId(d.terminalId),
      name: d.name || d.label || d.ip,
      gradeScopes: Array.isArray(d.gradeScopes) ? d.gradeScopes.map(String) : [],
      section: d.section || null,
    });
  }
  return out;
}

/**
 * Filter a device list against a chaperone's grade scope.
 *
 *   - device.gradeScopes = []  → device matches every grade (shared gate).
 *   - chaperoneGrades = []     → we don't know the grade, fall back to all
 *                                  devices (preserves old behavior).
 *   - otherwise                 → match if intersection is non-empty.
 */
function filterDevicesForGrades(devices, chaperoneScopes) {
  const scopes = normalizeScopes(chaperoneScopes);
  // Strict mode: if the chaperone's grade/class scope is unknown, do not
  // spray the enrolment across every terminal. Shared gates still match
  // because a device with empty gradeScopes is treated as universal below.
  if (scopes.length === 0) return [];
  return devices.filter((d) => {
    if (!d.gradeScopes || d.gradeScopes.length === 0) return true; // shared gate
    const deviceScopes = normalizeScopes(d.gradeScopes);
    return deviceScopes.some((g) => scopes.includes(g));
  });
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

async function deleteFace(device, employeeNo) {
  // Hikvision face delete by FPID (FDDelete matches DS-K1T341AMF firmware;
  // FDSearch/Delete with FPID array returns statusCode 6 "Invalid Content").
  const body = {
    faceLibType: 'blackFD',
    FDID: '1',
    FPID: String(employeeNo),
  };
  try {
    await hikJson(device, 'put', '/ISAPI/Intelligent/FDLib/FDDelete?format=json', body);
    return { ok: true };
  } catch (e) {
    const d = e.response?.data;
    // statusCode 4 "Invalid Operation" = no matching face record — already removed.
    if (d && (d.statusCode === 4 || /invalid operation/i.test(d.statusString || ''))) {
      return { ok: true, note: 'no face record on device' };
    }
    return { ok: false, error: d || e.message };
  }
}

async function deleteUser(device, employeeNo) {
  // Remove the access-control user record itself (revokes door rights).
  const body = {
    UserInfoDelCond: {
      EmployeeNoList: [{ employeeNo: String(employeeNo) }],
    },
  };
  try {
    await hikJson(device, 'put', '/ISAPI/AccessControl/UserInfo/Delete?format=json', body);
    return { ok: true };
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

async function prepareFaceForDevice(buf) {
  // Hikvision constraints (root-caused 2026-07-30):
  //  • photos >200KB are rejected (misleading badJsonFormat "faceURL" error)
  //  • photos <~400px longest side fail face modeling (PicFeaturePoints /
  //    SubpicAnalysisModelingError)
  // Auto-normalize IN MEMORY at enroll time: resize into range and
  // recompress. The stored photo in Storage is never modified.
  const dim = jpegDimensions(buf);
  const longest = dim ? Math.max(dim.width, dim.height) : null;
  const tooBig = buf.length > 185 * 1024;
  const tooSmall = longest !== null && longest < 400;
  if (!tooBig && !tooSmall) {
    return {
      buffer: buf,
      width: dim?.width || null,
      height: dim?.height || null,
      bytes: buf.length,
    };
  }

  const sharp = require('sharp');
  const targetDim = tooSmall ? Math.min(900, Math.max(600, longest * 3)) : 900;
  let out = null;
  for (const q of [90, 85, 80, 75, 70, 60]) {
    let pipeline = sharp(buf).rotate(); // honour EXIF orientation
    pipeline = tooSmall
      ? pipeline.resize({ width: targetDim, height: targetDim, fit: 'inside' })
      : pipeline.resize({ width: targetDim, height: targetDim, fit: 'inside', withoutEnlargement: true });
    out = await pipeline.jpeg({ quality: q }).toBuffer();
    if (out.length <= 185 * 1024) break;
  }
  if (!out || out.length > 195 * 1024) {
    throw new Error(
      `face photo could not be normalized under the 200KB terminal limit ` +
      `(source ${Math.round(buf.length / 1024)}KB) — replace the photo and retry`
    );
  }
  const outDim = jpegDimensions(out);
  return {
    buffer: out,
    width: outDim?.width || null,
    height: outDim?.height || null,
    bytes: out.length,
  };
}

// Parse JPEG SOFn marker for pixel dimensions (no image lib needed).
// Returns { width, height } or null if not parseable.
function jpegDimensions(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0-SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Enrol a single chaperone on every configured device that matches the
 * chaperone's grade scope.
 *
 * @param {object} opts
 * @param {string[]} [opts.gradeFilter]  Only enrol on devices whose gradeScopes
 *                                       intersect this list. If omitted, the
 *                                       chaperone's `studentGrades` field on
 *                                       Firestore is used.
 * @param {string[]} [opts.deviceIps]    Optional explicit device IP whitelist.
 * @returns {Promise<{ok: boolean, devices: Array<{name, ip, ok, error?}>}>}
 */
export async function enrollChaperone(db, bucket, tid, chaperoneId, opts = {}) {
  const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`chaperone not found: ${chaperoneId}`);
  const chap = snap.data();

  if (!chap.facePaths || chap.facePaths.length === 0) {
    // No face photos uploaded yet — mark as pending-photo and skip device
    // enrollment instead of throwing. Admin can re-enroll once a photo is added.
    const skipAt = new Date().toISOString();
    await ref.set(
      {
        deviceEnrolled: false,
        deviceEnrollAttemptedAt: skipAt,
        deviceEnrollErrors: ['no face photo uploaded — add a photo and re-enroll'],
        deviceEnrollResults: [],
      },
      { merge: true },
    );
    return { ok: false, devices: [], error: 'no face photo uploaded' };
  }

  const allDevices = await resolveEnrollmentDevices(db, tid);
  const allowedTerminalIds = Array.isArray(chap.allowedTerminalIds)
    ? [...new Set(chap.allowedTerminalIds.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  const overrideActive = chap.assignmentMode === 'override' && allowedTerminalIds.length > 0;
  const scopes = Array.isArray(opts.gradeFilter) && opts.gradeFilter.length > 0
    ? opts.gradeFilter
    : [
      ...(Array.isArray(chap.studentGrades) ? chap.studentGrades : []),
      ...(Array.isArray(chap.studentClasses) ? chap.studentClasses : []),
    ];
  let devices;
  if (Array.isArray(opts.deviceIps) && opts.deviceIps.length > 0) {
    const ipSet = new Set(opts.deviceIps);
    devices = allDevices.filter((d) => ipSet.has(d.ip));
  } else if (overrideActive && (!Array.isArray(opts.gradeFilter) || opts.gradeFilter.length === 0)) {
    const allowed = new Set(allowedTerminalIds);
    devices = allDevices.filter((d) => d.terminalId && allowed.has(d.terminalId));
  } else {
    devices = filterDevicesForGrades(allDevices, scopes);
  }
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

  let faceCandidates = [];
  try {
    const seen = new Set();
    for (const facePath of chap.facePaths) {
      if (!facePath || seen.has(facePath)) continue;
      seen.add(facePath);
      try {
        const raw = await downloadFaceBytes(bucket, facePath);
        const prepared = await prepareFaceForDevice(raw);
        faceCandidates.push({
          path: facePath,
          width: prepared.width,
          height: prepared.height,
          bytes: prepared.bytes,
          jpegBase64: prepared.buffer.toString('base64'),
        });
      } catch (photoErr) {
        // Skip invalid image variants and continue with remaining photos.
        console.warn(`[chaperone-enroll] skip facePath=${facePath}: ${photoErr.message}`);
      }
    }
    // Prefer higher-detail images first so terminals can extract landmarks.
    faceCandidates.sort((a, b) => {
      const aScore = (a.width || 0) * (a.height || 0);
      const bScore = (b.width || 0) * (b.height || 0);
      if (bScore !== aScore) return bScore - aScore;
      return (b.bytes || 0) - (a.bytes || 0);
    });
    if (faceCandidates.length === 0) {
      throw new Error('no valid face image candidates after normalization');
    }
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
      let f = null;
      let lastErr = null;
      for (const candidate of faceCandidates) {
        f = await uploadFaceMultipart(d, chap.employeeNo, chap.name, candidate.jpegBase64);
        if (!f.ok) {
          const errStr = typeof f.error === 'string' ? f.error : JSON.stringify(f.error || {});
          // Retry once if the device says the face row already exists / DB write
          // collision — delete the existing face and re-upload.
          if (/writeDatabaseError|saveFacePic|alreadyExist|FPIDAlreadyExist/i.test(errStr)) {
            await deleteFace(d, chap.employeeNo);
            f = await uploadFaceMultipart(d, chap.employeeNo, chap.name, candidate.jpegBase64);
            if (f.ok) r.faceReplaced = true;
          }
          if (!f.ok) {
            lastErr = errStr;
            // Keep trying alternate uploaded photos when Hikvision cannot model
            // the current one (PicFeaturePoints/SubpicAnalysisModelingError).
            if (/PicFeaturePoints|SubpicAnalysisModelingError|badJsonFormat|Invalid Content/i.test(errStr)) {
              continue;
            }
          }
        }
        if (f.ok) {
          r.facePathUsed = candidate.path;
          break;
        }
      }
      if (!f || !f.ok) {
        const errMsg = String(lastErr || (typeof f?.error === 'string' ? f.error : JSON.stringify(f?.error || {})));
        r.error = `uploadFace: ${errMsg.slice(0, 220)}`;
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
 * Accepts the same options as enrollChaperone (forwarded per-id).
 */
export async function enrollChaperones(db, bucket, tid, chaperoneIds, opts = {}) {
  const summary = [];
  for (const id of chaperoneIds) {
    try {
      const r = await enrollChaperone(db, bucket, tid, id, opts);
      summary.push({
        chaperoneId: id,
        ok: r.ok,
        devices: r.devices,
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (e) {
      summary.push({ chaperoneId: id, ok: false, error: e.message });
    }
  }
  return summary;
}

/**
 * Remove a chaperone from every configured device: delete the face record
 * and the access-control user (revokes door rights). Best-effort per device —
 * unreachable devices are reported, not fatal.
 *
 * Targets ALL resolved devices (not just grade-matched ones) so stale
 * enrolments from earlier scope changes are cleaned up too. Pass
 * `opts.deviceIps` to restrict removal to specific terminals.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.deviceIps]  Only remove from these device IPs.
 * @returns {Promise<{ok: boolean, devices: Array<{name, ip, ok, error?}>}>}
 */
export async function unenrollChaperone(db, tid, chaperoneId, opts = {}) {
  const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`chaperone not found: ${chaperoneId}`);
  const chap = snap.data();
  if (!chap.employeeNo) {
    return { ok: true, devices: [], note: 'no employeeNo — never device-enrolled' };
  }

  let devices = await resolveEnrollmentDevices(db, tid);
  if (Array.isArray(opts.deviceIps) && opts.deviceIps.length > 0) {
    const ipSet = new Set(opts.deviceIps.map(String));
    devices = devices.filter((d) => ipSet.has(d.ip));
    if (devices.length === 0) {
      return { ok: false, devices: [], error: 'no matching devices for given deviceIps' };
    }
  }
  const now = new Date().toISOString();
  const results = [];
  for (const d of devices) {
    const r = { name: d.name, ip: d.ip, ok: false };
    try {
      const f = await deleteFace(d, chap.employeeNo);
      const u = await deleteUser(d, chap.employeeNo);
      r.ok = f.ok && u.ok;
      if (!r.ok) {
        const errs = [];
        if (!f.ok) errs.push(`deleteFace: ${typeof f.error === 'string' ? f.error : JSON.stringify(f.error || {})}`);
        if (!u.ok) errs.push(`deleteUser: ${typeof u.error === 'string' ? u.error : JSON.stringify(u.error || {})}`);
        r.error = errs.join('; ').slice(0, 300);
      }
    } catch (e) {
      r.error = e.message;
    }
    results.push(r);
  }

  const allOk = results.every((r) => r.ok);
  // Only flip deviceEnrolled to false on a full removal (no deviceIps filter)
  // — a partial removal leaves the chaperone enrolled on other terminals.
  const partial = Array.isArray(opts.deviceIps) && opts.deviceIps.length > 0;
  await ref.set(
    {
      ...(partial ? {} : { deviceEnrolled: false }),
      deviceUnenrollAttemptedAt: now,
      deviceUnenrollResults: results,
    },
    { merge: true },
  );

  return { ok: allOk, devices: results };
}
