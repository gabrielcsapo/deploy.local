// The open canvas deploy design init starts: a short README, the project's own look.css, and one
// blank board for the kind with only the hooks the check reads. No colours, type or parts of
// anyone else's: the first agent writes the project's look from its brief, later agents reuse it.

/** A board's head for each kind, and what its blank board holds. */
const kinds = {
  app: {
    file: 'Home',
    label: 'home screen',
    meta: 'platform=phone,width=390,height=844',
    body: (name) => `<main data-layer="screen">
      <h1 data-layer="title">${name}</h1>
    </main>`,
  },
  doc: {
    file: 'Document',
    label: 'document',
    meta: 'platform=doc,page=a4',
    body: (name) => `<article data-layer="page">
      <h1 data-layer="title">${name}</h1>
    </article>`,
  },
  slides: {
    file: 'SlideTitle',
    label: 'title slide',
    meta: 'platform=slide,width=1920,height=1080',
    body: (name) => `<section data-layer="slide">
      <h1 data-layer="title">${name}</h1>
    </section>`,
  },
  print: {
    file: 'CardFront',
    label: 'card front',
    meta: 'platform=print,size=85x55mm,bleed=3mm,safe=4mm',
    body: (
      name,
    ) => `<!-- The face is trim plus bleed (85 + 2 × 3 mm). Keep text inside the safe margin. -->
    <div data-layer="face" style="width: 91mm; height: 61mm; position: relative; overflow: hidden">
      <p data-layer="name" style="position: absolute; left: 9mm; top: 9mm; margin: 0">${name}</p>
    </div>`,
  },
  mac: {
    file: 'MainWindow',
    label: 'main window',
    meta: 'platform=mac,width=1280,height=800',
    body: (name) => `<main data-layer="window">
      <h1 data-layer="title">${name}</h1>
    </main>`,
  },
  game: {
    file: 'TitleScreen',
    label: 'title screen',
    meta: 'platform=game,device=phone,width=390,height=844',
    body: (
      name,
    ) => `<!-- Keep play and text out of the top 54 px and bottom 34 px (status bar, home indicator),
         or put immersive=true in the head for a full-bleed screen. -->
    <main data-layer="screen" style="padding: 64px 24px 44px">
      <h1 data-layer="title">${name}</h1>
    </main>`,
  },
  logo: {
    file: 'Mark',
    label: 'mark',
    meta: 'platform=logo,width=1024,height=1024',
    body: (
      name,
    ) => `<!-- The mark is the svg with data-layer="mark"; the check draws it alone at 16 to 512 px. -->
    <svg data-layer="mark" viewBox="0 0 64 64" width="512" height="512" role="img" aria-label="${name}">
      <circle cx="32" cy="32" r="24" fill="currentColor" />
    </svg>`,
  },
  art: {
    file: 'Sprites',
    label: 'sprite sheet',
    meta: 'platform=art,width=1280,height=960,tile=16,play=48',
    body: () => `<!-- Palette and grounds are --pal-* and --stage-* on :root in look.css. Each sprite is an
         svg.art-sprite whose viewBox is its pixels, painted only with rects in var(--pal-*);
         a thing's frames sit together in a .art-set with an h2. -->
    <section class="art-set" data-layer="first-set">
      <h2>First sprite</h2>
      <svg class="art-sprite" viewBox="0 0 16 16" width="128" height="128" data-layer="first">
        <rect x="4" y="4" width="8" height="8" fill="var(--pal-ink)" />
      </svg>
    </section>`,
  },
  model: {
    file: 'Model',
    label: 'model',
    meta: 'platform=model,width=1280,height=720,model=Prop,size=1x1x1,tris=500',
    body: (
      name,
    ) => `<!-- model= names design/models/<Name>.py; size= is its box in metres (w x d x h) and
         tris= its triangle budget, both from the brief. Colours are --pal-* on :root in look.css.
         Each img[data-model-view] gets that view: front, side, three-quarter, top, bottom. -->
    <h1 data-layer="title">${name}</h1>
    <div data-layer="views" style="display: flex; gap: 16px">
      <img data-model-view="front" alt="Front" width="240" height="240" />
      <img data-model-view="side" alt="Side" width="240" height="240" />
      <img data-model-view="three-quarter" alt="Three-quarter" width="240" height="240" />
      <img data-model-view="top" alt="Top" width="240" height="240" />
      <img data-model-view="bottom" alt="Underneath" width="240" height="240" />
    </div>
    <p data-layer="stats"><span data-model-stat="tris">0</span> triangles, <span data-model-stat="size">0</span></p>`,
  },
};

