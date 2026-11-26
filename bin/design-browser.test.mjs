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
      <a data-layer="row-3" href="Logs.html" style="display:block;margin:0;padding-top:170px;height:40px">Logs</a></main>
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

test('a list row behind a phone tab bar is found when drawn; plain text running on under it is the scroll', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    // A phone frame as the starter draws one: a scrolling body above a tab bar in a column.
    const page = `<!doctype html><html><body style="margin:0;font:17px/24px system-ui">
      <div class="dl-phone" data-layer="phone" style="display:flex;flex-direction:column;width:390px;height:844px;overflow:hidden">
        <div data-layer="body" style="flex:1;overflow:auto">
          <div style="height:740px">Pantry</div>
          <a data-layer="show-more" class="dl-ph-row" href="#" style="display:block;height:44px">Show 10 more</a>
          <p data-layer="footnote" style="margin:200px 0 0">Kept with this run.</p>
        </div>
        <nav data-layer="tab-bar" class="dl-tabbar" style="height:83px;flex:none;background:#fff">Pantry</nav>
      </div></body></html>`;
    const tab = await browser.newTab({ width: 390, height: 844 });
    try {
      const shot = await shootBoard(tab, page, { scheme: 'light', measure: false, inspect: true });
      assert.deepEqual(shot.inspected.clipped, [
        { layer: 'show-more', text: 'Show 10 more', by: 'bar', frame: 'tab-bar' },
      ]);
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('form fields in a dialog card are no box in a card; a bordered box in a card still is', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const box = 'border:1px solid #ddd;border-radius:8px;background:#fff';
    const page = `<!doctype html><html><body style="margin:0;padding:40px;font:15px system-ui">
      <div data-layer="dialog" role="dialog" style="${box};width:480px;padding:24px">
        <label>Name</label>
        <input data-layer="name" style="${box};display:block;width:300px;height:44px">
        <div data-layer="name-field" style="${box};width:300px;height:44px"><input style="border:0;width:280px"></div>
        <textarea data-layer="note" style="${box};width:300px;height:80px"></textarea>
        <div data-layer="seg" role="radiogroup" style="${box};width:300px;height:44px"><button>Pantry</button><button>Fridge</button></div>
        <div data-layer="inner-card" style="${box};width:300px;height:100px">A card in a card</div>
      </div></body></html>`;
    const tab = await browser.newTab({ width: 600, height: 700 });
    try {
      const shot = await shootBoard(tab, page, { scheme: 'light', measure: false, inspect: true });
      assert.deepEqual(shot.inspected.boxes, [{ layer: 'inner-card', inside: 'dialog' }]);
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});

test('a print piece is drawn at 8 px per millimetre, a document in a short window is measured whole, and @page margins are read', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  const { smallContrast, decodePng, pngSize } = await import('../server/design/kind-checks.ts');
  const { CSS_PX_PER_MM, PRINT_PX_PER_MM } = await import('../shared/v2/design-platforms.ts');
  try {
    // 91 x 61 mm: trim 85 x 55 and 3 mm of bleed, drawn at 8 px/mm.
    const card = `<!doctype html><body style="margin:0"><div style="width:91mm;height:61mm;background:#fff1c8"><p style="margin:0;padding:7mm;font:11pt serif">Name</p></div></body>`;
    const tab = await browser.newTab({
      width: Math.round(91 * CSS_PX_PER_MM),
      height: Math.round(61 * CSS_PX_PER_MM),
      scheme: 'light',
      scale: PRINT_PX_PER_MM / CSS_PX_PER_MM,
    });
    try {
      const shot = await shootBoard(tab, card, { scheme: 'light', measure: true, inspect: true });
      const size = pngSize(shot.png);
      assert.ok(
        Math.abs(size.width - 91 * 8) <= 1 && Math.abs(size.height - 61 * 8) <= 1,
        JSON.stringify(size),
      );
      assert.ok(decodePng(shot.png).rgba.length === size.width * size.height * 4);
      // A text starts 7 mm in, in CSS px.
      assert.ok(Math.abs(shot.inspected.texts[0].left - 7 * CSS_PX_PER_MM) < 1);
    } finally {
      await tab.close();
    }

    // A document in a 100 px window: its height is what it needs, never the window's.
    const doc = `<!doctype html><html><head><style>@page{size:A4;margin:24mm 20mm}body{margin:0;font:16px serif}</style></head><body><h1>Title</h1><div style="height:2000px">Long</div></body></html>`;
    const docTab = await browser.newTab({ width: 700, height: 100, scheme: 'light' });
    try {
      const shot = await shootBoard(docTab, doc, {
        scheme: 'light',
        measure: false,
        inspect: true,
        fullPage: true,
      });
      assert.ok(
        shot.inspected.height >= 2000 && shot.inspected.height < 2200,
        String(shot.inspected.height),
      );
      assert.equal(pngSize(shot.png).height, shot.inspected.height, 'the whole page is pictured');
      assert.equal(shot.inspected.headings[0].text, 'Title');
      const margin = shot.inspected.pageMargin;
      assert.ok(
        Math.abs(margin.top - 24 * CSS_PX_PER_MM) < 1 &&
          Math.abs(margin.left - 20 * CSS_PX_PER_MM) < 1,
      );
    } finally {
      await docTab.close();
    }

    // A short page in a tall window: the window is not what a board needs.
    const short = '<!doctype html><body style="margin:0"><p>One line</p></body>';
    const tall = await browser.newTab({ width: 700, height: 900, scheme: 'light' });
    const little = await browser.newTab({ width: 700, height: 100, scheme: 'light' });
    try {
      const big = await shootBoard(tall, short, { scheme: 'light', measure: false, inspect: true });
      const natural = await shootBoard(little, short, {
        scheme: 'light',
        measure: false,
        inspect: true,
      });
      assert.equal(big.inspected.height, 900, 'a tall window gives its own height back');
      assert.equal(
        natural.inspected.height,
        100,
        'a short window gives what the page needs, at least its own',
      );
    } finally {
      await tall.close();
      await little.close();
    }

    // A mark that fills its ground reads at 16 px; a faint one does not.
    const mark = async (fill) => {
      const markTab = await browser.newTab({ width: 256, height: 256, scheme: 'light' });
      try {
        const page = `<!doctype html><body style="margin:0;background:#fff"><div style="margin:96px;width:64px;height:64px;background:${fill}"></div></body>`;
        return (await shootBoard(markTab, page, { scheme: 'light', measure: false })).png;
      } finally {
        await markTab.close();
      }
    };
    assert.ok(smallContrast(await mark('#1c1b1f')).contrast > 3);
    assert.ok(smallContrast(await mark('#f1f1f1')).contrast < 3);
  } finally {
    await browser.close();
  }
});

test('the pair picture lays out pages, a print piece with marks outside it, a sheet of sizes, and a new board alone', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  const { pngSize } = await import('../server/design/kind-checks.ts');
  try {
    const draw = async (width, height, color) => {
      const tab = await browser.newTab({ width, height, scheme: 'light' });
      try {
        return await shootBoard(
          tab,
          `<!doctype html><body style="margin:0;background:${color}"><p>Hello</p></body>`,
          { scheme: 'light', measure: false },
        );
      } finally {
        await tab.close();
      }
    };
    const picture = async (input) => {
      const tab = await browser.newTab({ width: 1200, height: 700, scheme: 'light' });
      try {
        await tab.setContent(pairPage(input));
        return { html: pairPage(input), png: await tab.screenshot({ fullPage: true }) };
      } finally {
        await tab.close();
      }
    };
    const after = (await draw(728, 488, '#ffe9a8')).png;
    const print = await picture({
      before: null,
      after,
      width: 728,
      scheme: 'light',
      layout: { kind: 'print', pxPerMm: 8, trim: { w: 85, h: 55 }, bleed: 3, safe: 4 },
    });
    assert.match(print.html, /New board · 728 · light/);
    assert.doesNotMatch(print.html, /Before/);
    assert.doesNotMatch(print.html, /no Before/);
    // The guides sit in a margin around the picture: it grows by the margin on every side.
    assert.ok(pngSize(print.png).width >= 728 + 64 && pngSize(print.png).height >= 488 + 64);
    // Marks are lines in the margin, never drawn over the picture.
    const svg = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(print.html)[1];
    for (const [, x1, y1, x2, y2] of svg.matchAll(
      /x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g,
    )) {
      const insidePicture = (x, y) => x > 32 && x < 32 + 728 && y > 32 && y < 32 + 488;
      assert.equal(insidePicture(+x1, +y1) || insidePicture(+x2, +y2), false);
    }

    const tall = (await draw(300, 1000, '#cfe')).png;
    const pages = await picture({
      before: tall,
      after: tall,
      width: 300,
      scheme: 'light',
      layout: { kind: 'pages', pageWidth: 300, pageHeight: 400 },
    });
    assert.equal((pages.html.match(/Page \d of 3/g) ?? []).length, 6, 'three sheets, each side');
    assert.match(pages.html, /Before · main/);

    const sheet = await picture({
      before: null,
      after: (await draw(256, 256, '#123')).png,
      width: 700,
      scheme: 'light',
      layout: { kind: 'sheet', sizes: [512, 128, 64, 32, 16] },
    });
    assert.deepEqual(
      [...sheet.html.matchAll(/<figcaption>(\d+) px/g)].map((m) => +m[1]),
      [512, 128, 64, 32, 16],
    );
  } finally {
    await browser.close();
  }
});

