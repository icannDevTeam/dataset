/**
 * POST /api/hikvision/enroll
 *
 * Enrolls a student's face on the Hikvision device.
 * Expects: { studentId, studentName, homeroom, imageBase64 }
 *
 * Steps:
 *   1. Create user on device (if not exists)
 *   2. Save face image to a temp file, serve via built-in HTTP
 *   3. Call FDLib/FDSetUp with faceURL → device downloads & extracts embeddings
 *   4. Upload face to Firebase Storage as backup
 */

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { initializeFirebase, getFirebaseStorage } from '../../../lib/firebase-admin';
import os from 'os';
import net from 'net';

const HIK_IP = process.env.HIKVISION_IP || '10.26.30.200';
const HIK_USER = process.env.HIKVISION_USER || 'admin';
const HIK_PASS = process.env.HIKVISION_PASS || 'password.123';
const HIK_BASE = `http://${HIK_IP}`;
const SERVE_PORT = 8889; // Temp HTTP server port (different from Python's 8888)

function employeeNoFromName(name) {
  return crypto.createHash('md5').update(name).digest('hex').slice(0, 8).toUpperCase();
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Prefer the interface on the same subnet as the Hikvision device
        const hikSubnet = HIK_IP.split('.').slice(0, 3).join('.');
        const mySubnet = iface.address.split('.').slice(0, 3).join('.');
        if (mySubnet === hikSubnet) return iface.address;
      }
    }
  }
  // Fallback: first non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

async function hikApi(method, apiPath, data = null, extraOpts = {}) {
  const opts = {
    method,
    url: `${HIK_BASE}${apiPath}`,
    auth: { username: HIK_USER, password: HIK_PASS },
    timeout: 15000,
    ...extraOpts,
  };
  if (data) opts.data = data;
  if (!opts.headers) opts.headers = { 'Content-Type': 'application/json' };
  const r = await axios(opts);
  return { status: r.status, data: r.data };
}

async function createUser(employeeNo, name) {
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
    const { data } = await hikApi('post', '/ISAPI/AccessControl/UserInfo/Record?format=json', body);
    return data?.statusCode === 1;
  } catch (e) {
    // User may already exist — check for duplicate
    if (e.response?.data?.subStatusCode === 'deviceUserAlreadyExist') return true;
    console.error('Create user error:', e.message);
    return false;
  }
}

async function uploadFace(employeeNo, name, faceUrl) {
  const body = {
    faceLibType: 'blackFD',
    FDID: '1',
    FPID: employeeNo,
    name,
    faceURL: faceUrl,
  };
  try {
    const { data } = await hikApi('put', '/ISAPI/Intelligent/FDLib/FDSetUp?format=json', body);
    return data?.statusCode === 1;
  } catch (e) {
    console.error('FDLib upload error:', e.message);
    return false;
  }
}

/** Start a one-shot HTTP server to serve a single file, then shut down. */
function serveFaceFile(filePath, port) {
  return new Promise((resolve, reject) => {
    const localIP = getLocalIP();
    const fileName = path.basename(filePath);

    const srv = http.createServer((req, res) => {
      if (req.url === '/' + fileName) {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': data.length,
        });
        res.end(data);
        // Shut down after serving
        setTimeout(() => srv.close(), 500);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port busy — try next port
        srv.listen(port + 1, '0.0.0.0');
      } else {
        reject(err);
      }
    });

    srv.on('listening', () => {
      const actualPort = srv.address().port;
      const url = `http://${localIP}:${actualPort}/${fileName}`;
      resolve({ server: srv, url });
    });

    srv.listen(port, '0.0.0.0');
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { studentId, studentName, homeroom, gradeCode, gradeName, imageBase64 } = req.body;

  if (!studentName || !imageBase64) {
    return res.status(400).json({ error: 'Missing studentName or imageBase64' });
  }

  const employeeNo = employeeNoFromName(studentName);
  console.log(`\n📝 Enrolling: ${studentName} (${employeeNo}) — ${homeroom}`);

  try {
    // Step 1: Create user on device
    const userOk = await createUser(employeeNo, studentName);
    if (!userOk) {
      return res.status(502).json({ error: 'Failed to create user on Hikvision device' });
    }
    console.log('✅ User created/exists on device');

    // Step 2: Save image to temp file
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = Buffer.from(base64Data, 'base64');
    const tmpDir = path.join(os.tmpdir(), 'hik_enroll');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${employeeNo}_face.jpg`);
    fs.writeFileSync(tmpFile, imgBuffer);
    console.log(`📁 Saved temp file: ${tmpFile} (${imgBuffer.length} bytes)`);

    // Step 3: Serve file via temp HTTP server → device downloads it
    let faceServer;
    try {
      faceServer = await serveFaceFile(tmpFile, SERVE_PORT);
      console.log(`🌐 Serving face at: ${faceServer.url}`);

      const faceOk = await uploadFace(employeeNo, studentName, faceServer.url);
      // Give device a moment to download
      await new Promise((r) => setTimeout(r, 2000));

      if (!faceOk) {
        return res.status(502).json({ error: 'Device rejected face image' });
      }
      console.log('✅ Face enrolled on device');
    } finally {
      try { faceServer?.server?.close(); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    }

    // Step 4: Upload to Firebase Storage as backup
    let firebaseUrl = null;
    try {
      initializeFirebase();
      const storage = getFirebaseStorage();
      const bucket = storage.bucket();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const blobPath = `face_dataset/${homeroom || 'unknown'}/${studentName}/${ts}_device_capture.jpg`;
      const file = bucket.file(blobPath);
      await file.save(imgBuffer, { metadata: { contentType: 'image/jpeg' } });
      firebaseUrl = `gs://${process.env.FIREBASE_STORAGE_BUCKET}/${blobPath}`;
      console.log(`☁️  Firebase backup: ${blobPath}`);
    } catch (fbErr) {
      console.warn('⚠️  Firebase backup failed (non-fatal):', fbErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `${studentName} enrolled successfully`,
      employeeNo,
      firebaseUrl,
    });
  } catch (error) {
    console.error('Enrollment error:', error.message);
    return res.status(500).json({
      error: 'Enrollment failed',
      details: error.message,
    });
  }
}
