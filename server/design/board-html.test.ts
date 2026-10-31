import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { assignLayerIds, convertCanvasBoard, layerIds, layerSnippet } from './board-html.ts';

const exported = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Welcome</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="ds/deploy-local/tokens.css">
</head>
<body>
<x-dc>
<helmet>
<style>.x{color:red}</style>
</helmet>
<div class="dl-app"><a href="Home.dc.html" class="dl-nav"><span class="dl-t">New task</span></a>
<button aria-label="Search"><svg width="16" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3"/></svg></button>
<h1 class="dl-title">Welcome to deploy.local</h1><br><span class="dl-t">New task</span></div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1440,"height":900}}'>
class Component extends DCLogic {}
</script>
</body>
</html>
`;

describe('design boards', () => {
  it('turns a canvas export into a standalone page', () => {
    const { html, size } = convertCanvasBoard(exported);
    assert.deepEqual(size, { width: 1440, height: 900 });
    assert.ok(html.includes('<meta name="design-board" content="width=1440,height=900">'));
    assert.ok(html.includes('href="../ds/deploy-local/tokens.css"'));
    assert.ok(html.includes('href="Home.html"'));
    assert.match(html, /<style>\.x\{color:red\}<\/style>\n<\/head>/);
    for (const gone of ['<x-dc>', '</x-dc>', '<helmet>', 'support.js', 'DCLogic'])
      assert.ok(!html.includes(gone), gone);
  });

  it('names every body element once, skipping icon internals, and keeps existing IDs', () => {
    const html = assignLayerIds(convertCanvasBoard(exported).html);
    assert.deepEqual(layerIds(html), [
      'app',
      'nav',
      'new-task',
      'search',
      'svg',
      'welcome-to-deploy',
      'new-task-2',
    ]);
    assert.ok(!/<(circle|path|br)[^>]*data-layer/.test(html));
    assert.ok(!/<(head|meta|style|title)[^>]*data-layer/.test(html));
    const edited = html.replace('</div>', '<p class="dl-meta">Added</p></div>');
    const again = assignLayerIds(edited);
    assert.deepEqual(layerIds(again).slice(0, 7), layerIds(html));
    assert.ok(again.includes('<p data-layer="added" class="dl-meta">Added</p>'));
    assert.equal(assignLayerIds(again), again);
  });

  it('finds one layer’s markup, including nested elements of the same tag', () => {
    const html =
      '<body><div data-layer="a"><div data-layer="b"><span data-layer="c">Hi</span></div><br data-layer="d"></div><div data-layer="e"></div></body>';
    assert.equal(
      layerSnippet(html, 'a'),
      '<div data-layer="a"><div data-layer="b"><span data-layer="c">Hi</span></div><br data-layer="d"></div>',
    );
    assert.equal(layerSnippet(html, 'c'), '<span data-layer="c">Hi</span>');
    assert.equal(layerSnippet(html, 'd'), '<br data-layer="d">');
    assert.equal(layerSnippet(html, 'missing'), null);
  });

  it('keeps design/ consistent: every board exists, is standalone, and has unique layer IDs', () => {
    const root = new URL('../../design/', import.meta.url).pathname;
    if (!existsSync(join(root, 'canvas.json'))) return;
    const canvas = JSON.parse(readFileSync(join(root, 'canvas.json'), 'utf8')) as {
      boards: Record<string, { w: number; h: number }>;
    };
    const files = readdirSync(join(root, 'boards')).filter((file) => file.endsWith('.html'));
    assert.deepEqual(Object.keys(canvas.boards).sort(), files.sort());
    for (const file of files) {
      const html = readFileSync(join(root, 'boards', file), 'utf8');
      assert.ok(!/<x-dc>|<helmet>|support\.js|\.dc\.html/.test(html), file);
      const ids = layerIds(html);
      assert.ok(ids.length > 0, `${file} has no layers`);
      assert.equal(new Set(ids).size, ids.length, `${file} repeats a layer ID`);
    }
  });
});

describe('layer changes', () => {
  it('reports text, style, class and attribute changes per layer, and added or removed layers', async () => {
    const { layerChanges } = await import('./board-html.ts');
    const before =
      '<body><h1 data-layer="title" class="dl-title">Welcome</h1><div data-layer="g" class="dl-greeting" style="gap:8px"><p data-layer="old">Bye</p></div></body>';
    const after =
      '<body><h1 data-layer="title" class="dl-title big" style="font-size:30px;line-height:36px">Welcome to deploy.local</h1><div data-layer="g" class="dl-greeting" style="gap:12px" aria-label="Greeting"><span data-layer="new">New</span></div></body>';
    assert.deepEqual(layerChanges(before, after), [
      {
        layer: 'title',
        change: 'changed',
        details: [
          'Text “Welcome” → “Welcome to deploy.local”',
          'font-size 30px',
          'line-height 36px',
          'Class +big',
        ],
      },
      { layer: 'g', change: 'changed', details: ['gap 8px → 12px', 'aria-label “Greeting”'] },
      { layer: 'new', change: 'added', details: ['Text “New”'] },
      { layer: 'old', change: 'removed', details: [] },
    ]);
    assert.deepEqual(layerChanges(before, before), []);
  });
});
