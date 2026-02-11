export default function handler(req, res) {
  res.status(200).json({ 
    status: 'ok', 
    service: 'facial-attendance-web-collector',
    timestamp: new Date().toISOString()
  });
}
