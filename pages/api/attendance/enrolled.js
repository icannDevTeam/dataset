/**
 * GET /api/attendance/enrolled
 *
 * Returns the list of enrolled students from the Hikvision device.
 * Used by the dashboard to show who hasn't been recognized yet.
 *
 * Requires device credentials in request body or uses env defaults.
 * Query params:
 *   ?ip=...&username=...&password=...
 */

import { hikJson } from '../../../lib/hikvision';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const device = {
    ip: req.query.ip || process.env.HIKVISION_IP || '10.26.30.200',
    username: req.query.username || process.env.HIKVISION_USER || '',
    password: req.query.password || process.env.HIKVISION_PASS || '',
  };

  if (!device.username || !device.password) {
    return res.status(400).json({ error: 'Device credentials required' });
  }

  try {
    const users = [];
    let pos = 0;
    const batch = 30;

    while (true) {
      const body = {
        UserInfoSearchCond: {
          searchID: 'dashboard',
          searchResultPosition: pos,
          maxResults: batch,
        },
      };

      const data = await hikJson(device, 'POST', '/ISAPI/AccessControl/UserInfo/Search?format=json', body);
      const info = data.UserInfoSearch || {};
      let userList = info.UserInfo || [];
      if (!Array.isArray(userList)) userList = [userList];

      for (const u of userList) {
        users.push({
          employeeNo: u.employeeNo || '',
          name: u.name || '',
          userType: u.userType || '',
        });
      }

      const total = parseInt(info.totalMatches || '0', 10);
      pos += userList.length;
      if (pos >= total || userList.length === 0) break;
    }

    return res.status(200).json({ users, total: users.length });
  } catch (error) {
    console.error('Enrolled API error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
