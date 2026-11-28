import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardPage, type ModelSheet } from './check-drawing.ts';
import { modelFindings } from './model-checks.ts';
import { modelPreviewPage, modelSource, paletteOfCss, parseModelBox } from './model-build.ts';

test('a model box reads as width, depth and height in metres; anything else is no box', () => {
  assert.deepEqual(parseModelBox('1x1x1'), [1, 1, 1]);
  assert.deepEqual(parseModelBox('1.4 × 1.4 × 2.5m'), [1.4, 1.4, 2.5]);
  assert.equal(parseModelBox('85x55mm'), null);
  assert.equal(parseModelBox('1x0x1'), null);
  assert.equal(parseModelBox(null), null);
});

test("a kit's palette is its --pal-* colours, by name", () => {
  assert.deepEqual(paletteOfCss(':root{--pal-wood: #A87650; --pal-bark:#6e4a33; --ink: #000}'), {
    wood: '#a87650',
    bark: '#6e4a33',
  });
});

test('a model is the first of its .py, .glb, .gltf and .blend in design/models/', async () => {
  const files: Record<string, string> = { 'models/Tree.glb': 'glb', 'models/Tree.blend': 'blend' };
  const read = (path: string) => (files[path] ? Buffer.from(files[path]) : null);
  assert.deepEqual(await modelSource('Tree', read), { ext: 'glb', source: Buffer.from('glb') });
  assert.equal(await modelSource('Crate', read), null);
  assert.equal(await modelSource('../Tree', read), null);
});

const board = (head: string) =>
  `<!doctype html><html><head><meta name="design-board" content="${head}"><link rel="stylesheet" href="../ds/k/model.css"></head><body><img data-model-view="front" alt="front"><img data-model-view="top" src="old.png" alt="top"><span data-model-stat="tris">Not counted yet</span><dd data-model-stat="size">Not drawn yet</dd></body></html>`;

const sheetOf = (page: string): ModelSheet =>
  JSON.parse(/<script type="application\/json" data-model-sheet>(.*?)<\/script>/.exec(page)![1]);

test("a model board's page gets each picture, its numbers and its sheet from the build", async () => {
  const asked: unknown[] = [];
  const page = await buildBoardPage(board('platform=model,model=Crate,size=1x1x2,tris=500'), {
    library: async () => null,
    css: async () => Buffer.from(':root{--pal-wood:#a87650}'),
    capture: async () => null,
    model: async (input) => {
      asked.push(input);
      return {
        stats: {
          model: 'Crate.py',
          box: [1, 1, 2],
          tris: 1234,
          bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1.5] },
        },
        views: { front: Buffer.from('front-png') },
        glb: null,
      };
    },
  });
  assert.deepEqual(asked, [{ name: 'Crate', palette: { wood: '#a87650' }, box: [1, 1, 2] }]);
  assert.match(page, /<img src="data:image\/png;base64,ZnJvbnQtcG5n" data-model-view="front"/);
  // A view the build has no picture of says so, in place of whatever src the board had.
  assert.match(
    page,
    /<img src="data:image\/svg\+xml;base64,[^"]+" data-model-view="top" alt="top">/,
  );
  assert.doesNotMatch(page, /old\.png/);
  assert.match(page, /<span data-model-stat="tris">1,234<\/span>/);
  assert.match(page, /<dd data-model-stat="size">1\.00 × 1\.00 × 1\.50 m<\/dd>/);
  const sheet = sheetOf(page);
  assert.equal(sheet.name, 'Crate');
  assert.equal(sheet.budget, 500);
  assert.equal(sheet.stats?.tris, 1234);
});

test('a model board with no model, no build or no Blender carries why', async () => {
  const sources = {
    library: async () => null,
    css: async () => null,
    capture: async () => null,
  };
  const none = sheetOf(await buildBoardPage(board('platform=model,size=1x1x1'), sources));
  assert.match(none.missing ?? '', /names no model/);
  const absent = sheetOf(
    await buildBoardPage(board('platform=model,model=Crate,size=1x1x1'), {
      ...sources,
      model: async () => null,
    }),
  );
  assert.match(absent.missing ?? '', /design\/models\/ has no Crate\.py/);
  const unbuilt = sheetOf(
    await buildBoardPage(board('platform=model,model=Crate,size=1x1x1'), {
      ...sources,
      model: async () => ({ unbuilt: 'No Blender here' }),
    }),
  );
  assert.equal(unbuilt.unbuilt, 'No Blender here');
  const findings = modelFindings({ file: 'M.html', title: 'M', model: unbuilt });
  assert.deepEqual(
    findings.notes.map((entry) => entry.code),
    ['model_not_drawn'],
  );
  assert.deepEqual(findings.problems, []);
  assert.deepEqual(
    modelFindings({ file: 'M.html', title: 'M', model: none }).problems.map((entry) => entry.code),
    ['model_missing'],
  );
});

