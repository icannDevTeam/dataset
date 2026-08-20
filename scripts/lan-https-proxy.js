const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const LISTEN_HOST = process.env.LAN_HTTPS_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.LAN_HTTPS_PORT || 3443);
const TARGET_HOST = process.env.LAN_HTTP_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.LAN_HTTP_TARGET_PORT || 3000);

const keyPath = path.join(__dirname, '..', 'certificates', 'localhost-key.pem');
const certPath = path.join(__dirname, '..', 'certificates', 'localhost.pem');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('[lan-https-proxy] Missing TLS cert files:', keyPath, certPath);
  process.exit(1);
}

const tlsOptions = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
};

function proxyRequest(req, res) {
  const incomingHost = req.headers.host || '';
  const forwardHeaders = {
    ...req.headers,
    // Preserve browser-visible host so server-side origin checks compare
    // against the actual LAN URL (for example https://10.26.30.69:3000).
    host: incomingHost,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': incomingHost,
    'x-forwarded-for': req.socket.remoteAddress || '',
  };

  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: forwardHeaders,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    res.statusCode = 502;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`Bad gateway: ${err.message}`);
  });

  req.pipe(upstream);
}

const server = https.createServer(tlsOptions, proxyRequest);

server.on('clientError', (err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
  } catch {}
  console.error('[lan-https-proxy] clientError:', err.message);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `[lan-https-proxy] https://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`
  );
});
