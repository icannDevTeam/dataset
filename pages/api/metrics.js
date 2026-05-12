/**
 * GET /api/metrics
 *
 * Prometheus scrape endpoint — returns all collected metrics in
 * OpenMetrics / Prometheus text format.
 *
 * SECURITY: protected by the dashboard API key. Prometheus must pass it via
 *   Authorization: Bearer <DASHBOARD_API_KEY>   (or x-api-key header)
 * Same-origin scrapes from the dashboard host are also accepted.
 *
 * This should NOT be wrapped with withMetrics() to avoid self-referencing loops.
 */

const { register } = require('../../lib/metrics');
import { withAuth } from '../../lib/auth-middleware';

async function metricsHandler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const metricsOutput = await register.metrics();
    res.setHeader('Content-Type', register.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(metricsOutput);
  } catch (err) {
    console.error('Error collecting metrics:', err);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
}

export default withAuth(metricsHandler, { methods: ['GET'] });
