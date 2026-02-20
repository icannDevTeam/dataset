/**
 * POST /api/hikvision/connect
 *
 * Tests connection to a Hikvision device and returns device info + enrolled users.
 * Device credentials are sent in the request body (portal can connect to any device).
 * Uses HTTP Digest Authentication (required by Hikvision ISAPI).
 *
 * Body: { ip, username, password }
 */

import { hikRequest, hikJson, isAllowedDeviceIP } from '../../../lib/hikvision';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ip, username, password } = req.body;

  if (!ip || !username || !password) {
    return res.status(400).json({ error: 'Missing device credentials (ip, username, password)' });
  }

  if (!isAllowedDeviceIP(ip)) {
    return res.status(400).json({ error: 'Invalid device IP. Only private LAN addresses are allowed.' });
  }

  const device = { ip, username, password };

  try {
    // Device info (XML endpoint)
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
      if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') {
        return res.status(502).json({
          error: 'Cannot reach device',
          details: `Connection to ${ip} failed: ${e.code}`,
        });
      }
      if (e.response?.status === 401) {
        return res.status(401).json({
          error: 'Authentication failed',
          details: 'Invalid username or password',
        });
      }
      deviceInfo = { error: e.message };
    }

    // Enrolled users
    let users = [];
    let totalUsers = 0;
    try {
      const searchBody = {
        UserInfoSearchCond: {
          searchID: 'portal_connect',
          searchResultPosition: 0,
          maxResults: 100,
        },
      };
      const data = await hikJson(device, 'post', '/ISAPI/AccessControl/UserInfo/Search?format=json', searchBody);
      const info = data?.UserInfoSearch || {};
      users = info.UserInfo || [];
      if (!Array.isArray(users)) users = [users];
      totalUsers = info.totalMatches || users.length;
    } catch (e) {
      console.warn('User search error:', e.message);
    }

    // FDLib face counts
    let totalFaces = 0;
    try {
      const data = await hikJson(device, 'get', '/ISAPI/Intelligent/FDLib/Count?format=json');
      const counts = data?.FDRecordDataInfo || [];
      if (Array.isArray(counts)) {
        totalFaces = counts.reduce((sum, c) => sum + (c.recordDataNumber || 0), 0);
      }
    } catch (e) {
      console.warn('FDLib count error:', e.message);
    }

    // Device capacity
    let capacity = {};
    try {
      const data = await hikJson(device, 'get', '/ISAPI/AccessControl/UserInfo/capabilities?format=json');
      capacity = {
        maxUsers: data?.UserInfoCap?.maxUserNum || 0,
        maxFaces: data?.UserInfoCap?.maxFaceNum || 0,
      };
    } catch (e) {
      // Some models may not support this endpoint
    }

    return res.status(200).json({
      success: true,
      device: deviceInfo,
      users: users.map((u) => ({
        employeeNo: u.employeeNo,
        name: u.name,
        numOfFace: u.numOfFace || 0,
      })),
      totalUsers,
      totalFaces,
      capacity,
    });
  } catch (error) {
    console.error('Connect error:', error.message);
    return res.status(500).json({
      error: 'Failed to connect to device',
      details: error.message,
    });
  }
}
