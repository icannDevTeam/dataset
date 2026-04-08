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
import { withMetrics } from '../../../lib/metrics';
import { withAuth } from '../../../lib/auth-middleware';

async function handler(req, res) {
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

    // 2. Enrich with Firestore student_metadata + students collections
    //    Uses three lookup strategies:
    //    a) Direct match by employeeNo (works for Python Firebase pipeline)
    //    b) linkedTo resolution (HEX card IDs → real student entry)
    //    c) Name-based fallback (MD5 employeeNo → match by student name)
    let metadataMap = {};  // employeeNo → metadata
    let nameMap = {};      // name → metadata (fallback)
    let linkedMap = {};    // employeeNo → linkedTo employeeNo
    try {
      initializeFirebase();
      const admin = getFirebaseAdmin();
      const db = admin.firestore();
      const [metaSnap, studentsSnap] = await Promise.all([
        db.collection('student_metadata').get(),
        db.collection('students').get(),
      ]);

      // Build from student_metadata
      metaSnap.forEach((doc) => {
        const d = doc.data();
        const empNo = d.employeeNo || doc.id;
        metadataMap[empNo] = {
          grade: d.grade || d.gradeName || '',
          homeroom: d.homeroom || d.className || '',
          idStudent: d.idStudent || d.IdStudent || '',
          idBinusian: d.idBinusian || d.IdBinusian || '',
          studentId: d.studentId || doc.id || '',
        };
        // Track linkedTo for HEX card ID resolution
        if (d.linkedTo) linkedMap[empNo] = d.linkedTo;
        // Name-based fallback (only store if entry has homeroom)
        if (d.name && d.homeroom) {
          nameMap[d.name] = metadataMap[empNo];
        }
      });

      // Build from students collection (keyed by studentId)
      studentsSnap.forEach((doc) => {
        const d = doc.data();
        const id = doc.id;
        if (!metadataMap[id]) {
          metadataMap[id] = {
            grade: d.gradeCode || d.grade || '',
            homeroom: d.homeroom || d.className || '',
            idStudent: '',
            idBinusian: '',
            studentId: id,
          };
        } else {
          // Fill in gaps
          if (!metadataMap[id].homeroom && d.homeroom) metadataMap[id].homeroom = d.homeroom;
          if (!metadataMap[id].grade && (d.gradeCode || d.grade)) metadataMap[id].grade = d.gradeCode || d.grade;
        }
        if (d.name && d.homeroom && !nameMap[d.name]) {
          nameMap[d.name] = metadataMap[id];
        }
      });
    } catch (e) {
      console.warn('Firestore metadata fetch (non-fatal):', e.message);
    }

    // 3. Merge device users with metadata (multi-strategy lookup)
    const enrichedUsers = allUsers.map((u) => {
      // Strategy a: direct employeeNo match
      let meta = metadataMap[u.employeeNo];

      // Strategy b: resolve linkedTo (HEX card → real student entry)
      //   Fill in any gaps (idStudent, idBinusian, homeroom, grade)
      if (meta && linkedMap[u.employeeNo]) {
        const linked = metadataMap[linkedMap[u.employeeNo]];
        if (linked) {
          meta = {
            grade: meta.grade || linked.grade,
            homeroom: meta.homeroom || linked.homeroom,
            idStudent: meta.idStudent || linked.idStudent,
            idBinusian: meta.idBinusian || linked.idBinusian,
            studentId: meta.studentId || linked.studentId,
          };
        }
      }

      // Strategy c: name-based fallback
      if ((!meta || !meta.homeroom) && u.name && nameMap[u.name]) {
        const nameMeta = nameMap[u.name];
        meta = meta
          ? {
              grade: meta.grade || nameMeta.grade,
              homeroom: meta.homeroom || nameMeta.homeroom,
              idStudent: meta.idStudent || nameMeta.idStudent,
              idBinusian: meta.idBinusian || nameMeta.idBinusian,
              studentId: meta.studentId || nameMeta.studentId,
            }
          : { ...nameMeta };
      }

      meta = meta || {};
      return {
        ...u,
        grade: meta.grade || '',
        homeroom: meta.homeroom || '',
        idStudent: meta.idStudent || '',
        idBinusian: meta.idBinusian || '',
        studentId: meta.studentId || '',
      };
    });

    // 4. Device info
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

    // 5. Capacity
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

export default withAuth(withMetrics(handler));
