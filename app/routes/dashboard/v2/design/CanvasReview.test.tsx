import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ComponentProps } from 'react';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesignReview, DesignReviewScreen } from '../../../../../shared/v2/contracts';
import { InboxProvider } from '../data/hooks';
import { DesignCanvas, ReviewLoadingCanvas } from './Canvas';
import {
  CanvasReviewBar,
  PinBox,
  ReviewStrip,
  ReviewViewItems,
  useReviewDecision,
  type CanvasReview,
} from './CanvasReview';
import type { Canvas } from './model';
import { LeftPanel, RightPanel, ReviewNotes, ReviewPanel } from './Panels';
import {
  openingTab,
  openingTool,
  stepFrame,
  tabAfterChoosing,
  type PanelTab,
} from './canvas-review-model';

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
    compare: { wipe: false, width: null, dark: false },
    setCompare: () => {},
    error: '',
    busy: false,
    setBusy: () => {},
    setError: () => {},
    load: async () => {},
    approveFrame: async () => {},
    setPins: () => {},
  }) as CanvasReview;
const bar = (value?: DesignReview) =>
  renderToStaticMarkup(
    <InboxProvider>
      <CanvasReviewBar review={controller(value)} suggestions="" beforeDecision={async () => ''} />
    </InboxProvider>,
  );
/** What the markup says, tags left out. */
const words = (html: string) => html.replace(/<[^>]+>/g, '');