test("Chromium's PDFs of boards at different sizes join into one, a page each, a document running over", async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  const { mergePdfs } = await import('./design-export.mjs');
  try {
    const print = async (width, height, paperHeight, html) => {
      const tab = await browser.newTab({ width, height, scheme: 'light', media: 'print' });
      try {
        await tab.setContent(`<!doctype html><body style="margin:0">${html}</body>`);
        return await tab.pdf({ paperWidth: width, paperHeight });
      } finally {
        await tab.close();
      }
    };
    const slide = await print(1920, 1080, 1080, '<h1>Slide</h1>');
    const doc = await print(794, 100, 1123, '<h1>Doc</h1><div style="height:1600px">x</div>');
    const merged = mergePdfs([slide, doc]);
    assert.equal(merged.pages, 3);
    const text = merged.pdf.toString('latin1');
    assert.match(text, /^%PDF-1\.4/);
    assert.equal((text.match(/\/Type \/Page\b(?!s)/g) ?? []).length, 3);
    const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) =>
      Math.round(+m[1]),
    );
    assert.deepEqual(boxes, [1440, 596, 596], 'the slide is 1920 px wide, the document an A4 page');
    assert.match(text, /startxref\n\d+\n%%EOF\n$/);
  } finally {
    await browser.close();
  }
});

