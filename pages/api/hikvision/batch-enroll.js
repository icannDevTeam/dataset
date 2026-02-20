/**
 * POST /api/hikvision/batch-enroll
 *
 * Batch-enrolls students from Firebase Storage to a Hikvision device.
 * The device IP/credentials are sent in the request body (not from env),
 * allowing the portal to connect to any device.
 * Uses HTTP Digest Authentication (required by Hikvision ISAPI).
 *
 * Body: {
 *   device: { ip, username, password },
 *   students: [{ studentName, className, photoUrl, studentId? }]
 * }
 *
 * For each student:
 *   1. Download photo from Firebase signed URL
 *   2. Create user on Hikvision device
 *   3. Upload face via FDLib (base64 in multipart XML)
 */

import axios from 'axios';
import crypto from 'crypto';
import { hikRequest, hikJson } from '../../../lib/hikvision';

function employeeNoFromName(name) {
  return crypto.createHash('md5').update(name).digest('hex').slice(0, 8).toUpperCase();
}

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
    const sub = respData?.subStatusCode
      || respData?.StatusString?.subStatusCode
      || '';
    if (sub === 'deviceUserAlreadyExist' || sub === 'employeeNoAlreadyExist') {
      return { ok: true, existed: true };
    }
    return { ok: false, error: e.message, details: respData };
  }
}

async function uploadFaceBase64(device, employeeNo, name, jpegBase64) {
  // Use the multipart ISAPI endpoint that accepts base64-encoded face data
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');

  const jsonPart = JSON.stringify({
    faceLibType: 'blackFD',
    FDID: '1',
    FPID: employeeNo,
    name,
  });

  // Build multipart body
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
    const { data } = await hikRequest(device, 'put', '/ISAPI/Intelligent/FDLib/FDSetUp?format=json', body, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 30000,
    });
    return { ok: data?.statusCode === 1 || true, data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { device, students } = req.body;

  if (!device?.ip || !device?.username || !device?.password) {
    return res.status(400).json({ error: 'Missing device credentials (ip, username, password)' });
  }

  // SSRF protection — only allow private LAN IPs
  const { isAllowedDeviceIP } = await import('../../../lib/hikvision');
  if (!isAllowedDeviceIP(device.ip)) {
    return res.status(400).json({ error: 'Invalid device IP. Only private LAN addresses are allowed.' });
  }

  if (!students || !Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: 'No students to enroll' });
  }

  const results = [];

  for (const student of students) {
    const { studentName, className, photoUrl, studentId } = student;
    const employeeNo = employeeNoFromName(studentName);
    const result = {
      studentName,
      className,
      employeeNo,
      steps: {},
    };

    try {
      console.log(`\nEnrolling: ${studentName} (${employeeNo}) - ${className}`);

      // Step 1: Download photo from Firebase signed URL
      let jpegBase64;
      try {
        const imgResponse = await axios.get(photoUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
        });
        jpegBase64 = Buffer.from(imgResponse.data).toString('base64');
        result.steps.download = { ok: true, size: imgResponse.data.length };
        console.log(`  Downloaded: ${imgResponse.data.length} bytes`);
      } catch (dlErr) {
        result.steps.download = { ok: false, error: dlErr.message };
        result.success = false;
        result.error = 'Failed to download photo';
        results.push(result);
        continue;
      }

      // Step 2: Create user on device
      const userResult = await createUser(device, employeeNo, studentName);
      result.steps.createUser = userResult;
      if (!userResult.ok) {
        result.success = false;
        result.error = 'Failed to create user on device';
        results.push(result);
        continue;
      }
      console.log(`  User: ${userResult.existed ? 'already exists' : 'created'}`);

      // Step 3: Upload face via base64 multipart
      const faceResult = await uploadFaceBase64(device, employeeNo, studentName, jpegBase64);
      result.steps.uploadFace = faceResult;
      if (!faceResult.ok) {
        result.success = false;
        result.error = 'Device rejected face image';
        results.push(result);
        continue;
      }
      console.log(`  Face enrolled on device`);

      result.success = true;
    } catch (err) {
      result.success = false;
      result.error = err.message;
    }

    results.push(result);
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  return res.status(200).json({
    success: failCount === 0,
    message: `Enrolled ${successCount}/${students.length} students (${failCount} failed)`,
    results,
  });
}
