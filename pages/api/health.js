import { withMetrics } from '../../lib/metrics';
import { withAuth } from '../../lib/auth-middleware';

function handler(req, res) {
  res.status(200).json({ 
    status: 'ok', 
    service: 'facial-attendance-web-collector',
    timestamp: new Date().toISOString(),
  });
}

export default withAuth(withMetrics(handler), { public: true });