test('content cut at the sides is found when drawn: a clipped grid is; a sideways scroller, a bleed and an ellipsis are not', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    const page = (body) =>
      `<!doctype html><html><body style="margin:0;font:14px/20px system-ui">${body}</body></html>`;
    const draw = async (body, width = 390) => {
      const tab = await browser.newTab({ width, height: 600 });
      try {
        return (
          await shootBoard(tab, page(body), { scheme: 'light', measure: true, inspect: true })
        ).inspected;
      } finally {
        await tab.close();
      }
    };
    // A frame that hides overflow, a grid wider than it: the right column is cut.
    const cut = await draw(
      `<div data-layer="screen" style="width:390px;overflow:hidden;padding:0 16px;box-sizing:border-box">
        <div data-layer="grid" style="display:grid;grid-template-columns:repeat(4,96px);gap:12px;width:420px">
          <div data-layer="t1">1</div><div data-layer="t2">2</div><div data-layer="t3">3</div><div data-layer="t4">4</div>
        </div></div>`,
    );
    assert.deepEqual(
      cut.clippedSide.map((entry) => [entry.layer, entry.side, entry.by, entry.frame]),
      [['grid', 'right', 'frame', 'screen']],
      'the outermost layer that runs past, not every tile in it',
    );
    // The same grid fitted inside: nothing is cut.
    const fits = await draw(
      `<div data-layer="screen" style="width:390px;overflow:hidden;padding:0 16px;box-sizing:border-box">
        <div data-layer="grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px"><div data-layer="t1">1</div><div data-layer="t4">4</div></div></div>`,
    );
    assert.deepEqual(fits.clippedSide, []);
    // A row that scrolls sideways on purpose carries its chips, and the words there are no text_cut_off.
    const scroller = await draw(
      `<div data-layer="chips" style="display:flex;gap:8px;overflow-x:auto"><span data-layer="a" style="flex:none;width:200px">Alpha</span><span data-layer="b" style="flex:none;width:200px">Beta</span></div>`,
    );
    assert.deepEqual(scroller.clippedSide, []);
    const scrollTab = await browser.newTab({ width: 390, height: 600 });
    try {
      const shot = await shootBoard(
        scrollTab,
        page(
          `<div data-layer="chips" style="display:flex;gap:8px;overflow-x:auto"><span style="flex:none;width:200px">Alpha</span><span style="flex:none;width:200px">Beta</span></div>`,
        ),
        { scheme: 'light', measure: true },
      );
      assert.equal(shot.measured.cut, null);
    } finally {
      await scrollTab.close();
    }
    // A column that scrolls down is no sideways scroller: what runs past its side is cut.
    const column = await draw(
      `<div data-layer="col" style="width:390px;height:200px;overflow-y:auto"><div data-layer="wide" style="width:500px;height:400px">Wide</div></div>`,
    );
    assert.deepEqual(
      column.clippedSide.map((entry) => [entry.layer, entry.by]),
      [['wide', 'page']],
    );
    // Marked bleed, a decorative aria-hidden glow and ellipsised text are meant.
    const meant = await draw(
      `<div data-layer="stage" style="width:390px;overflow:hidden">
        <div data-layer="glow" aria-hidden="true" style="width:200px;height:200px;margin-left:300px">g</div>
        <div data-layer="art" data-bleed style="width:200px;height:50px;margin-left:300px">a</div>
        <div data-layer="deco" style="position:absolute;width:200px;height:50px;left:300px;top:300px;background:#ccc"></div>
        <div data-layer="empty" style="width:200px;height:50px;margin-left:300px"></div>
        <div data-layer="plain" style="width:200px;height:50px;margin-left:300px;background:#ccc"></div>
        <div data-layer="name" style="width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A very long name that is ellipsised</div></div>`,
    );
    assert.deepEqual(
      meant.clippedSide.map((entry) => [entry.layer, entry.plain]),
      [['plain', true]],
      'an unmarked shape is reported as plain, so a print piece can let its bleed through',
    );
  } finally {
    await browser.close();
  }
});