const sheet = (stats: Partial<NonNullable<ModelSheet['stats']>>, extra: Partial<ModelSheet> = {}) =>
  ({
    name: 'Crate',
    box: [1, 1, 1],
    budget: 500,
    palette: { wood: '#a87650' },
    stats: {
      model: 'Crate.py',
      box: [1, 1, 1],
      tris: 100,
      bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1] },
      colours: [{ colour: '#a87650', material: 'pal-wood', tris: 100 }],
      uncoloured: 0,
      views: {},
      ...stats,
    },
    ...extra,
  }) as ModelSheet;

const codes = (model: ModelSheet) => {
  const found = modelFindings({ file: 'M.html', title: 'M', model });
  return { problems: found.problems.map((e) => e.code), notes: found.notes.map((e) => e.code) };
};

test('a model that fits its box, budget and palette passes', () => {
  assert.deepEqual(codes(sheet({})), { problems: [], notes: [] });
  // A palette colour within a rounding of its value is the palette's.
  assert.deepEqual(
    codes(sheet({ colours: [{ colour: '#a97650', material: 'pal-wood', tris: 100 }] })).problems,
    [],
  );
});

test('a model that stopped, floats, sinks, is small, is cut off or has no material is said so', () => {
  assert.deepEqual(codes(sheet({ error: 'NameError: x', line: 3 })).problems, [
    'model_build_failed',
  ]);
  assert.deepEqual(codes(sheet({ bounds: { min: [-0.5, -0.5, 0.2], max: [0.5, 0.5, 1] } })).notes, [
    'model_off_ground',
  ]);
  const sinks = modelFindings({
    file: 'M.html',
    title: 'M',
    model: sheet({ bounds: { min: [-0.5, -0.5, -0.1], max: [0.5, 0.5, 0.9] } }),
  });
  assert.match(sinks.notes[0].label, /sinks/);
  assert.deepEqual(sinks.problems, []);
  assert.deepEqual(codes(sheet({ bounds: { min: [-0.2, -0.2, 0], max: [0.2, 0.2, 0.4] } })).notes, [
    'model_framing',
  ]);
  const cut = modelFindings({
    file: 'M.html',
    title: 'M',
    model: sheet({
      views: {
        front: { drawn: 0.5, bounds: [0, 0, 1, 1], edges: ['right'], box: [], boxEdges: [] },
      },
    }),
  });
  assert.match(cut.problems[0].detail, /cut off in the front \(right\)/);
  assert.match(
    modelFindings({ file: 'M.html', title: 'M', model: sheet({ uncoloured: 12 }) }).problems[0]
      .detail,
    /12 triangles with no material/,
  );
  // No palette in the kit: colours are not judged.
  assert.deepEqual(
    codes(sheet({ colours: [{ colour: '#ff00ff', material: 'x', tris: 1 }] }, { palette: {} }))
      .problems,
    [],
  );
});

test('a model past its box names the parts that leave it, the furthest first', () => {
  const found = modelFindings({
    file: 'M.html',
    title: 'M',
    model: sheet({
      bounds: { min: [-0.5, -0.5, 0], max: [0.8, 0.5, 1.2] },
      parts: [
        { name: 'body', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1] },
        { name: 'handle', min: [0.4, -0.1, 0.4], max: [0.8, 0.1, 0.6] },
        { name: 'lid', min: [-0.5, -0.5, 1], max: [0.5, 0.5, 1.2] },
      ],
    }),
  });
  assert.equal(found.problems[0].code, 'model_out_of_bounds');
  assert.match(found.problems[0].detail, /the parts past it: handle, lid/);
});

test("a model's preview page carries the model and turns it with three.js", () => {
  const page = modelPreviewPage({
    name: 'Crate <1>',
    glb: Buffer.from('glTF'),
    stats: { model: 'Crate.py', box: [1, 1, 1], tris: 344 },
  });
  assert.match(page, /<title>Crate &#60;1&#62;<\/title>/);
  assert.match(page, /const glb = 'Z2xURg==';/);
  assert.match(page, /"three":"https:\/\/unpkg\.com\/three@0\.\d+\.\d+\/build\/three\.module\.js"/);
  assert.match(page, /344 triangles/);
});
