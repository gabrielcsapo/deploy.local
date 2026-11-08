import { test, expect } from 'playwright/test';
import { request as httpRequest } from 'node:http';
import { createGunzip, createBrotliDecompress } from 'node:zlib';

for (const source of ['hit', 'inflight', 'miss']) {
  test(`beacon reports masked ${source} navigation after commit`, async ({ page }) => {
    const beacons: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/__rfr/telemetry')) beacons.push(request.postData()!);
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (source === 'inflight')
      await page.route('**/__rsc?**', async (route) => {
        if (route.request().url().includes('inflight')) await blocked;
        await route.continue();
      });
    const hit = page.waitForResponse(
      (response) => response.url().includes('/__rsc?') && response.url().includes('hit'),
    );
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as any).__RFR_METRICS__));
    await hit;
    if (source === 'inflight') {
      const pending = page.waitForRequest(
        (request) => request.url().includes('/__rsc?') && request.url().includes('inflight'),
      );
      await page.getByRole('link', { name: 'Inflight', exact: true }).focus();
      await pending;
    }
    await page
      .getByRole('link', { name: source[0].toUpperCase() + source.slice(1), exact: true })
      .click();
    release();
    await expect(page.getByRole('heading', { name: 'Committed photo' })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect.poll(() => beacons.length).toBeGreaterThan(0);
    const payloads = beacons.map((value) => JSON.parse(value));
    const navigation = payloads
      .flatMap((body) => body.events)
      .find((event) => event.type === 'nav');
    expect(navigation).toMatchObject({ route: '/photos/:id', from: '/', prefetch: source });
    expect(navigation.ms).toBeGreaterThanOrEqual(0);
    expect(beacons.join('')).not.toContain('secret');
    expect(beacons.join('')).not.toContain('redacted');
    for (const value of beacons) expect(Buffer.byteLength(value)).toBeLessThanOrEqual(16 * 1024);
  });
}

test('beacons collect load metrics and dedupe browser errors, including rejections', async ({
  page,
}) => {
  const beacons: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/__rfr/telemetry')) beacons.push(request.postData()!);
  });
  await page.goto('/photos/private?secret=redacted');
  await page.waitForFunction(() => Boolean((window as any).__RFR_METRICS__));
  await page.evaluate(() => {
    const error = new Error('browser fixture error');
    for (let i = 0; i < 3; i++) window.dispatchEvent(new ErrorEvent('error', { error }));
    window.dispatchEvent(
      new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve(),
        reason: new TypeError('rejection fixture'),
      }),
    );
    window.dispatchEvent(new Event('pagehide'));
  });
  await expect.poll(() => beacons.length).toBeGreaterThan(0);
  const events = beacons.flatMap((body) => JSON.parse(body).events);
  expect(events.filter((event) => event.type === 'error')).toHaveLength(2);
  expect(events.find((event) => event.type === 'load')).toMatchObject({
    route: '/photos/:id',
    ttfb: expect.any(Number),
  });
  for (const error of events.filter((event) => event.type === 'error'))
    expect(error.fingerprint).toMatch(/^[a-f0-9]{40}$/);
});

test('disabled telemetry loads no telemetry chunk and sends no beacon', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  await page.goto('http://127.0.0.1:5305/');
  await page.getByRole('link', { name: 'Miss', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Committed photo' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(urls.some((url) => /telemetry-.*\.js|\/__rfr\/telemetry/.test(url))).toBe(false);
  expect(await page.evaluate(() => (window as any).__RFR_METRICS__)).toBeUndefined();
});

test('custom beacon path travels from server bootstrap to browser requests', async ({ page }) => {
  const beacons: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/metrics/browser')) beacons.push(request.postData()!);
  });
  await page.goto('http://127.0.0.1:5306/photos/private');
  await page.waitForFunction(() => Boolean((window as any).__RFR_METRICS__));
  expect(await page.evaluate(() => (window as any).__RFR_TELEMETRY__.beaconPath)).toBe(
    '/metrics/browser',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => beacons.length).toBeGreaterThan(0);
  expect(JSON.parse(beacons[0]).events[0].route).toBe('/photos/:id');
});

test('beaconPath false keeps server reporting without loading browser telemetry', async ({
  page,
  request,
}) => {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  await page.goto('http://127.0.0.1:5307/photos/private');
  await expect(page.getByRole('heading', { name: 'Committed photo' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(urls.some((url) => /telemetry-.*\.js|\/__rfr\/telemetry/.test(url))).toBe(false);
  expect(await page.evaluate(() => (window as any).__RFR_METRICS__)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__RFR_TELEMETRY__)).toBeUndefined();
  await expect
    .poll(
      async () => {
        const response = await request.get('http://127.0.0.1:5307/__fixture/server-records');
        const batches = await response.json();
        return batches
          .flatMap((batch: any) => batch.records)
          .some((record: any) => record.route === '/photos/:id');
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

for (const encoding of ['gzip', 'br']) {
  test(`real HTTP Suspense ${encoding} flushes before 550 ms`, async () => {
    const started = performance.now();
    const seen = await new Promise<{ text: string; ms: number }[]>((resolve, reject) => {
      httpRequest(
        `http://127.0.0.1:5304/suspense`,
        { headers: { 'Accept-Encoding': encoding } },
        (response) => {
          expect(response.headers['content-encoding']).toBe(encoding);
          const decoder = encoding === 'br' ? createBrotliDecompress() : createGunzip();
          const chunks: { text: string; ms: number }[] = [];
          decoder.on('data', (chunk) =>
            chunks.push({ text: chunk.toString(), ms: performance.now() - started }),
          );
          decoder.on('end', () => resolve(chunks));
          decoder.on('error', reject);
          response.pipe(decoder);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(seen.find((chunk) => chunk.text.includes('id="fallback"'))!.ms).toBeLessThan(100);
    expect(seen.find((chunk) => chunk.text.includes('id="resolved"'))!.ms).toBeLessThan(550);
  });
}
