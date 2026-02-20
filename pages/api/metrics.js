/**
 * GET /api/metrics
 *
 * Prometheus scrape endpoint — returns all collected metrics in
 * OpenMetrics / Prometheus text format.
 *
 * This should NOT be wrapped with withMetrics() to avoid self-referencing loops.
 */

const { register } = require('../../lib/metrics');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const metricsOutput = await register.metrics();
    res.setHeader('Content-Type', register.contentType);
    res.status(200).end(metricsOutput);
  } catch (err) {
    console.error('Error collecting metrics:', err);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
}
