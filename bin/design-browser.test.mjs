import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { chromiumCandidates, openChromium, playwrightCache } from './design-browser.mjs';
import { shootBoard } from '../server/design/check-drawing.ts';
import { contrastProblems } from '../server/design/board-quality.ts';

test("Playwright's newest headless shell comes first, then its Chromium, then the computer's Chrome", () => {
  const cache = playwrightCache({}, 'darwin', '/Users/me');
  assert.equal(cache, '/Users/me/Library/Caches/ms-playwright');
  const present = new Set([
    join(
      cache,
      'chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    ),
    join(
      cache,
      'chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    ),
    join(
      cache,
      'chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]);
  const found = chromiumCandidates({
    env: { DEPLOY_CHROMIUM: '/opt/missing' },
    platform: 'darwin',
    home: '/Users/me',
    exists: (path) => present.has(path),
    list: () => [
      'chromium_headless_shell-1243',
      'chromium-1254',
      'chromium_headless_shell-1255',
      'ffmpeg-1011',
    ],
  });
  assert.deepEqual(found, [...present]);
  assert.equal(
    playwrightCache({ PLAYWRIGHT_BROWSERS_PATH: '/srv/browsers' }, 'linux', '/root'),
    '/srv/browsers',
  );
});

test('a board drawn here is measured as the check measures it: white on white in dark fails', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const page = `<!doctype html><html><head><style>
      :root{--ink:#1c1b1f;--paper:#f7f7f8}[data-theme="dark"]{--ink:#f3f2f5;--paper:#18171b}
      body{margin:0;background:var(--paper);color:var(--ink);font:13px system-ui}
      .row{background:#fff;padding:12px}
    </style></head><body><main data-layer="page"><h1 data-layer="title" style="font-size:22px">Run</h1>
    <div data-layer="kept-row" class="row"><span data-layer="kept-name">coverage.zip</span></div>
    <p data-layer="kept-expiry" data-question="How long are kept files kept?">Kept</p></main></body></html>`;
    const shots = {};
    for (const scheme of ['light', 'dark']) {
      const tab = await browser.newTab({ width: 600, height: 400, scheme });
      try {
        shots[scheme] = await shootBoard(tab, page, { scheme, measure: true, inspect: true });
      } finally {
        await tab.close();
      }
    }
    assert.ok(shots.light.png.subarray(1, 4).toString() === 'PNG');
    assert.deepEqual(shots.light.measured, { scrolls: false, cut: null });
    const check = (scheme) =>
      contrastProblems({
        file: 'Run.html',
        title: 'Run',
        width: 600,
        scheme,
        after: shots[scheme].inspected,
        before: null,
        tokens: null,
      }).map((problem) => problem.layer);
    assert.deepEqual(check('light'), []);
    assert.deepEqual(check('dark'), ['kept-name']);
    assert.ok(
      shots.dark.inspected.texts.some((text) => text.layer === 'title' && text.size === 22),
    );
  } finally {
    await browser.close();
  }
});