test('bar uses board copy and saved seen count without gating approval or replacing tools', () => {
  const html = bar(data);
  assert.match(html, /Keep the gutter at every width/);
  assert.match(words(html), /from Designer · 1 of 2 seen/);
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
  assert.match(words(html), /0 of 0 seen/);
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
  assert.match(words(waiting), /from Designer · new document/);
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

test('an approval that did not reach main says so and offers the update or the choice, never on main', () => {
  const sameScreen = {
    file: 'Changed.html',
    kind: 'same-part',
    mainChanged: 'Title',
    proposalChanged: 'Title',
    detail: '',
    choice: null,
  } as NonNullable<DesignReview['resolutions']>[number];
  const notLanded: DesignReview = {
    ...data,
    resolutions: [sameScreen],
    landing: { at: '2026-11-12T12:00:30Z', state: 'conflict' },
  };
  const html = bar(notLanded);
  assert.match(
    html,
    /Keep the gutter at every width<\/strong><span> · <strong>Did not reach main<\/strong> · main changed first<\/span>/,
  );
  assert.match(html, />Before</);
  assert.match(html, /class="[^"]*secondary[^"]*"[^>]*>Ask Designer to update<\/button>/);
  assert.match(html, /class="[^"]*primary[^"]*"[^>]*>Choose what to keep<\/button>/);
  assert.doesNotMatch(html, /Approved|on main as|Approve design|Ask for changes|approved/);
  const yours = bar({ ...notLanded, proposer: { ...data.proposer, name: 'You' } });
  assert.match(yours, />Ask to update<\/button>/);
  // Even an answer that still says approve never reads as on main while the landing conflicts.
  assert.doesNotMatch(
    bar({
      ...notLanded,
      item: {
        ...data.item,
        state: 'answered',
        answer: { actionId: 'approve', at: '2026-11-12T12:00:00Z', by: 'owner', on: 'web' },
      },
    }),
    /on main/,
  );
  // Once every screen has a choice, the review is decided again as usual.
  const chosen = bar({ ...notLanded, resolutions: [{ ...sameScreen, choice: 'proposal' }] });
  assert.match(chosen, />Approve design<\/button>/);
});

test('notes say who has them: a terminal, or nobody with Start a task', () => {
  const asked = {
    ...data,
    proposer: { ...data.proposer, name: 'Gabriel' },
    item: {
      ...data.item,
      state: 'answered',
      answer: { actionId: 'changes', at: '2026-11-12T12:00:00Z', by: 'owner', on: 'web' },
    },
  } as DesignReview;
  const nobody = bar({
    ...asked,
    feedback: { actionId: 'changes', notes: 1, delivery: 'nobody' },
  });
  assert.match(nobody, /· from Gabriel · 1 note kept · nobody is working on it/);
  assert.match(nobody, /class="[^"]*primary[^"]*"[^>]*>Start a task<\/button>/);
  assert.doesNotMatch(nobody, /Sent to|Open the task|approved|>Done<|Next review/);
  const terminal = bar({
    ...asked,
    feedback: { actionId: 'changes', notes: 2, delivery: 'terminal', computer: 'MacBook Pro' },
  });
  assert.match(terminal, /· from Gabriel · 2 notes sent to a terminal on MacBook Pro/);
  assert.doesNotMatch(terminal, /<button[^>]*>(?!Before|After)[^<]*<\/button>/);
  assert.doesNotMatch(terminal, /Start a task|Sent to|>Done<|Next review/);
  // A task's notes read as they always have.
  const task = bar({
    ...asked,
    feedback: { actionId: 'changes', notes: 1, delivery: 'task', taskId: 't' },
  });
  assert.match(task, /Sent to Gabriel/);
  assert.doesNotMatch(task, /Start a task|nobody/);
});

test('a shared part is the first row of the change list, one unit in the bar, and ticks with its screen', () => {
  const welcome = screen('Welcome.html', {
    title: 'Welcome',
    seen: true,
    changes: [{ layer: 'title', words: 'Align' }],
  });
  const grouped = {
    ...data,
    boards: [
      welcome,
      screen('Narrow.html', { title: 'Welcome, narrow' }),
      screen('Install.html', { title: 'Install an app' }),
    ],
    parts: [
      {
        component: 'sidebar',
        name: 'Sidebar',
        screens: 242,
        lookAt: { file: 'Welcome.html', title: 'Welcome' },
        seen: true,
      },
    ],
  } as DesignReview;
  assert.match(words(bar(grouped)), /from Designer · 2 of 4 seen/);
  assert.match(
    words(bar({ ...grouped, parts: [{ ...grouped.parts![0], seen: false }] })),
    /from Designer · 1 of 4 seen/,
  );
  const panel = renderToStaticMarkup(
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
        ...grouped,
        // A screen shown only for the part is not a row of its own.
        boards: [...grouped.boards, screen('Beta.html', { instanceOnly: true })],
      }}
      reviewSide="after"
    />,
  );
  const text = panel.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  assert.match(
    text,
    /\|Sidebar\|242 screens\|One change to a shared part\. Look at it on Welcome; ticking it there ticks it for all\.\|Welcome › [^|]*\|Align\|Welcome, narrow\|Changed\|Install an app\|Changed\|/,
  );
  assert.doesNotMatch(text, /Beta/);
  // The look-at screen's box shows the part: ticked only when the part is seen too.
  const box = (parts: DesignReview['parts']) =>
    renderToStaticMarkup(
      <DesignCanvas
        {...props}
        canvas={{ boards: { 'Welcome.html': { x: 0, y: 0, w: 1440, h: 900 } } }}
        review={{ ...frameReview, boards: new Map([[welcome.file, welcome]]), parts }}
      />,
    );
  assert.match(box(grouped.parts), /aria-label="Approve Welcome" disabled="" checked=""/);
  assert.match(box([{ ...grouped.parts![0], seen: false }]), /aria-label="Approve Welcome"\/>/);
});

const panel = (review: DesignReview) =>
  renderToStaticMarkup(
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
      review={review}
      reviewSide="after"
    />,
  );
// The Round2 board: Welcome seen in round 1 and unchanged; Welcome narrow and Install an app changed.
const welcome = screen('Welcome.html', {
  title: 'Welcome',
  seen: true,
  seenInRound: 1,
  changedSinceReview: false,
});
const narrow = screen('Narrow.html', {
  title: 'Welcome, narrow',
  seen: true,
  seenInRound: 2,
  changedSinceReview: true,
});
const install = screen('Install.html', { title: 'Install an app', changedSinceReview: true });
const note = {
  noteId: null,
  width: 1440,
  revision: 'r1',
  x: 0,
  y: 0,
  author: 'owner',
  createdAt: '2026-11-10T00:00:00.000Z',
  round: 1,
};
const roundTwo = {
  ...data,
  round: 2,
  createdAt: '2026-11-12T00:00:00.000Z',
  boards: [welcome, narrow, install],
  groups: [{ id: null, title: null, boards: [welcome.file, narrow.file, install.file] }],
  pins: [
    {
      ...note,
      id: 'a',
      number: 1,
      board: narrow.file,
      text: 'Keep the gutter at 16 here too.',
      resolved: true,
      reply: 'Gutter is 16 at every width now.',
    },
    {
      ...note,
      id: 'b',
      number: 2,
      board: install.file,
      text: 'The app card should say who made it.',
      resolved: false,
      reply: 'Kept the size; the maker does not fit at 700.',
    },
  ],
} as unknown as DesignReview;

