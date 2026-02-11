/**
 * POST /api/hikvision/capture
 *
 * Triggers the Hikvision device camera to capture a face photo.
 * The device blocks until it detects a face, then returns a 352×432 JPEG.
 * Returns the image as base64 data URL so the frontend can display it.
 */

import axios from 'axios';

const HIK_IP = process.env.HIKVISION_IP || '10.26.30.200';
const HIK_USER = process.env.HIKVISION_USER || 'admin';
const HIK_PASS = process.env.HIKVISION_PASS || 'password.123';
const HIK_BASE = `http://${HIK_IP}`;

export const config = {
  api: {
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('📷 Triggering Hikvision face capture...');

    const xmlBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<CaptureFaceDataCond xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">' +
      '<captureInfrared>false</captureInfrared>' +
      '<dataType>binary</dataType>' +
      '</CaptureFaceDataCond>';

    const response = await axios.post(
      `${HIK_BASE}/ISAPI/AccessControl/CaptureFaceData`,
      xmlBody,
      {
        auth: { username: HIK_USER, password: HIK_PASS },
        headers: { 'Content-Type': 'application/xml' },
        responseType: 'arraybuffer',
        timeout: 60000, // 60s — device blocks until face detected
      }
    );

    if (response.status !== 200) {
      return res.status(502).json({ error: `Device returned HTTP ${response.status}` });
    }

    // Parse multipart response — extract JPEG between SOI and EOI markers
    const buffer = Buffer.from(response.data);
    const jpegStart = buffer.indexOf(Buffer.from([0xff, 0xd8]));
    const jpegEnd = buffer.lastIndexOf(Buffer.from([0xff, 0xd9]));

    if (jpegStart === -1 || jpegEnd === -1) {
      return res.status(502).json({ error: 'No JPEG data in device response' });
    }

    const jpegData = buffer.slice(jpegStart, jpegEnd + 2);
    const base64 = jpegData.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    console.log(`✅ Captured face: ${jpegData.length} bytes`);

    return res.status(200).json({
      success: true,
      image: dataUrl,
      size: jpegData.length,
      width: 352,
      height: 432,
    });
  } catch (error) {
    console.error('Capture error:', error.message);

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return res.status(504).json({
        error: 'Capture timed out — no face detected within 60 seconds',
      });
    }

    return res.status(500).json({
      error: 'Failed to capture face from device',
      details: error.message,
    });
  }
}
