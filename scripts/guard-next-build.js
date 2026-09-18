const fs = require('fs');
const path = require('path');

if (process.env.ALLOW_NEXT_BUILD_WITH_DEV_SERVER === '1') {
  process.exit(0);
}

const projectRoot = fs.realpathSync(path.resolve(__dirname, '..'));
let activeDevPid = null;

for (const entry of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;

  try {
    const processRoot = fs.realpathSync(`/proc/${entry}/cwd`);
    const command = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
    if (processRoot === projectRoot && /(?:^|\s)next(?:\s|$).*\bdev\b/.test(command)) {
      activeDevPid = entry;
      break;
    }
  } catch {
    // Processes may exit or be inaccessible while /proc is scanned.
  }
}

if (activeDevPid) {
  console.error(
    `Refusing to run next build while the LAN next dev server is active (PID ${activeDevPid}).\n` +
    'Stop final-face-web.service first so both processes cannot modify .next.'
  );
  process.exit(1);
}