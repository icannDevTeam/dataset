/**
 * POST /api/hikvision/delete
 *
 * Deletes a student (user + face) from the Hikvision device.
 * Body: { device: { ip, username, password }, employeeNo, name }
 *
 * Steps:
 *   1. Delete face data from FDLib (if exists)
 *   2. Delete user record from device
 */

import { hikRequest, hikJson, isAllowedDeviceIP } from '../../../lib/hikvision';
import { withMetrics } from '../../../lib/metrics';

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { device, employeeNo, name } = req.body;

  if (!device?.ip || !device?.username || !device?.password) {
    return res.status(400).json({ error: 'Missing device credentials' });
  }

  if (!isAllowedDeviceIP(device.ip)) {
    return res.status(400).json({ error: 'Invalid device IP. Only private LAN addresses are allowed.' });
  }

  if (!employeeNo) {
    return res.status(400).json({ error: 'Missing employeeNo' });
  }

  console.log(`\n🗑️  Deleting: ${name || employeeNo} (${employeeNo})`);

  try {
    // Step 1: Delete face from FDLib (non-fatal if it fails)
    let faceDeleted = false;
    try {
      const faceBody = {
        faceLibType: 'blackFD',
        FDID: '1',
        FPID: employeeNo,
      };
      await hikJson(device, 'put', '/ISAPI/Intelligent/FDLib/FDDelete?format=json', faceBody);
      faceDeleted = true;
      console.log('  ✓ Face data deleted from FDLib');
    } catch (e) {
      // Face may not exist in FDLib — that's fine
      console.warn('  ⚠ FDLib delete (non-fatal):', e.message);
    }

    // Step 2: Delete user record
    const userBody = {
      UserInfoDelCond: {
        EmployeeNoList: [{ employeeNo }],
      },
    };
    const data = await hikJson(device, 'put', '/ISAPI/AccessControl/UserInfo/Delete?format=json', userBody);

    const success = data?.statusCode === 1;
    if (success) {
      console.log('  ✓ User record deleted');
      return res.status(200).json({
        success: true,
        message: `${name || employeeNo} removed from device`,
        faceDeleted,
      });
    }

    return res.status(502).json({
      error: 'Device rejected delete request',
      details: data,
    });
  } catch (error) {
    console.error('Delete error:', error.message);

    // Check if user doesn't exist (already deleted)
    const sub = error.response?.data?.subStatusCode
      || error.response?.data?.StatusString?.subStatusCode
      || '';
    const errMsg = error.response?.data?.errorMsg || '';
    if (sub === 'employeeNoNotExist' || sub === 'deviceUserNotExist'
        || (sub === 'badJsonContent' && errMsg === 'employeeNo')) {
      return res.status(200).json({
        success: true,
        message: `${name || employeeNo} was already removed`,
      });
    }

    return res.status(500).json({
      error: 'Failed to delete user',
      details: error.message,
    });
  }
}

export default withMetrics(handler);
