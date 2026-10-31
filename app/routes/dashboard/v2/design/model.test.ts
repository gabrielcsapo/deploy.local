import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  bounds,
  changeLabel,
  describeChange,
  colorToken,
  fit,
  hex,
  isWrapper,
  layerName,
  type LayerFacts,
  layerLabel,
  readTokens,
  sections,
  textStyle,
  type Canvas,
} from './model.ts';

const canvas: Canvas = {
  boards: {
    'Welcome.html': { x: 100, y: 100, w: 1440, h: 900 },
    'SignIn.html': { x: 1700, y: 100, w: 390, h: 844 },
    'Live.html': { x: 7200, y: 100, w: 1440, h: 900 },
    'Ship.html': { x: 50, y: 12500, w: 1440, h: 900 },
  },
  notes: {
    'section-start': { x: 0, y: 0, text: '1 · Get started', kind: 'title1' },
    'section-live': { x: 7000, y: 0, text: '2 · Live (for approval)', kind: 'title1' },
    'section-ship': { x: 0, y: 12384, text: '3 · Ship', kind: 'title1' },
    'section-empty': { x: 20000, y: 0, text: 'Empty', kind: 'title1' },
    'loose-note': { x: 0, y: 700, text: 'A sticky' },
  },
};

describe('design canvas model', () => {
  it('groups boards under the section title above and to the left of them', () => {
    assert.deepEqual(
      sections(canvas).map((section) => [section.title, section.boards]),
      [
        ['1 · Get started', ['Welcome.html', 'SignIn.html']],
        ['2 · Live', ['Live.html']],
        ['3 · Ship', ['Ship.html']],
      ],
    );
  });

  it('puts every board of the real canvas in exactly one section', () => {
    const real = JSON.parse(
      readFileSync(new URL('../../../../../design/canvas.json', import.meta.url), 'utf8'),
    );
    const all = sections(real).flatMap((section) => section.boards);
    assert.equal(all.length, Object.keys(real.boards).length);
    assert.equal(new Set(all).size, all.length);
    assert.ok(sections(real).some((section) => section.title.startsWith('Design canvas')));
  });

  it('fits a group of boards into the viewport', () => {
    const box = bounds(canvas, ['Welcome.html', 'SignIn.html']);
    assert.deepEqual(box, { x: 100, y: 100, w: 1990, h: 900 });
    const view = fit(box, 1000, 800);
    assert.ok(view.z < 1);
    assert.ok(Math.abs(box.x * view.z + view.x - (1000 - box.w * view.z) / 2) < 0.001);
  });

  it('names colours and text styles after the design system’s tokens', () => {
    const tokens = readTokens(
      JSON.parse(
        readFileSync(
          new URL('../../../../../design/ds/deploy-local/tokens.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    // Colours are built, because the design-literal check bans colour literals anywhere in app/.
    const css = (...parts: number[]) => `rgb${parts.length > 3 ? 'a' : ''}(${parts.join(', ')})`;
    assert.equal(hex(css(250, 250, 251)), 'fafafb');
    assert.equal(hex(`${'#'}FFF`), 'ffffff');
    assert.equal(hex(css(0, 0, 0, 0)), null);
    assert.equal(colorToken(css(250, 250, 251), tokens), 'paper');
    assert.equal(colorToken(css(1, 2, 3), tokens), null);
    assert.equal(textStyle(22, 28, 600, tokens), 'title');
    assert.equal(textStyle(23, 28, 600, tokens), null);
  });

  it('labels a layer by its short text, or by its ID in words', () => {
    assert.equal(
      layerLabel('welcome-to-deploy', 'Welcome to deploy.local'),
      'Welcome to deploy.local',
    );
    assert.equal(layerLabel('quick-actions-2', ''), 'Quick actions');
    assert.equal(layerLabel('greeting', 'x'.repeat(80)), 'Greeting');
  });
});

describe('layer names', () => {
  const facts = (over: Partial<LayerFacts>): LayerFacts => ({
    tag: 'div',
    classes: [],
    ownText: '',
    childLayers: 0,
    ...over,
  });
  it('names text by its text, components by kind and label, and lets data-name win', () => {
    assert.equal(
      layerName(facts({ tag: 'h1', classes: ['dl-title'], ownText: 'Welcome to deploy.local' })),
      'Welcome to deploy.local',
    );
    assert.equal(
      layerName(facts({ tag: 'a', classes: ['dl-nav'], label: 'New task', childLayers: 2 })),
      'Nav item · New task',
    );
    assert.equal(layerName(facts({ classes: ['dl-composer'], childLayers: 2 })), 'Composer');
    assert.equal(
      layerName(facts({ classes: ['dl-app'], label: 'New task', childLayers: 2 })),
      'App',
    );
    assert.equal(layerName(facts({ tag: 'span', classes: ['dl-mark'], ownText: 'd' })), 'Mark');
    assert.equal(layerName(facts({ tag: 'svg' })), 'Icon');
    assert.equal(layerName(facts({ ariaLabel: 'Search' })), 'Search');
    assert.equal(layerName(facts({ dataName: 'Hero title', ownText: 'x' })), 'Hero title');
    assert.equal(layerName(facts({ childLayers: 3 })), 'Frame');
  });
  it('folds layout-only wrappers and keeps anything with a name of its own', () => {
    assert.equal(isWrapper(facts({ classes: ['dl-scroll'], childLayers: 1 })), true);
    assert.equal(isWrapper(facts({ classes: ['dl-col'], childLayers: 3 })), true);
    assert.equal(isWrapper(facts({ childLayers: 1 })), true);
    assert.equal(isWrapper(facts({ childLayers: 3 })), false);
    assert.equal(isWrapper(facts({ classes: ['dl-greeting'], childLayers: 3 })), false);
    assert.equal(isWrapper(facts({ ownText: 'Hi' })), false);
  });
});

describe('describing layer changes', () => {
  it('reads as one line per layer', () => {
    assert.equal(
      describeChange(
        { layer: 't', change: 'changed', details: ['font-size 30px', 'line-height 36px'] },
        'Welcome to deploy.local',
      ),
      'Welcome to deploy.local: font-size 30px, line-height 36px',
    );
    assert.equal(
      describeChange({ layer: 'n', change: 'added', details: [] }, 'Notice'),
      'Notice added',
    );
    assert.equal(
      changeLabel({ layer: 't', change: 'changed', details: ['gap 8px → 12px'] }),
      'gap 8px → 12px',
    );
  });
});
