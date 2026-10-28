import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Bundle the real TSX and shared components; CSS is verified in the visual fixture.
test('Conversation renders every typed variant, folds work and retains decision rendering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-chat-render-'));
  const esbuild = createRequire(import.meta.resolve('vite'))('esbuild');
  const output = join(root, 'render.mjs');
  try {
    await esbuild.build({
      stdin: {
        contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { Conversation } from './app/routes/dashboard/v2/conversation/Conversation';
        import { InboxProvider } from './app/routes/dashboard/v2/data/hooks';
        export const render = (events, resources) => renderToStaticMarkup(React.createElement(InboxProvider, null, React.createElement(Conversation, { events, resources })));
      `,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      loader: { '.css': 'empty' },
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: 'silent',
    });
    const { render } = await import(pathToFileURL(output).href);
    const at = '2026-10-27T12:00:00Z';
    const events = [
      { kind: 'you', id: 'y', at, text: '<script>hello</script>', attachments: [] },
      { kind: 'reply', id: 'r', at, agent: 'scout', paragraphs: ['Ready for review'] },
      {
        kind: 'worklog',
        id: 'w',
        at,
        summary: 'Worked for 3m',
        live: false,
        steps: [{ icon: 'terminal', text: 'pnpm test' }],
      },
      { kind: 'decision', id: 'd', at, inboxItemId: 'question:q' },
      { kind: 'task', id: 't', at, taskId: 'one' },
      { kind: 'release', id: 'l', at, releaseId: 'sha' },
      { kind: 'screenshot', id: 's', at, screenshotId: 'shot' },
      {
        kind: 'report',
        id: 'p',
        at,
        title: 'Report',
        sections: [{ title: 'Checks', body: 'Passed' }],
      },
    ];
    const html = render(events, {
      releases: [
        { id: 'sha', projectId: 'p', state: 'live', steps: [{ name: 'prepare', state: 'done' }] },
      ],
      screenshots: [{ id: 'shot', target: { kind: 'web', device: 'Laptop' }, image: '/shot.png' }],
    });
    assert.match(html, /&lt;script&gt;hello/);
    assert.match(html, /Ready for review/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /hidden=""/);
    assert.match(html, /Loading decision/);
    assert.match(html, /dashboard\/tasks\/one/);
    assert.match(html, /Release sha · Live/);
    assert.match(html, /Screenshot · Laptop/);
    assert.match(html, /Report/);
    assert.doesNotMatch(html, />Ship/);
    const older = render(
      [
        { ...events[1], id: 'old', at: '2026-10-26T12:00:00Z' },
        { ...events[3], at: '2026-10-26T13:00:00Z' },
        events[0],
      ],
      {},
    );
    assert.match(older, /<details class="dl-chat-history">/);
    assert.ok(older.indexOf('Loading decision') > older.indexOf('</details>'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
