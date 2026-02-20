/**
 * GET /api/hikvision/status
 *
 * Returns the Hikvision device info and list of enrolled users.
 */

import axios from 'axios';

const HIK_IP = process.env.HIKVISION_IP || '';
const HIK_USER = process.env.HIKVISION_USER || '';
const HIK_PASS = process.env.HIKVISION_PASS || '';
const HIK_BASE = `http://${HIK_IP}`;

async function hikJson(method, apiPath, data = null) {
  const opts = {
    method,
    url: `${HIK_BASE}${apiPath}`,
    auth: { username: HIK_USER, password: HIK_PASS },
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  };
  if (data) opts.data = data;
  const r = await axios(opts);
  return r.data;
}

import { withMetrics } from '../../../lib/metrics';

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Device info (XML endpoint)
    let deviceInfo = {};
    try {
      const r = await axios.get(`${HIK_BASE}/ISAPI/System/deviceInfo`, {
        auth: { username: HIK_USER, password: HIK_PASS },
        timeout: 10000,
      });
      // Simple XML extraction
      const xml = r.data;
      const extract = (tag) => {
        const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
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
      deviceInfo = { error: 'Could not reach device' };
    }

    // Enrolled users
    let users = [];
    try {
      const searchBody = {
        UserInfoSearchCond: {
          searchID: 'web_status',
          searchResultPosition: 0,
          maxResults: 30,
        },
      };
      const data = await hikJson('post', '/ISAPI/AccessControl/UserInfo/Search?format=json', searchBody);
      const info = data?.UserInfoSearch || {};
      users = info.UserInfo || [];
      if (!Array.isArray(users)) users = [users];
    } catch (e) {
      console.warn('User search error:', e.message);
    }

    // FDLib counts
    let fdlibCounts = [];
    try {
      const data = await hikJson('get', '/ISAPI/Intelligent/FDLib/Count?format=json');
      fdlibCounts = data?.FDRecordDataInfo || [];
    } catch (e) {
      console.warn('FDLib count error:', e.message);
    }

    return res.status(200).json({
      success: true,
      device: deviceInfo,
      users: users.map((u) => ({
        employeeNo: u.employeeNo,
        name: u.name,
        numOfFace: u.numOfFace || 0,
      })),
      totalUsers: users.length,
      fdlib: fdlibCounts,
    });
  } catch (error) {
    console.error('Status error:', error.message);
    return res.status(500).json({
      error: 'Failed to get device status',
      details: error.message,
    });
  }
}

export default withMetrics(handler);
