/**
 * GET /api/pickup/admin/listener-log
 *
 * Reads the Python listener manager log from disk, strips ANSI escape codes,
 * and returns the last N lines as structured entries.
 *
 * The log file is at <project-root>/listeners.log (symlink to backend/listeners.log).
 * We look in several candidate paths so the API works regardless of cwd.
 *
 * Query params:
 *   lines   number   Lines to return (default 120, max 500)
 *
 * Response:
 * {
 *   ok: true,
 *   path: string,        // resolved log file path
 *   sizeBytes: number,
 *   entries: [{
 *     raw: string,       // cleaned text
 *     terminal: string|null,
 *     level: 'info'|'warn'|'error'|'success'|'status',
 *     message: string,
 *     ts: string|null,   // parsed timestamp if present
 *   }],
 *   listenerStatus: [{   // parsed from last status block
 *     terminal: string,
 *     pid: number|null,
 *     uptime: string|null,
 *     running: boolean,
 *   }] | null,
 *   statusAt: string|null,
 * }
 */
import path from 'path';
import fs from 'fs';
import { withApi } from '../../../../lib/api-auth';

// Strip all ANSI escape sequences
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]|\x1B\[[0-9;]*[A-Za-z]/g, '')
            .replace(/\x1B\(B/g, '')
            .replace(/\x1B=/g, '');
}

// Candidate log paths (checked in order)
function resolveLogPath() {
  const cwd = process.cwd(); // web-dataset-collector/
  const candidates = [
    path.join(cwd, '..', 'listeners.log'),
    path.join(cwd, '..', 'backend', 'listeners.log'),
    path.join('/home/pandora/Downloads/final-face', 'listeners.log'),
    path.join('/home/pandora/Downloads/final-face/backend', 'listeners.log'),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch { /* try next */ }
  }
  return null;
}

function classifyLine(raw) {
  if (/✓\s*Running|Running\s*\|/i.test(raw)) return 'success';
  if (/⚠|Connection lost|reconnecting|Reconnecting/i.test(raw)) return 'warn';
  if (/Error|ERROR|exception|Exception|failed|Failed|Stopped|⏹/i.test(raw)) return 'error';
  if (/Reconnected|Connected|Connecting|📡|🔗/i.test(raw)) return 'info';
  if (/Listener Manager Status|={10,}/i.test(raw)) return 'status';
  if (/Shutdown|Goodbye|Stopped/i.test(raw)) return 'warn';
  return 'info';
}

function extractTerminal(raw) {
  const m = raw.match(/\[([^\]]+(?:Terminal|Entrance|Tower|Lobby|Gate|Basement|MYP|PYP)[^\]]*)\]/i);
  if (m) return m[1].trim();
  // Generic bracketed name
  const g = raw.match(/\[([A-Za-z0-9 \-()]+)\]/);
  return g ? g[1].trim() : null;
}

function extractTimestamp(raw) {
  // "2026-05-21 16:10:46 WIB" style
  const m = raw.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function parseStatusBlock(lines) {
  const entries = [];
  for (const line of lines) {
    const runMatch = line.match(/\[([^\]]+)\]\s*✓\s*Running\s*\|\s*PID\s*(\d+)\s*\(up\s*([^)]+)\)/i);
    if (runMatch) {
      entries.push({ terminal: runMatch[1].trim(), pid: parseInt(runMatch[2]), uptime: runMatch[3].trim(), running: true });
      continue;
    }
    const stopMatch = line.match(/\[([^\]]+)\]\s*Stopped/i);
    if (stopMatch) {
      entries.push({ terminal: stopMatch[1].trim(), pid: null, uptime: null, running: false });
    }
  }
  return entries.length > 0 ? entries : null;
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const maxLines = Math.min(500, Math.max(10, parseInt(req.query.lines || '120', 10)));

  const logPath = resolveLogPath();
  if (!logPath) {
    return res.status(200).json({
      ok: true,
      path: null,
      sizeBytes: 0,
      entries: [],
      listenerStatus: null,
      statusAt: null,
      _note: 'listeners.log not found — start the Python listener manager to generate logs',
    });
  }

  let raw = '';
  let sizeBytes = 0;
  try {
    const stat = fs.statSync(logPath);
    sizeBytes = stat.size;
    // Read only the tail to avoid loading huge files
    const TAIL_BYTES = 128 * 1024; // 128 KB
    if (stat.size > TAIL_BYTES) {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } else {
      raw = fs.readFileSync(logPath, 'utf8');
    }
  } catch (e) {
    return res.status(500).json({ error: 'read_failed', message: e.message });
  }

  const rawLines = raw.split('\n').filter((l) => l.trim());
  const tail = rawLines.slice(-maxLines);

  const entries = tail.map((line) => {
    const cleaned = stripAnsi(line).trim();
    return {
      raw: cleaned,
      terminal: extractTerminal(cleaned),
      level: classifyLine(cleaned),
      message: cleaned.replace(/\[[^\]]+\]\s*/g, '').trim() || cleaned,
      ts: extractTimestamp(cleaned),
    };
  });

  // Find the last status block
  let lastStatusIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].level === 'status' && /Listener Manager Status/.test(entries[i].raw)) {
      lastStatusIdx = i;
      break;
    }
  }

  let listenerStatus = null;
  let statusAt = null;
  if (lastStatusIdx >= 0) {
    const blockLines = entries.slice(lastStatusIdx, lastStatusIdx + 10).map((e) => e.raw);
    listenerStatus = parseStatusBlock(blockLines);
    statusAt = entries[lastStatusIdx].ts;
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    path: logPath,
    sizeBytes,
    entries,
    listenerStatus,
    statusAt,
  });
}

export default withApi(handler, { methods: ['GET'], permission: 'analytics.view' });