test('a second round counts changed screens, tags what was seen, and lists last round’s notes', () => {
  assert.match(
    bar(roundTwo),
    /from Designer<span class="dz-review-progress"> · round 2 · <span class="dz-review-count">1 of 2 changed screens seen<\/span><\/span>/,
  );
  // Round one keeps its wording.
  assert.match(words(bar({ ...roundTwo, round: 1 })), /from Designer · 2 of 3 seen/);
  const html = renderToStaticMarkup(
    <DesignCanvas
      {...props}
      canvas={{
        boards: {
          [welcome.file]: { x: 0, y: 0, w: 1440, h: 900 },
          [install.file]: { x: 1500, y: 0, w: 1440, h: 900 },
        },
      }}
      review={{
        ...frameReview,
        round: 2,
        boards: new Map([
          [welcome.file, welcome],
          [install.file, install],
        ]),
      }}
    />,
  );
  // A plain tag, not the accent Changed one, and a ticked box.
  assert.match(html, /<span class="dz-tag">Seen in round 1<\/span>/);
  assert.match(html, /aria-label="Approve Welcome" disabled="" checked=""/);
  assert.match(html, /<span class="dz-tag review">Changed<\/span>/);
  // Since your last review leads the Review tab, above What changed.
  const reviewTab = (value: DesignReview) =>
    renderToStaticMarkup(<ReviewPanel review={value} onScreen={() => {}} onNote={() => {}} />);
  const text = reviewTab(roundTwo)
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|');
  assert.match(
    text,
    /\|Since your last review\|2 screens changed\. 1 of your 2 notes addressed\.\|1\|Keep the gutter at 16 here too\.\|Welcome, narrow\|Addressed\|Gutter is 16 at every width now\.\|2\|The app card should say who made it\.\|Install an app\|Still open\|Kept the size; the maker does not fit at 700\.\|What changed\|1 of 2 changed screens seen\|/,
  );
  assert.match(reviewTab(roundTwo), /class="dz-since-addressed">Addressed/);
  // Edit keeps the branch's changes, without last round's notes again.
  const edit = panel(roundTwo)
    .replace(/<[^>]+>/g, '|')
    .replace(/\|+/g, '|');
  assert.match(edit, /\|Changes on this branch\|/);
  assert.doesNotMatch(edit, /Since your last review|Keep the gutter at 16 here too/);
  assert.doesNotMatch(reviewTab({ ...roundTwo, round: 1 }), /Since your last review/);
});

function Strip({
  value,
  compare,
  noBefore = false,
  loading = null,
}: {
  value?: DesignReview;
  compare: CanvasReview['compare'];
  noBefore?: boolean;
  loading?: { done: number; total: number } | null;
}) {
  const decision = useReviewDecision({ ...controller(value), compare }, '', async () => '');
  return <ReviewStrip decision={decision} noBefore={noBefore} loading={loading} />;
}
const strip = (
  value: DesignReview | undefined,
  compare: CanvasReview['compare'],
  options: { noBefore?: boolean; loading?: { done: number; total: number } } = {},
) =>
  renderToStaticMarkup(
    <InboxProvider>
      <Strip value={value} compare={compare} {...options} />
    </InboxProvider>,
  );

