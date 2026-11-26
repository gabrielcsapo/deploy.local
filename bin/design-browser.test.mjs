import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { chromiumCandidates, openChromium, playwrightCache } from './design-browser.mjs';
import { pairPage, shootBoard } from '../server/design/check-drawing.ts';
import { instanceQuestions, renderComponent, syncInstances } from '../server/design/board-html.ts';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

test('a question is a numbered badge on its layer, listed beside the picture, and moves nothing', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const page = `<!doctype html><html><body style="margin:0;font:13px system-ui">
      <header style="display:flex;height:44px"><button data-layer="back" style="width:44px">Back</button>
      <span data-layer="title" data-question="What is this screen called on the phone?">Run</span></header>
      <p data-layer="kept" data-question="How long are kept files kept?" style="width:300px">Kept files</p>
      <div style="width:700px;height:10px"></div></body></html>`;
    const tab = await browser.newTab({ width: 390, height: 200 });
    try {
      const shot = await shootBoard(tab, page, { scheme: 'light', measure: true, inspect: true });
      assert.deepEqual(shot.questions, [
        { n: 1, layer: 'title', question: 'What is this screen called on the phone?' },
        { n: 2, layer: 'kept', question: 'How long are kept files kept?' },
      ]);
      // Measured before marking: only the board's own 700 px block leaves the page.
      assert.deepEqual(shot.measured, { scrolls: true, cut: null });
      // The marks sit in one layer over the page; the back button is where it was.
      const placed = await tab.evaluate(
        `(() => { const back = document.querySelector('[data-layer="back"]').getBoundingClientRect(); const marks = document.body.lastElementChild; return { back: [back.left, back.top, back.width], marks: marks.children.length, overBack: [...marks.children].some((mark) => { const r = mark.getBoundingClientRect(); return r.left < back.right && r.right > back.left && r.top < back.bottom && r.bottom > back.top; }) }; })()`,
      );
      assert.deepEqual(placed, { back: [0, 0, 44], marks: 4, overBack: false });
    } finally {
      await tab.close();
    }
    const html = pairPage({
      before: null,
      after: Buffer.from('png'),
      width: 390,
      scheme: 'light',
      questions: [{ n: 1, layer: 'kept', question: 'How long are <kept> files kept?' }],
    });
    assert.match(
      html,
      /<ol class="q"><li value="1">How long are &lt;kept&gt; files kept\? <span>kept<\/span><\/li><\/ol>/,
    );
  } finally {
    await browser.close();
  }
});

