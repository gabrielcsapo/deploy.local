// Capture a page at the board widths with headless Playwright Chromium, for parity evidence.
//   node design/tools/capture.mjs <url> <out-prefix> [widths=1440,700] [height=1000] [--dark]
//     [--storage key=value ...]
// Writes <out-prefix>-<width>.png. Run from a checkout with node_modules installed.
// --storage sets localStorage before the page loads, such as a local fixture's sign-in
// (deploy-sh-auth={"username":…,"token":…}); it is refused for anything but a loopback address.
import { createRequire } from 'node:module';
const args = process.argv.slice(2);
const dark = args.includes('--dark');
const storage = [];
const positional = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--dark') continue;
  if (args[index] === '--storage') {
    const pair = args[++index] ?? '';
    const equals = pair.indexOf('=');
    if (equals < 1) throw new Error('--storage needs key=value');
    storage.push([pair.slice(0, equals), pair.slice(equals + 1)]);
  } else positional.push(args[index]);
}
const [url, out, widths = '1440,700', height = '1000'] = positional;
if (storage.length && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('--storage is only for local fixtures on a loopback address');
const { chromium } = createRequire(process.cwd() + '/')('playwright');
const browser = await chromium.launch();
for (const width of widths.split(',').map(Number)) {
  const page = await browser.newPage({
    viewport: { width, height: Number(height) },
    colorScheme: dark ? 'dark' : 'light',
  });
  if (storage.length)
    await page.addInitScript((entries) => {
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, storage);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Pages keep a long-poll open, so wait a fixed time instead of for network idle.
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}-${width}.png` });
  await page.close();
}
await browser.close();
