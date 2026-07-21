import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const REPO_ROOT = path.resolve(process.cwd(), '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const DATA_DIR = path.join(BACKEND_DIR, 'data');
const PID_FILE = path.join(DATA_DIR, 'listener-manager.pid');
const LOG_FILE = path.join(BACKEND_DIR, 'listeners.log');
const PYTHON_BIN = fs.existsSync(path.join(REPO_ROOT, '.venv', 'bin', 'python'))
  ? path.join(REPO_ROOT, '.venv', 'bin', 'python')
  : 'python3';

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readPidFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    const pid = Number(raw.pid);
    return Number.isFinite(pid) && pid > 0 ? { ...raw, pid } : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStalePid() {
  const info = readPidFile();
  if (info && !isPidRunning(info.pid)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return null;
  }
  return info;
}

export function getListenerLogPath() {
  return LOG_FILE;
}

export function tailListenerLog(maxLines = 160) {
  try {
    const stat = fs.statSync(LOG_FILE);
    const tailBytes = 256 * 1024;
    let raw;
    if (stat.size > tailBytes) {
      const fd = fs.openSync(LOG_FILE, 'r');
      const buf = Buffer.alloc(tailBytes);
      fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } else {
      raw = fs.readFileSync(LOG_FILE, 'utf8');
    }
    return raw.split('\n').slice(-maxLines).join('\n').trimEnd();
  } catch {
    return '';
  }
}

export function parseListenerStatuses(logText) {
  const lines = String(logText || '').split('\n').filter(Boolean);
  const headerRegex = /Listener Manager Status/i;
  const runningRegex = /\[([^\]]+)\]\s*✓\s*Running\s*\|\s*PID\s*(\d+)\s*(?:\(up\s*([^\)]+)\))?(?:\s*\[(\d+)\s+restarts\])?/i;
  const stoppedRegex = /\[([^\]]+)\]\s*(?:✗\s*Stopped|Stopped)/i;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (headerRegex.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];

  const out = [];
  for (let i = start; i < Math.min(lines.length, start + 120); i += 1) {
    const line = lines[i];
    const running = line.match(runningRegex);
    if (running) {
      out.push({
        name: running[1].trim(),
        running: true,
        pid: Number(running[2]),
        uptime: running[3] || null,
        restarts: running[4] ? Number(running[4]) : 0,
      });
      continue;
    }
    const stopped = line.match(stoppedRegex);
    if (stopped) {
      out.push({ name: stopped[1].trim(), running: false, pid: null, uptime: null, restarts: 0 });
    }
  }
  return out;
}

export function getListenerManagerStatus() {
  const pidInfo = cleanupStalePid();
  const log = tailListenerLog();
  const logStat = (() => {
    try { return fs.statSync(LOG_FILE); } catch { return null; }
  })();
  return {
    running: !!(pidInfo && isPidRunning(pidInfo.pid)),
    pid: pidInfo?.pid || null,
    startedAt: pidInfo?.startedAt || null,
    command: pidInfo?.command || null,
    logPath: LOG_FILE,
    logUpdatedAt: logStat ? logStat.mtime.toISOString() : null,
    terminals: parseListenerStatuses(log),
    log,
  };
}

export function startListenerManager({ noFirebase = false, allowPartial = false } = {}) {
  const current = getListenerManagerStatus();
  if (current.running) return { alreadyRunning: true, status: current };

  ensureDataDir();
  const args = ['run_listeners.py'];
  if (noFirebase) args.push('--no-firebase');
  if (allowPartial) args.push('--allow-partial');

  const logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(logFd, `\n\n===== Listener manager start requested ${new Date().toISOString()} =====\n`);
  const child = spawn(PYTHON_BIN, args, {
    cwd: BACKEND_DIR,
    detached: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const command = `${PYTHON_BIN} ${args.join(' ')}`;
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), command }, null, 2));
  try { fs.closeSync(logFd); } catch {}
  return { alreadyRunning: false, status: getListenerManagerStatus() };
}

export function stopListenerManager() {
  const pidInfo = readPidFile();
  if (!pidInfo || !isPidRunning(pidInfo.pid)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return { wasRunning: false, status: getListenerManagerStatus() };
  }

  try {
    process.kill(-pidInfo.pid, 'SIGTERM');
  } catch {
    try { process.kill(pidInfo.pid, 'SIGTERM'); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  try {
    fs.appendFileSync(LOG_FILE, `\n===== Listener manager stop requested ${new Date().toISOString()} =====\n`);
  } catch {}
  return { wasRunning: true, status: getListenerManagerStatus() };
}