/**
 * POST /api/hikvision/users
 *
 * Returns all enrolled users on the Hikvision device, enriched with
 * metadata from Firestore (grade, homeroom, Binusian ID, etc.).
 *
 * Body: { device: { ip, username, password } }
 *
 * Returns: { users: [...], device: {...}, capacity: {...} }
 */

import { hikRequest, hikJson, isAllowedDeviceIP } from '../../../lib/hikvision';
import { initializeFirebase, getFirebaseAdmin } from '../../../lib/firebase-admin';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { device } = req.body;

  if (!device?.ip || !device?.username || !device?.password) {
    return res.status(400).json({ error: 'Missing device credentials' });
  }

  if (!isAllowedDeviceIP(device.ip)) {
    return res.status(400).json({ error: 'Invalid device IP. Only private LAN addresses are allowed.' });
  }

  try {
    // 1. Fetch all users from device (paginated)
    const allUsers = [];
    let pos = 0;
    const batch = 30;

    while (true) {
      const body = {
        UserInfoSearchCond: {
          searchID: 'device_mgr',
          searchResultPosition: pos,
          maxResults: batch,
        },
      };
      const data = await hikJson(device, 'post', '/ISAPI/AccessControl/UserInfo/Search?format=json', body);
      const info = data?.UserInfoSearch || {};
      let userList = info.UserInfo || [];
      if (!Array.isArray(userList)) userList = [userList];

      for (const u of userList) {
        allUsers.push({
          employeeNo: u.employeeNo || '',
          name: u.name || '',
          userType: u.userType || '',
          numOfFace: u.numOfFace || 0,
          numOfCard: u.numOfCard || 0,
          numOfFP: u.numOfFP || 0,
        });
      }

      const total = parseInt(info.totalMatches || '0', 10);
      pos += userList.length;
      if (pos >= total || userList.length === 0) break;
    }

    // 2. Enrich with Firestore student_metadata
    let metadataMap = {};
    try {
      initializeFirebase();
      const admin = getFirebaseAdmin();
      const db = admin.firestore();
      const snap = await db.collection('student_metadata').get();
      snap.forEach((doc) => {
        const d = doc.data();
        // Map by employeeNo (document ID or field)
        const empNo = d.employeeNo || doc.id;
        metadataMap[empNo] = {
          grade: d.grade || d.gradeName || '',
          homeroom: d.homeroom || d.className || '',
          idStudent: d.idStudent || d.IdStudent || '',
          idBinusian: d.idBinusian || d.IdBinusian || '',
          studentId: d.studentId || doc.id || '',
        };
      });
    } catch (e) {
      console.warn('Firestore metadata fetch (non-fatal):', e.message);
    }

    // 3. Also try the students collection for additional data
    try {
      const admin = getFirebaseAdmin();
      const db = admin.firestore();
      const snap = await db.collection('students').get();
      snap.forEach((doc) => {
        const d = doc.data();
        const empNo = d.employeeNo || doc.id;
        if (!metadataMap[empNo]) {
          metadataMap[empNo] = {
            grade: d.grade || '',
            homeroom: d.homeroom || d.className || '',
            idStudent: '',
            idBinusian: '',
            studentId: doc.id,
          };
        }
      });
    } catch (e) {
      // Non-fatal
    }

    // 4. Merge device users with metadata
    const enrichedUsers = allUsers.map((u) => {
      const meta = metadataMap[u.employeeNo] || {};
      return {
        ...u,
        grade: meta.grade || '',
        homeroom: meta.homeroom || '',
        idStudent: meta.idStudent || '',
        idBinusian: meta.idBinusian || '',
        studentId: meta.studentId || '',
      };
    });

    // 5. Device info
    let deviceInfo = {};
    try {
      const { data: xml } = await hikRequest(device, 'get', '/ISAPI/System/deviceInfo', null, {
        headers: { 'Content-Type': 'application/xml' },
        timeout: 10000,
      });
      const extract = (tag) => {
        const m = String(xml).match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
        return m ? m[1] : '';
      };
      deviceInfo = {
        model: extract('model'),
        deviceName: extract('deviceName'),
        firmware: extract('firmwareVersion'),
        serial: extract('serialNumber'),
        mac: extract('macAddress'),
      };
    } catch (e) {
      deviceInfo = { error: e.message };
    }

    // 6. Capacity
    let capacity = {};
    try {
      const data = await hikJson(device, 'get', '/ISAPI/AccessControl/UserInfo/capabilities?format=json');
      capacity = {
        maxUsers: data?.UserInfoCap?.maxUserNum || 0,
        maxFaces: data?.UserInfoCap?.maxFaceNum || 0,
      };
    } catch (e) { /* ignore */ }

    return res.status(200).json({
      success: true,
      users: enrichedUsers,
      total: enrichedUsers.length,
      device: deviceInfo,
      capacity,
    });
  } catch (error) {
    console.error('Device users error:', error.message);
    return res.status(500).json({
      error: 'Failed to fetch device users',
      details: error.message,
    });
  }
}
