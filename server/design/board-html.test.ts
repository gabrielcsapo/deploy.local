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

describe('board edits', () => {
  const board =
    '<body><div data-layer="g" class="dl-greeting" style="gap:8px"><h1 data-layer="title" class="dl-title">Welcome</h1><span data-layer="mark" class="dl-mark">d</span><img data-layer="pic" src="a.png"></div></body>';
  it('retypes text, sets and clears styles, and changes classes, keeping layer IDs', async () => {
    const { applyEdits, layerIds } = await import('./board-html.ts');
    const edited = applyEdits(board, [
      { op: 'text', layer: 'title', text: 'Hi <there> & you' },
      { op: 'style', layer: 'title', prop: 'font-size', value: '30px' },
      { op: 'style', layer: 'g', prop: 'gap', value: '12px' },
      { op: 'style', layer: 'g', prop: 'padding', value: '0 16px' },
      { op: 'class', layer: 'mark', add: ['big'], remove: ['dl-mark'] },
      { op: 'style', layer: 'pic', prop: 'width', value: '40px' },
    ]);
    assert.ok(
      edited.includes(
        '<h1 data-layer="title" class="dl-title" style="font-size:30px">Hi &lt;there&gt; &amp; you</h1>',
      ),
    );
    assert.ok(
      edited.includes('<div data-layer="g" class="dl-greeting" style="gap:12px;padding:0 16px">'),
    );
    assert.ok(edited.includes('<span data-layer="mark" class="big">d</span>'));
    assert.ok(edited.includes('<img data-layer="pic" src="a.png" style="width:40px">'));
    assert.deepEqual(layerIds(edited), layerIds(board));
    const cleared = applyEdits(edited, [
      { op: 'style', layer: 'title', prop: 'font-size', value: null },
    ]);
    assert.ok(cleared.includes('<h1 data-layer="title" class="dl-title">Hi'));
  });
  it('reverts a layer to main and refuses edits it cannot make safely', async () => {
    const { applyEdits } = await import('./board-html.ts');
    const edited = applyEdits(board, [
      { op: 'text', layer: 'title', text: 'Changed' },
      { op: 'style', layer: 'title', prop: 'color', value: 'red' },
    ]);
    assert.equal(applyEdits(edited, [{ op: 'revert', layer: 'title' }], board), board);
    // One section's reset: only those properties go back; the text stays retyped.
    const colorBack = applyEdits(
      edited,
      [{ op: 'revert', layer: 'title', props: ['color'] }],
      board,
    );
    assert.ok(colorBack.includes('<h1 data-layer="title" class="dl-title">Changed'));
    assert.equal(
      applyEdits(colorBack, [{ op: 'revert', layer: 'title', text: true }], board),
      board,
    );
    assert.throws(
      () => applyEdits(board, [{ op: 'text', layer: 'g', text: 'x' }]),
      /Only a text layer/,
    );
    assert.throws(
      () => applyEdits(board, [{ op: 'style', layer: 'title', prop: 'color', value: 'red;x:y' }]),
      /Invalid value/,
    );
    assert.throws(
      () => applyEdits(board, [{ op: 'style', layer: 'title', prop: 'b@d', value: '1' }]),
      /Invalid style/,
    );
    assert.throws(
      () => applyEdits(board, [{ op: 'class', layer: 'title', add: ['a"b'] }]),
      /Invalid class/,
    );
    assert.throws(() => applyEdits(board, [{ op: 'text', layer: 'nope', text: 'x' }]), /no layer/);
  });
  it('draws shapes as positioned layers with new IDs, into the board or a stack, and removes layers', async () => {
    const { applyEdits, layerIds } = await import('./board-html.ts');
    const drawn = applyEdits(board, [
      { op: 'insert', shape: { kind: 'rectangle', x: 10, y: 20, w: 300, h: 80 } },
      { op: 'insert', shape: { kind: 'text', x: 5, y: 5, text: 'Note <b>' } },
      {
        op: 'insert',
        shape: {
          kind: 'vector',
          points: [
            [0, 0],
            [10, 20],
            [30, 5],
          ],
          closed: true,
        },
      },
    ]);
    assert.match(
      drawn,
      /<div data-layer="[a-z0-9-]+" data-name="Rectangle" style="position:absolute;left:10px;top:20px;width:300px;height:80px;/,
    );
    assert.ok(drawn.includes('>Note &lt;b&gt;</p>'));
    assert.ok(drawn.includes('d="M0 0 L10 20 L30 5 Z"'));
    assert.equal(layerIds(drawn).length, layerIds(board).length + 3);
    // Into the greeting stack, second: before the mark.
    const into = applyEdits(board, [
      { op: 'insert', parent: 'g', index: 1, shape: { kind: 'ellipse', x: 0, y: 0, w: 8, h: 8 } },
    ]);
    assert.match(
      into,
      /Welcome<\/h1><div data-layer="[^"]+" data-name="Ellipse"[^>]*><\/div><span data-layer="mark"/,
    );
    assert.throws(
      () =>
        applyEdits(board, [
          { op: 'insert', parent: 'pic', shape: { kind: 'frame', x: 0, y: 0, w: 1, h: 1 } },
        ]),
      /Only a container/,
    );
    const removed = applyEdits(board, [{ op: 'remove', layer: 'mark' }]);
    assert.ok(!removed.includes('dl-mark'));
    assert.deepEqual(layerIds(removed), ['g', 'title', 'pic']);
  });
  it('places component instances and renders them again when the component changes', async () => {
    const { applyEdits, syncInstances, layerIds } = await import('./board-html.ts');
    const library = {
      components: [
        {
          id: 'notice',
          name: 'Notice',
          props: [
            { id: 'tone', default: 'Warning', options: { Warning: 'warning', Neutral: '' } },
            { id: 'title', default: 'Hi' },
          ],
          html: '<div class="dl-banner {{tone}}"><span class="dl-t">{{title}}</span></div>',
        },
      ],
    };
    const placed = applyEdits(
      board,
      [
        {
          op: 'insert',
          parent: 'g',
          index: 0,
          component: { id: 'notice', props: { tone: 'Neutral', title: 'Docker <isn’t> up' } },
        },
      ],
      undefined,
      library,
    );
    assert.match(
      placed,
      /<div data-layer="([a-z0-9-]+)" class="dl-banner" data-props="\{&quot;tone&quot;:&quot;Neutral&quot;,&quot;title&quot;:&quot;Docker &lt;isn’t&gt; up&quot;\}" data-component="notice" data-name="Notice"><span data-layer="[^"]+" class="dl-t">Docker &lt;isn’t&gt; up<\/span><\/div><h1/,
    );
    const root = /<div data-layer="([a-z0-9-]+)" class="dl-banner"/.exec(placed)![1];
    // The component changes on main: every instance follows, keeping its layer and its values.
    library.components[0].html = '<p class="dl-notice {{tone}}"><b>{{title}}</b></p>';
    const synced = syncInstances(placed, library);
    assert.ok(synced.includes(`<p data-layer="${root}" class="dl-notice"`));
    assert.ok(synced.includes('>Docker &lt;isn’t&gt; up</b></p>'));
    assert.equal(syncInstances(synced, library), synced);
    assert.equal(layerIds(synced).filter((id) => id === root).length, 1);
    assert.throws(
      () => applyEdits(board, [{ op: 'insert', component: { id: 'nope' } }], undefined, library),
      /no component nope/,
    );
  });
});