test('in a sandbox that forbids the network and Mach services, Chromium starts as one process', async (t) => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
    return t.skip('needs macOS sandbox-exec');
  if (!chromiumCandidates().length) return t.skip('no browser here');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'design-sandbox-')));
  try {
    // Like Codex's: read anywhere, write only in the work folder, no network, few Mach services.
    const profile = join(work, 'sandbox.sb');
    writeFileSync(
      profile,
      `(version 1)(deny default)(allow process-exec)(allow process-fork)(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))(allow user-preference-read)(allow file-read*)
(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))
(allow file-write* (subpath "${work}"))(allow sysctl-read)(allow ipc-posix-sem)(allow pseudo-tty)(allow file-ioctl)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))`,
    );
    const script = join(work, 'open.mjs');
    writeFileSync(
      script,
      `import { openChromium } from ${JSON.stringify(join(import.meta.dirname, 'design-browser.mjs'))};
const opened = await openChromium({ workDir: ${JSON.stringify(join(work, 'chromium'))} });
if (!opened.browser) { console.log(JSON.stringify({ reason: opened.reason })); process.exit(0); }
const tab = await opened.browser.newTab({ width: 200, height: 100 });
await tab.setContent('<p>hi</p>');
const png = await tab.screenshot();
await tab.close();
await opened.browser.close();
console.log(JSON.stringify({ sandboxed: opened.sandboxed, png: png.subarray(1, 4).toString() }));`,
    );
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, script], {
      encoding: 'utf8',
      timeout: 90000,
    });
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), {
      sandboxed: true,
      png: 'PNG',
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("text cut by a phone screen's bottom or hidden under its tab bar is found when drawn", async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const page = `<!doctype html><html><body style="margin:0;font:17px/24px system-ui">
      <main data-layer="list"><p data-layer="row-1" style="margin:0;height:300px">Builds</p>
      <p data-layer="row-2" style="margin:0;height:300px">Releases</p>
      <p data-layer="row-3" style="margin:0;padding-top:170px;height:40px">Logs</p></main>
      <nav data-layer="tab-bar" style="position:fixed;left:0;right:0;bottom:0;height:83px;background:#fff">Home</nav>
      </body></html>`;
    const tab = await browser.newTab({ width: 390, height: 844 });
    try {
      const shot = await shootBoard(tab, page, { scheme: 'light', measure: false, inspect: true });
      assert.deepEqual(shot.inspected.clipped, [
        { layer: 'row-3', text: 'Logs', by: 'bar', frame: 'tab-bar' },
      ]);
      const cut = await shootBoard(tab, page.replace('padding-top:170px', 'padding-top:228px'), {
        scheme: 'light',
        measure: false,
        inspect: true,
      });
      assert.deepEqual(
        cut.inspected.clipped.map((entry) => [entry.layer, entry.by]),
        [['row-3', 'frame']],
      );
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('a disabled control is no second primary and owes no contrast; inner questions are marked', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const page = `<!doctype html><html><head><style>
      body{margin:0;background:#18171b;font:13px system-ui}
      .dl-btn{display:inline-block;padding:6px 12px;background:#ebe9ef;color:#1e1c21}
      .dl-btn:disabled,.dl-btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
      .faint{color:#77727f;background:#4a4752}
    </style></head><body>
      <button data-layer="publish" class="dl-btn primary">Publish</button>
      <button data-layer="comment-send" class="dl-btn primary faint" disabled>Comment</button>
      <a data-layer="retry" class="dl-btn primary faint" aria-disabled="true">Retry</a>
      <div data-layer="editor" data-component="design-editor" data-questions='{"draft-size":"Is the size the frame or the window?"}'>
        <span data-layer="draft-size" style="color:#fff">1440</span></div>
    </body></html>`;
    const tab = await browser.newTab({ width: 600, height: 300, scheme: 'dark' });
    try {
      const shot = await shootBoard(tab, page, { scheme: 'dark', measure: false, inspect: true });
      assert.deepEqual(shot.inspected.primaries, ['publish']);
      assert.deepEqual(
        shot.inspected.texts.filter((text) => text.inactive).map((text) => text.layer),
        ['comment-send', 'retry'],
      );
      assert.deepEqual(
        contrastProblems({
          file: 'A.html',
          title: 'A',
          width: 600,
          scheme: 'dark',
          after: shot.inspected,
          before: null,
          tokens: null,
        }),
        [],
      );
      assert.deepEqual(shot.questions, [
        { n: 1, layer: 'draft-size', question: 'Is the size the frame or the window?' },
      ]);
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('a question badge sits outside a short chip and covers no text', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const page = `<!doctype html><html><body style="margin:0;font:12px system-ui;padding:40px">
      <span data-layer="scheme" data-question="Which scheme is this comment about?" style="padding:2px 6px;border:1px solid #ccc">Light</span>
      <span data-layer="size" style="margin-left:2px">Web 1440</span>
      <p data-layer="at-edge" data-question="Is this the frame?" style="position:absolute;right:0;top:0;margin:0">Edge</p>
    </body></html>`;
    const tab = await browser.newTab({ width: 400, height: 200 });
    try {
      const shot = await shootBoard(tab, page, { scheme: 'light', measure: false, inspect: false });
      assert.equal(shot.questions.length, 2);
      const placed = await tab.evaluate(`(() => {
        const marks = document.body.lastElementChild;
        const badges = [...marks.children].filter((child) => child.textContent);
        const texts = [];
        for (const el of document.querySelectorAll('[data-layer]')) {
          const range = document.createRange();
          range.selectNodeContents(el);
          for (const box of range.getClientRects()) texts.push(box);
        }
        return badges.map((badge) => {
          const b = badge.getBoundingClientRect();
          return texts.some((r) => b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom);
        });
      })()`);
      assert.deepEqual(placed, [false, false], 'no badge covers any text');
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('a real design-editor instance keeps its data-questions through sync, and its badges draw', async (t) => {
  const library = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../design/ds/deploy-local/components/library.json'),
      'utf8',
    ),
  );
  const questions = { 'draft-size': "Is the size the frame's or the window's?" };
  // As an agent writes it: single quotes, an apostrophe inside, and a > in a hand-written prop.
  const written = renderComponent(
    library,
    'design-editor',
    { 'draft-size': 'Web 1440', draft: 'a -> b' },
    { layer: 'editor' },
  )
    .replace(/^<div /, `<div data-questions='${JSON.stringify(questions)}' `)
    .replace(/data-props="[^"]*"/, `data-props='{"draft-size":"Web 1440","draft":"a > b"}'`);
  const board = `<!doctype html><html><body>${written}</body></html>`;
  const once = syncInstances(board, library);
  const twice = syncInstances(once, library);
  for (const html of [once, twice]) {
    const root = /<div[^>]*data-component="design-editor"[^>]*>/.exec(html)[0];
    assert.deepEqual(instanceQuestions(root), questions);
    assert.match(html, /data-layer="draft-size"[^>]*>Web 1440</);
  }
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const tab = await browser.newTab({ width: 1440, height: 900 });
    try {
      const css = readFileSync(
        join(import.meta.dirname, '../design/ds/deploy-local/components/bundle.css'),
        'utf8',
      );
      const shot = await shootBoard(tab, twice.replace('<body>', `<body><style>${css}</style>`), {
        scheme: 'light',
        measure: false,
      });
      assert.deepEqual(shot.questions, [
        { n: 1, layer: 'draft-size', question: questions['draft-size'] },
      ]);
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});
