import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesignReview, DesignReviewScreen } from '../../../../../shared/v2/contracts';
import { InboxProvider } from '../data/hooks';
import { DesignCanvas } from './Canvas';
import { CanvasReviewBar, type CanvasReview } from './CanvasReview';
import type { Canvas } from './model';
import { RightPanel } from './Panels';

const screen = (file: string, fields: Partial<DesignReviewScreen> = {}) =>
  ({
    file,
    title: file.replace('.html', ''),
    w: 1440,
    h: 900,
    widths: [1440, 700],
    before: 'base',
    after: 'proposed',
    seen: false,
    added: false,
    removed: false,
    changes: [],
    ...fields,
  }) as DesignReviewScreen;
const changed = screen('Changed.html');
const offscreen = screen('Offscreen.html', { seen: true });
const frames = new Map<string, HTMLIFrameElement>();
const canvas: Canvas = {
  boards: {
    'Changed.html': { x: 0, y: 0, w: 1440, h: 900 },
    'Unchanged.html': { x: 1500, y: 0, w: 1440, h: 900 },
    ...Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `Offscreen${i}.html`,
        { x: 10000 + i * 1600, y: 0, w: 1440, h: 900 },
      ]),
    ),
  },
  notes: { note: { x: 0, y: 1000, text: 'Keep the gutter' } },
};
const frameReview = {
  api: '/api/design',
  item: 'design:p:design~test:abc',
  boards: new Map([
    [changed.file, changed],
    [offscreen.file, offscreen],
  ]),
  side: 'after' as const,
  approve: () => {},
  busy: false,
  waiting: true,
};
const props = {
  canvas,
  section: null,
  base: '/files/proposed',
  view: { x: 0, y: 0, z: 0.5 },
  setView: () => {},
  tool: 'move' as const,
  selection: null,
  select: () => {},
  frames: { current: frames },
  revision: 0,
  onFrameLoad: () => {},
};

test('review preserves cheap off-screen placeholders, dims unchanged frames, and adds a checkbox beside the name', () => {
  const html = renderToStaticMarkup(<DesignCanvas {...props} review={frameReview} />);
  assert.equal((html.match(/<iframe/g) ?? []).length, 2);
  assert.ok((html.match(/dz-board-placeholder/g) ?? []).length >= 300);
  assert.match(html, /dz-board dz-review-dim/);
  assert.match(html, /type="checkbox"[^>]*aria-label="Approve Changed"/);
  assert.match(html, />Changed<\/span>/);
  assert.match(html, /dz-review-world/);
  assert.doesNotMatch(html, /dl-rv-dock|dl-rv-rail|dl-rv-live-surface/);
});

test('Before switches only changed frames; new and removed sides never request missing files', () => {
  const before = renderToStaticMarkup(
    <DesignCanvas {...props} review={{ ...frameReview, side: 'before' }} />,
  );
  assert.match(before, /src="\/api\/design\/files\/base\/boards\/Changed.html"/);
  assert.match(before, /src="\/files\/proposed\/boards\/Unchanged.html"/);
  const newFrame = renderToStaticMarkup(
    <DesignCanvas
      {...props}
      review={{
        ...frameReview,
        side: 'before',
        boards: new Map([[changed.file, { ...changed, added: true }]]),
      }}
    />,
  );
  assert.match(newFrame, /New frame · no Before/);
  assert.doesNotMatch(newFrame, /src="[^"]*Changed.html"/);
  const removed = renderToStaticMarkup(
    <DesignCanvas
      {...props}
      review={{ ...frameReview, boards: new Map([[changed.file, { ...changed, removed: true }]]) }}
    />,
  );
  assert.match(removed, /Removed frame · no After/);
  assert.doesNotMatch(removed, /src="[^"]*Changed.html"/);
});

const data = {
  id: frameReview.item,
  title: 'Keep the gutter at every width',
  proposer: { name: 'Designer', id: 'designer', avatar: null },
  item: { state: 'waiting' },
  boards: [changed, offscreen],
  pins: [],
  notes: [],
  groups: [],
  resolutions: [],
} as unknown as DesignReview;
const controller = (value?: DesignReview) =>
  ({
    data: value,
    item: frameReview.item,
    api: '/api/design',
    side: 'after',
    setSide: () => {},
    error: '',
    busy: false,
    setBusy: () => {},
    setError: () => {},
    load: async () => {},
    approveFrame: async () => {},
  }) as CanvasReview;
const bar = (value?: DesignReview) =>
  renderToStaticMarkup(
    <InboxProvider>
      <CanvasReviewBar review={controller(value)} suggestions="" beforeDecision={async () => ''} />
    </InboxProvider>,
  );

test('bar uses board copy and saved seen count without gating approval or replacing tools', () => {
  const html = bar(data);
  assert.match(html, /Keep the gutter at every width/);
  assert.match(html, /from Designer · 1 of 2 approved/);
  assert.match(html, /Before/);
  assert.match(html, /After/);
  assert.match(html, />Ask for changes<\/button>/);
  assert.match(html, />Approve design<\/button>/);
  assert.doesNotMatch(html, /disabled|Propose|looked at/);
});

test('loading and notes-only reviews keep the canvas bar and decisions reachable', () => {
  assert.match(bar(), /Loading the review/);
  const html = bar({
    ...data,
    boards: [],
    notes: [{ id: 'gutter', title: 'Gutter' }] as DesignReview['notes'],
  });
  assert.match(html, /0 of 0 approved/);
  assert.match(html, />Approve design<\/button>/);
});