test('the review strip offers Before, After and Wipe; width and Dark are in the zoom menu', () => {
  const off = { wipe: false, width: null, dark: false };
  const html = strip(data, off);
  assert.match(
    html,
    /aria-pressed="false">Before<\/button><button[^>]*aria-pressed="true">After<\/button><button[^>]*aria-pressed="false">Wipe<\/button>/,
  );
  // One strip: title · from who · how far, and no width or Dark beside Before and After.
  assert.match(words(html), /Keep the gutter at every width · from Designer · 1 of 2 seen/);
  assert.doesNotMatch(html, /dz-review-cmp|>Dark</);
  // With nothing on main, Wipe is disabled like Before.
  assert.match(
    strip(data, off, { noBefore: true }),
    /disabled="" class="" aria-pressed="false">Wipe<\/button>/,
  );
  assert.match(
    strip(data, { ...off, wipe: true }),
    /class="on" aria-pressed="true">Wipe<\/button>/,
  );
  // A document's bar has Before and After only.
  assert.doesNotMatch(bar(data), /Wipe|dz-review-cmp/);
  const menu = (compare: CanvasReview['compare']) =>
    renderToStaticMarkup(<ReviewViewItems review={{ ...controller(data), compare }} />);
  assert.match(menu(off), /aria-checked="true">Each board’s own/);
  assert.match(menu(off), /role="menuitemcheckbox" aria-checked="false">Dark<\/button>/);
  const on = menu({ wipe: true, width: 700, dark: true });
  assert.match(on, /aria-checked="true">700/);
  assert.match(on, /role="menuitemcheckbox" aria-checked="true">Dark/);
});

test('while screens load the strip says how many of them, in place of how many are seen', () => {
  const off = { wipe: false, width: null, dark: false };
  const loading = strip(data, off, { loading: { done: 3, total: 13 } });
  assert.match(loading, /class="dl-design-waiting-banner dz-review-strip loading"/);
  assert.match(loading, /role="status">Loading 3 of 13 screens<span class="dl-bar"/);
  assert.match(loading, /style="width:23%"/);
  const done = strip(data, off, { loading: { done: 13, total: 13 } });
  assert.doesNotMatch(done, /Loading|dz-review-strip loading/);
  // Before the review itself arrives: the frame, its decisions in place, no block skeleton.
  const first = strip(undefined, off);
  assert.match(first, /Loading the review/);
  assert.doesNotMatch(first, /dl-skeleton/);
  // Changed screens show at their own size, blurred, until the canvas puts them in place.
  const stills = renderToStaticMarkup(<ReviewLoadingCanvas boards={[changed, offscreen]} />);
  assert.match(stills, /aria-busy="true"/);
  assert.doesNotMatch(stills, /dl-skeleton|<iframe/);
});

test('changed screens are blurred stills in place until their renders arrive', () => {
  const html = renderToStaticMarkup(<DesignCanvas {...props} review={frameReview} />);
  // The changed board on screen loads with its still over it; unchanged boards have none.
  assert.match(html, /class="dz-board still"[^>]*><div class="dz-board-name"/);
  assert.equal((html.match(/class="dz-board-still"/g) ?? []).length, 1);
  assert.equal((html.match(/<iframe/g) ?? []).length, 2);
});

test('a chosen width draws changed web frames at it; wipe shows both sides with a slider', () => {
  const phone = screen('Phone.html', { w: 390, widths: [390] });
  const added = screen('Added.html', { added: true });
  const draw = (compare: CanvasReview['compare']) =>
    renderToStaticMarkup(
      <DesignCanvas
        {...props}
        canvas={{
          boards: {
            'Changed.html': { x: 0, y: 0, w: 1440, h: 900 },
            'Unchanged.html': { x: 1500, y: 0, w: 1440, h: 900 },
            'Phone.html': { x: 3000, y: 0, w: 390, h: 844 },
            'Added.html': { x: 0, y: 1000, w: 1440, h: 900 },
          },
        }}
        review={{
          ...frameReview,
          boards: new Map([
            [changed.file, changed],
            [phone.file, phone],
            [added.file, added],
          ]),
          compare,
        }}
      />,
    );
  const narrowHtml = draw({ wipe: false, width: 700, dark: false });
  assert.match(narrowHtml, /title="Changed"[^>]*width="700"/);
  assert.match(narrowHtml, /title="Unchanged"[^>]*width="1440"/);
  assert.match(narrowHtml, /width:390px;height:844px.*>Phone 390</);
  const wipe = draw({ wipe: true, width: null, dark: false });
  assert.match(
    wipe,
    /title="Changed · Before" [^>]*src="\/api\/design\/files\/base\/boards\/Changed.html"/,
  );
  assert.match(wipe, /title="Changed" [^>]*src="\/files\/proposed\/boards\/Changed.html"/);
  assert.match(
    wipe,
    /role="slider" tabindex="0" aria-label="Wipe between Before and After" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"/,
  );
  // A new frame has nothing to wipe: one slider, and its After alone.
  assert.equal(wipe.match(/role="slider"/g)?.length, 1);
  assert.match(wipe, /title="Added" [^>]*src="\/files\/proposed\/boards\/Added.html"/);
});

