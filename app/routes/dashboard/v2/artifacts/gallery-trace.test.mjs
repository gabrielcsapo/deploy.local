import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentHarness,
  elements,
  settle,
  uiStubs,
} from '../../../../../scripts/component-harness.mjs';
import { interactionTracer } from '../../../../../packages/trace/interaction.js';

async function fixture(cached) {
  const events = [];
  const tracer = interactionTracer({
    scope: 'gallery-test',
    origin: 'https://deploy.test',
    send: async (event) => (events.push(event), true),
  });
  const open = tracer.start('screen.artifacts.open');
  const requests = [];
  const frames = new Set();
  const window = new EventTarget();
  const h = await componentHarness(
    'app/routes/dashboard/v2/artifacts/Gallery.tsx',
    {
      'react-flight-router/client': { useSearchParams: () => [new URLSearchParams(), () => {}] },
      '@/components/ui': { ...uiStubs, ListTemplate: 'ListTemplate', Tabs: 'Tabs' },
      './NewArtifact': { NewArtifact: 'NewArtifact' },
      '../projects/interaction': { startScreenOpen: () => ({ open, pageLeft() {} }) },
      '../data/seeds': {
        useDataSeed: () => undefined,
        freshSeed: () => false,
        resourceKey: (path) => path,
      },
      '../data/hooks': {
        authenticatedFetch: (path, init) =>
          new Promise((respond) => requests.push({ path, init, respond })),
        remembered: () => cached,
        remember() {},
        onAuthReset: () => () => {},
        eventFeed: { subscribe: () => () => {} },
      },
    },
    {
      window,
      AbortController,
      requestAnimationFrame: (callback) => (frames.add(callback), callback),
      cancelAnimationFrame: (callback) => frames.delete(callback),
    },
  );
  return {
    events,
    open,
    requests,
    paint() {
      for (const callback of frames) callback();
      frames.clear();
    },
    render() {
      const tree = h.render(h.exports.Gallery);
      h.effects();
      return tree;
    },
    dispose: h.dispose,
  };
}

const emptyGallery = { artifacts: [], projects: [] };

test('a cold gallery attaches its first fetch and body wait to the visible screen', async () => {
  const f = await fixture();
  try {
    assert.equal(elements(f.render(), 'Skeleton').length, 1);
    const [request] = f.requests;
    const traceparent = new Headers(request.init.headers).get('traceparent');
    assert.equal(request.path, '/api/artifacts');
    assert.equal(traceparent.split('-')[1], f.open.traceId);

    let finishBody;
    const response = new Response();
    response.json = () => new Promise((resolve) => (finishBody = resolve));
    request.respond(response);
    await settle();
    f.paint();
    assert.equal(f.events.length, 0);
    finishBody(emptyGallery);
    await settle();
    assert.equal(elements(f.render(), 'Skeleton').length, 0);
    assert.equal(f.events.length, 0);
    f.paint();
    await settle();
    const [event] = f.events;
    assert.equal(event.milestone, 'gallery.visible');
    assert.deepEqual(
      event.spans.map(({ name }) => name),
      ['http.fetch', 'http.body'],
    );
    assert.equal(event.spans[0].spanId, traceparent.split('-')[2]);
    assert.equal(event.spans[0].parentSpanId, event.spanId);
  } finally {
    f.dispose();
  }
});

test('cached content finishes the visible screen without waiting for its background refresh', async () => {
  const f = await fixture(emptyGallery);
  try {
    assert.equal(elements(f.render(), 'Skeleton').length, 0);
    const [request] = f.requests;
    assert.equal(new Headers(request.init.headers).get('traceparent'), null);
    f.paint();
    await settle();
    assert.equal(f.events[0].milestone, 'gallery.visible');
    assert.deepEqual(f.events[0].spans, []);
    request.respond(Response.json({ error: 'Unavailable' }, { status: 503 }));
    await settle();
    assert.equal(elements(f.render(), 'Banner').length, 0);
    assert.equal(f.events.length, 1);
  } finally {
    f.dispose();
  }
});

test('the cold gallery records a visible failure or cancellation when left while loading', async () => {
  const failing = await fixture();
  failing.render();
  failing.requests[0].respond(Response.json({ error: 'Unavailable' }, { status: 503 }));
  await settle();
  assert.equal(elements(failing.render(), 'Banner').length, 1);
  failing.paint();
  await settle();
  assert.equal(failing.events[0].milestone, 'gallery.failed');
  assert.equal(failing.events[0].outcome, 'error');
  failing.dispose();

  const cancelled = await fixture();
  cancelled.render();
  cancelled.dispose();
  await settle();
  assert.equal(cancelled.requests[0].init.signal.aborted, true);
  assert.equal(cancelled.events[0].milestone, 'navigation.left');
  assert.equal(cancelled.events[0].outcome, 'cancelled');
  assert.equal(cancelled.events.length, 1);
});
