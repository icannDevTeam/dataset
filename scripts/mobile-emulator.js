#!/usr/bin/env node

/**
 * Terminal mobile emulator for responsive checks.
 *
 * Examples:
 *   npm run emulate:mobile -- --url "https://10.26.30.69:3000/v2/pickup-admin" --device "iPhone 14"
 *   npm run emulate:mobile -- --url "https://10.26.30.69:3000/v2/pickup-admin" --device "Pixel 7" --screenshot tmp/pixel7.png
 *   npm run emulate:mobile -- --list
 */

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

function parseArgs(argv) {
  const out = {
    url: 'http://localhost:3000',
    device: 'iPhone 14',
    screenshot: '',
    waitMs: 1500,
    list: false,
    dark: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--device' && argv[i + 1]) out.device = argv[++i];
    else if (a === '--screenshot' && argv[i + 1]) out.screenshot = argv[++i];
    else if (a === '--wait' && argv[i + 1]) out.waitMs = Number(argv[++i]) || out.waitMs;
    else if (a === '--list') out.list = true;
    else if (a === '--dark') out.dark = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log([
    'Mobile emulator CLI',
    '',
    'Options:',
    '  --url <url>             Target URL (default: http://localhost:3000)',
    '  --device <name>         Playwright device name (default: iPhone 14)',
    '  --screenshot <path>     Save screenshot and exit',
    '  --wait <ms>             Wait time after navigation (default: 1500)',
    '  --dark                  Force dark color scheme',
    '  --list                  List supported device names',
    '  -h, --help              Show help',
    '',
    'Examples:',
    '  npm run emulate:mobile -- --url "https://10.26.30.69:3000/v2/pickup-admin"',
    '  npm run emulate:mobile -- --url "https://10.26.30.69:3000/v2/pickup-admin" --device "Pixel 7" --screenshot tmp/pixel7.png',
  ].join('\n'));
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.list) {
    Object.keys(devices)
      .sort((a, b) => a.localeCompare(b))
      .forEach((name) => console.log(name));
    process.exit(0);
  }

  const device = devices[args.device];
  if (!device) {
    console.error(`Unknown device: ${args.device}`);
    console.error('Run with --list to see supported devices.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    ...device,
    colorScheme: args.dark ? 'dark' : 'light',
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(args.waitMs);

  console.log(`Device: ${args.device}`);
  console.log(`URL: ${args.url}`);
  console.log(`Viewport: ${device.viewport.width}x${device.viewport.height}`);

  if (args.screenshot) {
    const fullPath = path.resolve(args.screenshot);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    await page.screenshot({ path: fullPath, fullPage: true });
    console.log(`Screenshot saved: ${fullPath}`);
    await browser.close();
    process.exit(0);
  }

  console.log('Interactive window opened. Close the browser window to finish.');

  context.on('close', () => process.exit(0));
})().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