const reviewPin = (fields: Partial<DesignReview['pins'][number]> = {}) =>
  ({
    id: 'pin-1',
    number: 1,
    board: changed.file,
    noteId: null,
    width: 1440,
    revision: 'proposed',
    x: 300,
    y: 200,
    text: 'Keep the gutter at 16 here too.',
    author: 'Gabriel',
    resolved: false,
    reply: null,
    createdAt: '2026-11-12T15:00:00.000Z',
    round: 1,
    ...fields,
  }) as DesignReview['pins'][number];
const pinData = {
  ...data,
  round: 1,
  createdAt: '2026-11-12T14:00:00.000Z',
  boards: [{ ...changed, title: 'Welcome, narrow' }],
  pins: [
    reviewPin({ area: { x: 250, y: 150, w: 100, h: 100 } }),
    reviewPin({ id: 'pin-2', number: 2, resolved: true, text: 'Done already.' }),
  ],
} as unknown as DesignReview;
const pinsProp = (fields: object = {}) => ({
  review: pinData,
  making: true,
  waiting: true,
  open: null,
  onMake: () => {},
  onOpen: () => {},
  box: null,
  ...fields,
});

test('in a waiting review the Comment tool places pins on changed frames, numbered with their areas', () => {
  const html = renderToStaticMarkup(
    <DesignCanvas
      {...props}
      tool="comment"
      review={{ ...frameReview, boards: new Map([[changed.file, changed]]), pins: pinsProp() }}
    />,
  );
  // Only the changed frame takes a pin; the unchanged one is left as it was.
  assert.equal(html.match(/dz-board-hit dz-pin-hit/g)?.length, 1);
  // The open pin is a marker with its number; the resolved one is not shown.
  assert.match(html, /class="dz-pin" aria-label="Pin 1"[^>]*>1<\/button>/);
  assert.doesNotMatch(html, /Pin 2/);
  assert.match(html, /class="dz-pin-area" style="left:250px;top:150px;width:100px;height:100px/);
  // Before and Wipe show no After pins, and no frame takes one.
  for (const view of [
    { side: 'before' as const },
    { compare: { wipe: true, width: null, dark: false } },
  ]) {
    const other = renderToStaticMarkup(
      <DesignCanvas
        {...props}
        tool="comment"
        review={{
          ...frameReview,
          ...view,
          boards: new Map([[changed.file, changed]]),
          pins: pinsProp({ making: false }),
        }}
      />,
    );
    assert.doesNotMatch(other, /dz-pin/);
  }
});

test('placing a pin opens its box beside it, with the iPhone’s words', () => {
  const draft = { board: changed.file, width: 1440, revision: 'proposed', x: 450, y: 360 };
  const pins = {
    open: { draft, number: 3 },
    text: '',
    setText: () => {},
    busy: false,
    error: '',
    cancel: () => {},
    save: () => {},
    remove: () => {},
  };
  const box = <PinBox pins={pins} number={3} where="Install an app › App card" />;
  const html = renderToStaticMarkup(
    <DesignCanvas
      {...props}
      tool="comment"
      review={{
        ...frameReview,
        boards: new Map([[changed.file, changed]]),
        pins: pinsProp({ open: pins.open, box }),
      }}
    />,
  );
  // The new pin's number on the screen, and the box in the canvas beside it.
  assert.match(html, /aria-label="Pin 3" disabled=""[^>]*>3<\/button>/);
  assert.match(html, /class="dz-pin-box" style="--dz-pin-x:[\d.]+px;--dz-pin-y:[\d.]+px"/);
  const text = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  assert.match(text, /\|Pin 3\|Install an app › App card\|Cancel\|Add\|/);
  assert.match(html, /placeholder="What should change\?"/);
  // Add waits for words; Remove pin is only for a saved pin.
  assert.match(html, /disabled=""[^>]*>Add<\/button>/);
  assert.doesNotMatch(html, /Remove pin|Save/);
  const saved = renderToStaticMarkup(
    <PinBox
      pins={{ ...pins, open: { pin: pinData.pins[0] }, text: 'Keep the gutter at 16 here too.' }}
      number={1}
      where="Welcome, narrow"
    />,
  );
  assert.match(saved, />Remove pin<\/button>/);
  assert.match(saved, /<button[^>]*class="dl-btn primary ?"[^>]*>Save<\/button>/);
  assert.doesNotMatch(saved, /disabled=""[^>]*>Save/);
});

test('Comments in a review lists this round’s pins for the proposer, Not sent until Ask for changes', () => {
  const notes = (review: DesignReview) =>
    renderToStaticMarkup(<ReviewNotes review={review} onOpen={() => {}} />)
      .replace(/<[^>]+>/g, '|')
      .replace(/\|+/g, '|');
  assert.match(
    notes(pinData),
    /^\|Notes for Designer\|1\|Sent when you ask for changes\.\|1\|Keep the gutter at 16 here too\.\|Welcome, narrow\|Not sent\|Resolved · 1\|2\|Done already\.\|Welcome, narrow\|$/,
  );
  const sent = {
    ...pinData,
    item: { state: 'answered', answer: { actionId: 'changes' } },
  } as unknown as DesignReview;
  assert.match(notes(sent), /\|Welcome, narrow\|Sent\|/);
  assert.doesNotMatch(notes(sent), /Not sent/);
  // The proposer is you: Notes alone. An earlier round's pins are not repeated here.
  const yours = {
    ...pinData,
    round: 2,
    proposer: { name: 'You', id: null, avatar: null },
    pins: [reviewPin({ round: 1 })],
  } as unknown as DesignReview;
  assert.match(notes(yours), /^\|Notes\|0\|Sent when you ask for changes\.\|Resolved · 0\|$/);
});

// Review is a mode of the editor: the same right panel, on its Review tab.
const reviewPanelProps = (tab: PanelTab, selection: { board: string; layer: null } | null) =>
  ({
    onHide: () => {},
    project: undefined,
    design: undefined,
    canvas,
    section: null,
    selection,
    frames: { current: frames },
    tokens: { colors: [], textStyles: [] },
    revision: 0,
    view: props.view,
    onZoom: () => {},
    changes: [],
    select: () => {},
    owner: 'owner',
    tab,
    setTab: () => {},
    commentCount: 0,
    comments: null,
    agent: null,
    onAsk: () => {},
    propose: null,
    agents: [],
    onComment: () => {},
    htmlHref: null,
    connections: false,
    onConnections: () => {},
    onConnection: () => {},
    prototype: { links: [], sidebar: false, setSidebar: () => {}, start: null },
    reviewing: true,
    review: data,
    reviewSide: 'after' as const,
    decisions: <button type="button">Approve design</button>,
    reviewPanel: (
      <ReviewPanel review={data} active={selection?.board} onScreen={() => {}} onNote={() => {}} />
    ),
  }) satisfies ComponentProps<typeof RightPanel>;

test('a review opens on its Review tab, before Edit and Comments, with Comment in hand', () => {
  assert.equal(openingTab(true), 'review');
  assert.equal(openingTab(false), 'edit');
  assert.equal(openingTool(true, false), 'comment');
  assert.equal(openingTool(true, true), 'move');
  assert.equal(openingTool(false, false), 'move');
  const html = renderToStaticMarkup(<RightPanel {...reviewPanelProps(openingTab(true), null)} />);
  assert.match(
    html,
    /role="tablist"><button type="button" role="tab" aria-selected="true" class="on">Review<\/button><button[^>]*aria-selected="false"[^>]*>Edit<\/button><button[^>]*aria-selected="false"[^>]*>Comments<\/button>/,
  );
  // Prototype is the editor's; the decisions take Propose's place.
  assert.doesNotMatch(html, />Prototype<|>Propose</);
  assert.match(html, /<span class="dz-decisions"><button type="button">Approve design<\/button>/);
  assert.match(html, /aria-label="Review"/);
  const text = words(html);
  assert.match(text, /What changed1 of 2 seen/);
  assert.match(text, /Edit and Comments are a click away/);
});

test('choosing or stepping to a screen keeps Review selected; Edit and Comments never open on their own', () => {
  const step = stepFrame([changed, offscreen], changed.file, 1)!;
  assert.equal(step, offscreen.file);
  // Stepping, a row and the canvas all choose a board the same way.
  for (const commenting of [false, true])
    for (const pinning of [false, true])
      assert.equal(tabAfterChoosing('review', { reviewing: true, commenting, pinning }), 'review');
  // The editor keeps its own way: the Comment tool opens Comments.
  assert.equal(
    tabAfterChoosing('edit', { reviewing: false, commenting: true, pinning: false }),
    'comments',
  );
  // With a board chosen, the panel still shows What changed, the board marked, not its layout.
  const html = renderToStaticMarkup(
    <RightPanel {...reviewPanelProps('review', { board: step, layer: null })} />,
  );
  assert.match(html, /role="tab" aria-selected="true" class="on">Review</);
  assert.match(html, /class="dz-review-row on" aria-current="true"><span class="dz-seen on"/);
  assert.doesNotMatch(html, />Layout<|>Widths<|>Changes on this branch</);
});

test('below 820 px a review keeps the right panel at the side, 280 px wide: no bottom sheet', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const below820 = css.slice(css.indexOf('@media (max-width: 820px) and (min-width: 501px)'));
  const block = below820.slice(0, below820.indexOf('\n}\n'));
  assert.match(block, /\.dz\.reviewing \{\s*--dz-right: 280px;/);
  assert.match(block, /\.dz\.reviewing \.dz-right \{\s*position: relative;[^}]*transform: none;/);
  assert.match(
    block,
    /\.dz\.reviewing \.dz-narrow-bar,\s*\.dz\.reviewing \.dz-sheet-scrim \{\s*display: none;/,
  );
  assert.match(block, /\.dz\.reviewing \.dz-right-top \{\s*display: flex;/);
  // The editor's sheet stays the editor's: it opens on a selection only outside a review.
  assert.match(css, /\.dz\.has-selection \.dz-right \{\s*transform: none;/);
  // Below 1180 px the left panel folds and comes back over the canvas from the strip.
  const fold = css.slice(css.indexOf('@media (max-width: 1179px)'));
  assert.match(fold, /\.dz\.reviewing \.dz-left \{\s*display: none;/);
  assert.match(
    fold,
    /\.dz\.reviewing:not\(\.left-open\) \.dz-strip-show-left \{\s*display: inline-flex;/,
  );
  assert.match(css, /\.dz\.reviewing \{\s*--dz-right: 320px;/);
});

test('the left panel names the way back and says the branch is in review', () => {
  const html = renderToStaticMarkup(
    <LeftPanel
      project={undefined}
      onDesign={() => {}}
      design={undefined}
      current="design/server-diagnostics"
      sections={[
        { id: 's', title: '4 · Computers', x: 0, y: 0, boards: [changed.file, 'New.html'] },
      ]}
      section={{ id: 's', title: '4 · Computers', x: 0, y: 0, boards: [changed.file, 'New.html'] }}
      onSection={() => {}}
      selection={null}
      select={() => {}}
      base="/files/proposed"
      changed={new Set([changed.file, 'New.html'])}
      added={new Set(['New.html'])}
      pageDots
      inReview={new Set()}
      agentAt={new Map()}
      owner="owner"
      reviewing={new Set()}
      onRef={() => {}}
      onNewBranch={() => {}}
      onHide={() => {}}
      assets={null}
      back={{ label: 'Waiting on you', href: '/dashboard/inbox?item=x' }}
      branchStatus="in review"
    />,
  );
  assert.match(
    html,
    /<a class="dz-left-back" href="\/dashboard\/inbox\?item=x">.*Waiting on you<\/a>/,
  );
  assert.match(words(html), /design\/server-diagnostics · in review/);
  assert.match(html, /class="dz-dot new" aria-label="New on this branch"/);
  assert.match(html, /class="dz-dot" aria-label="Changed on this branch"/);
  assert.match(html, /aria-label="Changes on this page"/);
});
