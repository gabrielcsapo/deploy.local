import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Screenshot } from '../../shared/v2/contracts.ts';
const exec = promisify(execFile);

export async function captureScreenshots(request: {
  target: Screenshot['target'];
  widths: number[];
}) {
  const { target, widths } = request;
  if (target.kind === 'web') {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const images = [];
      for (const width of widths) {
        const height = width <= 700 ? 780 : 900;
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 1,
          acceptDownloads: false,
          serviceWorkers: 'block',
        });
        try {
          await context.route('**/*', (route) =>
            ['http:', 'https:'].includes(new URL(route.request().url()).protocol)
              ? route.continue()
              : route.abort(),
          );
          const page = await context.newPage();
          page.on('dialog', (dialog) => void dialog.dismiss());
          await page.goto(target.url!, { waitUntil: 'networkidle', timeout: 15000 });
          images.push({
            type: 'image/png',
            data: (await page.screenshot({ type: 'png', timeout: 5000 })).toString('base64'),
            width,
            height,
          });
        } finally {
          await context.close();
        }
      }
      return images;
    } finally {
      await browser.close();
    }
  }
  if (target.kind === 'ios-simulator') {
    if (process.platform !== 'darwin')
      throw new Error('iOS Simulator screenshots require a Mac computer');
    // simctl addresses simulators exclusively; no physical-device tool is invoked.
    const inventory = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
      timeout: 5000,
    });
    const devices: any[] = Object.values(JSON.parse(inventory.stdout).devices).flat() as any[];
    if (
      !devices.some(
        (device) =>
          device.udid === target.device && device.state === 'Booted' && device.isAvailable,
      )
    )
      throw new Error('Choose a booted iOS simulator on this computer');
    const directory = mkdtempSync(join(tmpdir(), 'deploy-screenshot-'));
    try {
      const path = join(directory, 'simulator.png');
      await exec('xcrun', ['simctl', 'io', target.device!, 'screenshot', '--type=png', path], {
        timeout: 15000,
      });
      const bytes = readFileSync(path);
      return [
        {
          type: 'image/png',
          data: bytes.toString('base64'),
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
        },
      ];
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const helper = process.env.DEPLOY_DESKTOP_HELPER;
  if (!helper || process.platform !== 'darwin')
    throw new Error('This computer has no screen-control helper');
  const { stdout } = await exec(
    helper,
    [JSON.stringify({ type: 'inspect', targetId: target.device })],
    { timeout: 5000, maxBuffer: 14 * 1024 * 1024 },
  );
  const frame = JSON.parse(stdout);
  if (frame.error) throw new Error(frame.error);
  return [{ type: frame.mimeType, data: frame.image, width: frame.width, height: frame.height }];
}
export class ScreenshotRunner {
  private busy = false;
  private closed = false;
  private request: (action: string, body: any) => Promise<any>;
  constructor(request: (action: string, body: any) => Promise<any>) {
    this.request = request;
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const { request } = await this.request('poll', {});
      if (!request || this.closed) return;
      const identity = { id: request.id, lease: request.lease };
      try {
        const images = await captureScreenshots(request);
        await this.request('complete', { ...identity, images });
      } catch (error: any) {
        await this.request('complete', { ...identity, error: error.message });
      }
    } catch (error: any) {
      console.error('Screenshot:', error.message);
    } finally {
      this.busy = false;
    }
  }
  shutdown() {
    this.closed = true;
  }
}