/** The look every kind starts with: nothing of anyone else's, only where things go. */
const lookCss = (kind) => `/* This project's look: its colours, type and the parts its boards share.
   The first board writes it from the brief; every later board links it and adds what it needs,
   so boards by different agents read as one project. A board's own <style> holds only its layout.
   Dark, when the brief wants it: :root[data-theme='dark'] { ... }, and schemes=light dark in the
   board's head (or "schemes" in canvas.json for every board). */
:root {
${
  kind === 'art'
    ? `  /* The palette: every colour a sprite may use, and the grounds it is played on. */
  --pal-ink: #222;
  --stage-ground: #ddd;`
    : kind === 'model'
      ? `  /* The palette: every colour a part may use, as pal('name') in the model script. */
  --pal-base: #888;`
      : `  /* --ink, --ground, --accent, the type sizes ... */`
}
}
html,
body {
  margin: 0;
}
`;

const modelScript = `# Prop: what it is, in one line. Built with bpy; the check hands this script these helpers
# (metres, degrees, z-up, standing on the ground at the origin):
#   part(kind, name, size, at, colour, rotate=(0, 0, 0), bevel=0, sides=12)   box|cylinder|cone|sphere
#   lathe(name, profile, at=(0, 0, 0), colour=None, sides=16)   turned round z from [(radius, z), ...]
#   beam(name, start, end, width, colour=None, depth=None, sides=0)   from one point to another
#   pal(name)   the material for --pal-<name> in look.css
part('box', 'block', (0.6, 0.6, 0.6), at=(0, 0, 0.3), colour='base')
`;

/** One line for a kind whose boards have a rule the rest do not. */
const kindTips = {
  doc: 'A document prints on its @page (size and margins in look.css). Start each page with `break-before: page`; `check` draws the printed sheets, and `pages=4` in the head stops it when the text runs onto a fifth.',
  slides:
    'One board per slide, all linking look.css; `export` puts them in canvas order as one PDF.',
  print:
    'A face is trim plus bleed; text and marks stay inside the safe margin. `export --marks` adds crop marks.',
  art: 'Set `tile=` and `play=` from the brief (pixels a tile, size shown in play). `export` writes each sprite as an SVG named for its data-layer.',
  model:
    'The model is design/models/<Name>.py; its front faces -Y (the front view looks at it), z is up, metres. `look Model --angle 30,20` turns it.',
  logo: 'The mark is the svg with data-layer="mark"; the check draws it alone down to 16 px. Set fill-rule on the path itself.',
  game: 'Keep play and text out of the top 54 px and bottom 34 px, or put immersive=true in the head.',
};

/** design/README.md: the canvas in a page, for an agent who has never seen it. */
export const openReadme = (kind) => `# Design

An open canvas: boards are HTML pages, drawn and checked here before anything is built. The look
is yours to make from the brief. Several agents may work on this canvas, so write the project's
shared look into \`look.css\` and reuse it.

## The loop
1. Draw \`design/boards/<Board>.html\`. Start from the board init placed (rename it with plain
   \`mv\` and its key in \`canvas.json\`). Link \`../look.css\` and put the shared look there.
2. \`deploy design look <Board>\` to see it (\`--zoom 3\` closer, \`--zoom 0.25\` from afar, \`--scheme dark\`, \`--angle 30\` for a model).
   Use it instead of starting a browser yourself.
3. \`deploy design check --fix\`: draws what changed beside main into \`output/design/pairs\`,
   places new boards, and lists problems (fix them) and advice (weigh it).
4. Before you call it done, look at it as it will be met: the mark at 16 px, a sprite at play size,
   a model from far off, a slide as from the back of the room (\`look --zoom 0.25\`). If a
   stranger could not name each part at that size, simplify it until they could.
5. \`deploy design export\` for the finished files (PDF, SVG marks and sprites, .glb models).

## A board
A standalone page with no scripts and no remote images, sized in its head:

    <meta name="design-board" content="${kinds[kind]?.meta ?? kinds.app.meta}">

Keys: width, height, platform, schemes (light, dark, or light dark), title, source, replaces, and
the brief's limits: \`size=\` and \`tris=\` for a model, \`tile=\` and \`play=\` for sprites, \`pages=\`
for a document, \`min-text=28\` (or \`11pt\`) for the smallest type the brief allows, \`contrast=aa\`
to make low contrast stop the check. Name the parts others will
point at with \`data-layer\` IDs and keep them when you rework a board. A fact you made up that
the brief doesn't give (a price, an opening time) gets \`data-question="…"\` on its layer.
${kindTips[kind] ? `\n${kindTips[kind]}\n` : ''}
## canvas.json
Where boards sit: { "boards": { "<Board>.html": { "x", "y", "w", "h", "title" } }, "order": [],
"notes": {}, "schemes": ["light"] }. "schemes" is what every board draws in; \`check --fix\`
places new boards.

## What stops the check
A board that will not draw or build, text cut off or overflowing, a broken link or missing
picture, boards on top of each other, a layer ID that was renamed or lost, and limits the board's
head states. Everything else (contrast, alignment, framing, readability at play size) is advice.
`;

/** The files deploy design init writes for an open canvas, by path under the project. */
export function openCanvasFiles(name, kind = 'app', title = name) {
  const info = kinds[kind] ?? kinds.app;
  const file = `${info.file}.html`;
  const label = `${title} ${info.label}`;
  const escaped = label.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const board = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="design-board" content="${info.meta}" />
    <title>${escaped}</title>
    <link rel="stylesheet" href="../look.css" />
    <style>
      /* This board's own layout. */
    </style>
  </head>
  <body>
    ${info.body(title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`))}
  </body>
</html>
`;
  return {
    file,
    title: label,
    files: {
      'design/look.css': lookCss(kind),
      [`design/boards/${file}`]: board,
      ...(kind === 'model' ? { 'design/models/Prop.py': modelScript } : {}),
    },
  };
}

/** The kinds the open canvas knows. */
export const openKinds = Object.keys(kinds);
