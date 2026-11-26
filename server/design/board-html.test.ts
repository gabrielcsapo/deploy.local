import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  boardLinks,
  assignLayerIds,
  convertCanvasBoard,
  layerIds,
  layerSnippet,
} from './board-html.ts';

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
      'app-nav',
      'new-task',
      'search',
      'search-icon',
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

  it('names a row for what it is about and what sits in it after the row, never by a bare value', () => {
    const html = assignLayerIds(
      '<main data-layer="kept-files"><div class="dl-group"><div class="dl-item"><svg width="16"><path d="M1"/></svg>' +
        '<span class="dl-t"><span>report.xml</span><span>212 KB</span></span>' +
        '<a class="dl-btn" aria-label="Download report.xml">Download</a></div>' +
        '<div class="dl-item"><span>typecheck</span><span>41 s</span></div></div><p>3</p><span>2m 58s</span></main>',
    );
    assert.deepEqual(layerIds(html), [
      'kept-files',
      'kept-files-group',
      'file-report-xml',
      'file-report-xml-icon',
      'file-report-xml-text',
      'file-report-xml-name',
      'file-report-xml-size',
      'file-report-xml-download',
      'typecheck',
      'typecheck-name',
      'typecheck-time',
      'kept-files-count',
      'kept-files-time',
    ]);
    assert.ok(layerIds(html).every((layer) => !/^\d/.test(layer)));
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

describe('board elements', () => {
  it('lists every element with its layer, markup and container, skipping comments and scripts', async () => {
    const { boardElements } = await import('./board-html.ts');
    const html =
      '<body><!-- <p data-layer="no">x</p> --><main data-layer="page"><img src="a.png"><p>One<br>two</p><script>if (a<b) x("<div>")</script><svg data-layer="icon"><path d="M0 0"/></svg></main></body>';
    assert.deepEqual(
      boardElements(html).map(({ layer, outer, parent }) => [layer, outer.slice(0, 24), parent]),
      [
        [null, '<body><!-- <p data-layer', -1],
        ['page', '<main data-layer="page">', 0],
        [null, '<img src="a.png">', 1],
        [null, '<p>One<br>two</p>', 1],
        [null, '<br>', 3],
        [null, '<script>if (a<b) x("<div', 1],
        ['icon', '<svg data-layer="icon"><', 1],
        [null, '<path d="M0 0"/>', 6],
      ],
    );
    assert.equal(boardElements(html)[1].outer, layerSnippet(html, 'page'));
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

  it('keeps the layer IDs an instance had on the elements it still draws when it renders again', async () => {
    const { syncInstances, layerIds } = await import('./board-html.ts');
    const library = {
      components: [
        {
          id: 'rows',
          name: 'Rows',
          props: [{ id: 'first', default: 'One' }],
          html: '<ul class="rows"><li class="row">{{first}}</li><li class="row">Two</li></ul>',
        },
      ],
    };
    // A comment points at "first-row", a name the board gave the element, not the library's.
    const board =
      '<body><ul data-layer="list" class="rows" data-props="{&quot;first&quot;:&quot;One&quot;}" data-component="rows" data-name="Rows"><li data-layer="first-row" class="row">One</li><li data-layer="second-row" class="row">Two</li></ul></body>';
    assert.equal(syncInstances(board, library), board);
    // The component changes: the rows are redrawn, and each keeps its ID.
    library.components[0].html =
      '<ul class="rows"><li class="row wide">{{first}}</li><li class="row wide">Two</li><li class="row wide">Three</li></ul>';
    const synced = syncInstances(board, library);
    assert.deepEqual(layerIds(synced).slice(0, 3), ['list', 'first-row', 'second-row']);
    assert.ok(synced.includes('<li data-layer="first-row" class="row wide">One</li>'));
    assert.equal(syncInstances(synced, library), synced);
  });
});

describe('board links', () => {
  it('marks full sidebars and collapsed rails regardless of attribute order', () => {
    for (const name of ['dl-side', 'rail', 'dz-rail']) {
      for (const tag of ['nav', 'aside']) {
        const links = boardLinks(
          `<${tag} class="${name}" data-layer="navigation"><a href="Projects.html" data-layer="projects">Projects</a></${tag}><a data-layer="open" href="App.html">Open app</a>`,
        );
        assert.deepEqual(links, [
          { layer: 'projects', to: 'Projects.html', text: 'Projects', sidebar: true },
          { layer: 'open', to: 'App.html', text: 'Open app', sidebar: false },
        ]);
      }
    }
  });

  it('keeps ordinary navigation links visible', () => {
    assert.equal(
      boardLinks(
        '<nav data-layer="links" class="links"><a data-layer="go" href="App.html">Go</a></nav>',
      )[0].sidebar,
      false,
    );
  });
});

describe('the design’s own boards', () => {
  it('draw the sidebar as an instance of the library’s Sidebar, in step with it', async () => {
    const { syncInstances } = await import('./board-html.ts');
    const boards = join(import.meta.dirname, '../../design/boards');
    const library = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../../design/ds/deploy-local/components/library.json'),
        'utf8',
      ),
    );
    const copies: string[] = [];
    const stale: string[] = [];
    for (const file of readdirSync(boards).filter((name) => name.endsWith('.html'))) {
      const html = readFileSync(join(boards, file), 'utf8');
      const sidebar = /<nav[^>]*class="dl-side[ "][^>]*>/.exec(html)?.[0];
      // The Mac update boards put the update card inside the sidebar, and the narrow Mac window
      // shows it as a temporary overlay; those keep their own markup.
      if (!sidebar || file.startsWith('MacUpdate') || file === 'MacChromeNarrow.html') continue;
      if (!sidebar.includes('data-component="sidebar"')) copies.push(file);
      else if (syncInstances(html, library) !== html) stale.push(file);
    }
    assert.deepEqual(copies, [], 'Place the Sidebar component instead of copying its markup');
    assert.deepEqual(stale, [], 'Render these boards again from the library (syncInstances)');
  });
});

// Merging follows stable layer IDs, independent of HTML line breaks.
describe('board element merges', () => {
  const base =
    '<main data-layer="page"><header data-layer="header">Old</header><p data-layer="release">One</p><footer data-layer="footer">End</footer></main>';
  it('keeps different elements, own tail text, attributes and child order', async () => {
    const { mergeBoard } = await import('./board-merge.ts');
    const main = base.replace('>One<', '>Two<');
    const proposal = base.replace('>Old<', '>New<');
    const result = mergeBoard(base, main, proposal);
    assert.equal(result.kind, 'kept-both');
    assert.equal(result.content, proposal.replace('>One<', '>Two<'));
    assert.match(result.detail, /header here, the release on main/);
    assert.equal(new Set(layerIds(result.content)).size, layerIds(result.content).length);
    const mixed = '<p data-layer="p">before <b data-layer="b">bold</b> after</p>';
    assert.equal(
      mergeBoard(mixed, mixed.replace(' after', ' tail'), mixed.replace('bold', 'strong')).content,
      mixed.replace(' after', ' tail').replace('bold', 'strong'),
    );
    const reordered = base.replace(
      '<header data-layer="header">Old</header><p data-layer="release">One</p>',
      '<p data-layer="release">One</p><header data-layer="header">Old</header>',
    );
    assert.equal(
      mergeBoard(base, reordered, proposal).content,
      reordered.replace('>Old<', '>New<'),
    );
  });
  it('chooses only overlapping elements and retains independent edits', async () => {
    const { mergeBoard } = await import('./board-merge.ts');
    const main = base.replace('>Old<', '>Main<').replace('>One<', '>Two<');
    const proposal = base.replace('>Old<', '>Proposal<').replace('>End<', '>Done<');
    for (const choice of ['main', 'proposal'] as const) {
      const result = mergeBoard(base, main, proposal, choice);
      assert.equal(result.kind, 'same-part');
      assert.equal(result.fallback, false);
      assert.equal(
        result.content,
        base
          .replace('>Old<', choice === 'main' ? '>Main<' : '>Proposal<')
          .replace('>One<', '>Two<')
          .replace('>End<', '>Done<'),
      );
    }
  });
  it('handles deletion against descendant edits without losing unrelated changes', async () => {
    const { mergeBoard } = await import('./board-merge.ts');
    const source = base.replace('Old', '<b data-layer="child">Old</b>');
    const main = source
      .replace('<header data-layer="header"><b data-layer="child">Old</b></header>', '')
      .replace('>One<', '>Two<');
    const proposal = source.replace('>Old<', '>New<').replace('>End<', '>Done<');
    for (const choice of ['main', 'proposal'] as const) {
      const result = mergeBoard(source, main, proposal, choice);
      assert.equal(result.kind, 'same-part');
      assert.equal(result.fallback, false);
      assert.match(result.content, />Two</);
      assert.match(result.content, />Done</);
      assert.equal(result.content.includes('data-layer="child"'), choice === 'proposal');
    }
  });
  it('keeps independent child additions and removals while conflicting orders need a choice', async () => {
    const { mergeBoard } = await import('./board-merge.ts');
    const main = base.replace(
      '<p data-layer="release">One</p>',
      '<p data-layer="new-main">Main addition</p>',
    );
    const proposal = base.replace(
      '<footer data-layer="footer">End</footer>',
      '<p data-layer="new-proposal">Proposal addition</p>',
    );
    const merged = mergeBoard(base, main, proposal);
    assert.equal(merged.kind, 'kept-both');
    assert.equal(merged.fallback, false);
    assert.match(merged.content, /Main addition/);
    assert.match(merged.content, /Proposal addition/);
    assert.doesNotMatch(merged.content, /data-layer="release"|data-layer="footer"/);
    const first = '<p data-layer="a">A</p>',
      second = '<p data-layer="b">B</p>';
    const a = base.replace('</main>', first + second + '</main>');
    const b = base.replace('</main>', second + first + '</main>');
    assert.equal(mergeBoard(base, a, b).kind, 'same-part');
  });
  it('falls back on malformed, missing or duplicate layers', async () => {
    const { mergeBoard } = await import('./board-merge.ts');
    for (const invalid of [
      '<p>Unlayered</p>',
      '<p data-layer="x"><b data-layer="y"></p>',
      '<p data-layer="x"></p><p data-layer="x"></p>',
    ]) {
      const result = mergeBoard(base, invalid, base.replace('Old', 'New'), 'main');
      assert.equal(result.fallback, true);
      assert.equal(result.kind, 'same-part');
      assert.equal(result.content, invalid);
    }
  });
});