test('sent and approved confirmations remain reachable after another client answers', () => {
  assert.match(
    bar({
      ...data,
      item: {
        ...data.item,
        state: 'answered',
        answer: { actionId: 'changes', at: '2026-11-12T12:00:00Z', by: 'owner', on: 'web' },
      },
    }),
    /Sent to Designer/,
  );
  const approved = bar({
    ...data,
    item: {
      ...data.item,
      state: 'answered',
      answer: { actionId: 'approve', at: '2026-11-12T12:00:00Z', by: 'owner', on: 'web' },
    },
    landing: { at: '2026-11-12T12:00:30Z', state: 'pending' },
  });
  assert.match(approved, /Approved · on main in/);
  assert.match(approved, />Undo<\/button>/);
  assert.match(approved, /You approved this/);
});

test('the existing right panel owns the layer change list and hides Propose throughout review', () => {
  const html = renderToStaticMarkup(
    <RightPanel
      onHide={() => {}}
      project={undefined}
      design={undefined}
      canvas={canvas}
      section={null}
      selection={null}
      frames={{ current: frames }}
      tokens={{ colors: [], textStyles: [] }}
      revision={0}
      view={props.view}
      onZoom={() => {}}
      changes={[]}
      select={() => {}}
      owner="owner"
      tab="edit"
      setTab={() => {}}
      commentCount={0}
      comments={null}
      agent={null}
      onAsk={() => {}}
      propose={null}
      agents={[]}
      onComment={() => {}}
      htmlHref={null}
      connections={false}
      onConnections={() => {}}
      onConnection={() => {}}
      reviewing
      review={{
        ...data,
        boards: [
          {
            ...changed,
            changes: [
              { layer: 'title', words: 'Align' },
              { layer: 'greeting', words: 'Gap 8 → 12' },
            ],
          },
        ],
      }}
      reviewSide="after"
    />,
  );
  assert.equal((html.match(/>Changes on this branch</g) ?? []).length, 1);
  assert.ok(html.indexOf('>Page<') < html.indexOf('Changes on this branch'));
  assert.match(html, /Changed › Title/);
  assert.match(html, /Changed › Greeting/);
  assert.match(html, /Gap 8 → 12/);
  assert.doesNotMatch(html, />Propose<|dl-rv-rail|dl-rv-dock/);
  assert.match(html, /aria-label="Hide right panel"/);
});

test('landed approval offers the board’s split Build action until a build is recorded', () => {
  const approved: DesignReview = {
    ...data,
    proposerTaskId: 'proposer-task',
    item: {
      ...data.item,
      state: 'answered',
      answer: { actionId: 'approve', at: '2026-11-12T12:00:00Z', by: 'owner', on: 'web' },
    },
    landing: { at: '2026-11-12T12:00:30Z', state: 'landed', commit: '4f05991abcdef' },
  };
  const html = bar(approved);
  assert.match(html, /Approved · on main as 4f05991 · not built yet/);
  assert.match(html, />Build<\/button>/);
  assert.match(html, /aria-label="Where to build"/);
  assert.match(html, /role="menuitemradio" aria-checked="true"/);
  assert.match(html, /In Designer’s task/);
  assert.match(html, /Carries on the conversation that proposed it/);
  assert.match(html, /In a new task/);
  assert.match(html, /Starts a task that builds this design/);
  assert.doesNotMatch(html, /Ask for changes|Approve design<\/button>|>Done<|>Undo</);
  assert.doesNotMatch(bar({ ...approved, proposerTaskId: null }), /Where to build/);
  assert.doesNotMatch(
    bar({ ...approved, landing: { ...approved.landing!, state: 'pending' } }),
    />Build</,
  );
  const building = bar({
    ...approved,
    landing: { ...approved.landing!, build: { at: '', taskId: 'build-task', name: 'Builder' } },
  });
  assert.match(building, /href="\/dashboard\/tasks\/build-task">Builder is building it<\/a>/);
  assert.doesNotMatch(building, />Build<|Where to build|not built yet/);
});

test('a document’s review is approved as a document, counts blocks and builds nothing', () => {
  const document: DesignReview = { ...data, boards: [], item: { ...data.item, document: 'plan' } };
  const waiting = renderToStaticMarkup(
    <InboxProvider>
      <CanvasReviewBar
        review={controller(document)}
        suggestions=""
        beforeDecision={async () => ''}
        progress="new document"
        noBefore
      />
    </InboxProvider>,
  );
  assert.match(waiting, /from Designer · new document/);
  assert.match(waiting, />Approve document<\/button>/);
  assert.doesNotMatch(waiting, /Approve design|of 0 approved/);
  assert.match(waiting, /disabled="" class=""[^>]*>Before/);
  const landed = bar({
    ...document,
    item: {
      ...document.item,
      state: 'answered',
      answer: { actionId: 'approve', at: '2026-11-12T12:00:00Z', by: 'owner', on: 'web' },
    },
    landing: { at: '2026-11-12T12:00:30Z', state: 'landed', commit: '4f05991abcdef' },
  });
  assert.match(landed, /Approved · on main as 4f05991/);
  assert.doesNotMatch(landed, /not built yet|>Build</);
});