test('what a board needs is measured through a window-sized frame and absolute layers, and a status bar is found', async (t) => {
  const { browser, reason } = await openChromium();
  if (!browser) return t.skip(`no browser here: ${reason}`);
  try {
    // A Mac window at 100% of a desk 100vh tall: in a short window its content is clipped.
    const page = `<!doctype html><html><body style="margin:0;font:14px/20px system-ui">
      <div data-layer="desk" style="width:100vw;height:100vh">
        <div data-layer="window" style="position:relative;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;border:1px solid #999;box-sizing:border-box">
          <header data-layer="titlebar" style="height:40px">Settings</header>
          <div data-layer="form" style="padding:12px 12px 20px"><p style="margin:0;height:200px">Menu bar</p></div>
          <div data-layer="note" style="position:absolute;left:12px;top:300px;height:20px">Pinned note</div>
        </div></div>
      <div class="ds-statusbar" data-layer="statusbar" style="height:54px">9:41</div>
      </body></html>`;
    const tab = await browser.newTab({ width: 640, height: 100 });
    try {
      const shot = await shootBoard(tab, page, { scheme: 'light', measure: false, inspect: true });
      // The page itself is as short as the window; the board needs the form (40 + 12 + 200 + 20)
      // and the pinned note at 300 + 20.
      assert.equal(shot.inspected.height >= 100, true);
      assert.ok(shot.inspected.needed >= 320, `needed ${shot.inspected.needed}`);
      assert.ok(shot.inspected.needed < 420, `needed ${shot.inspected.needed}`);
      assert.deepEqual(
        shot.inspected.statusBars.map((bar) => bar.layer),
        ['statusbar'],
      );
    } finally {
      await tab.close();
    }
  } finally {
    await browser.close();
  }
});
