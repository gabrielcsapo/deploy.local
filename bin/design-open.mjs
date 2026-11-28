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
    ) => `<!-- The phone draws its status bar and home indicator over the game: restyle them to fit,
         keep play and text out of the top 54 px and bottom 34 px, or delete both and put
         immersive=true in the head for a full-bleed screen. -->
    <main data-layer="screen" style="position: relative; box-sizing: border-box; min-height: 844px; padding: 64px 24px 44px">
      <div data-statusbar data-layer="status-bar" style="position: absolute; inset: 0 0 auto; height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 0 30px 0 36px; font-weight: 600">
        <span>9:41</span>
        <svg viewBox="0 0 68 14" width="68" height="14" fill="currentColor" aria-label="Signal, Wi-Fi, battery">
          <rect x="0" y="9" width="3" height="5" rx="1" /><rect x="5" y="6" width="3" height="8" rx="1" /><rect x="10" y="3" width="3" height="11" rx="1" /><rect x="15" y="0" width="3" height="14" rx="1" />
          <path d="M31 13.5 27 9.3a6 6 0 0 1 8 0Zm-6.6-6.9-2-2a12.3 12.3 0 0 1 17.2 0l-2 2a9.4 9.4 0 0 0-13.2 0Z" />
          <rect x="44" y="1" width="21" height="12" rx="3.5" fill="none" stroke="currentColor" stroke-opacity=".4" /><rect x="46" y="3" width="17" height="8" rx="2" /><rect x="66" y="5" width="2" height="4" rx="1" fill-opacity=".4" />
        </svg>
      </div>
      <h1 data-layer="title">${name}</h1>
      <div data-layer="home-indicator" aria-hidden="true" style="position: absolute; left: 50%; bottom: 8px; width: 134px; height: 5px; margin-left: -67px; border-radius: 3px; background: currentColor"></div>
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
    meta: 'platform=art,width=1280,height=960,tile=16',
    body: () => `<!-- Each sprite is an svg.art-sprite whose viewBox is its size in pixels, drawn however the
         art wants; a thing's frames sit together in a .art-set with an h2. Colours named
         --pal-* and grounds --stage-* on :root in look.css are its palette; what the sprites
         are played on is an element with class art-ground. A pixel sprite can
         be written as a grid in design/pixels/<Name>.txt instead (see design/README.md). -->
    <section class="art-set" data-layer="first-set">
      <h2>First sprite</h2>
      <svg class="art-sprite" viewBox="0 0 16 16" width="128" height="128" data-layer="first">
        <rect x="4" y="4" width="8" height="8" fill="currentColor" />
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
    ? `  /* The palette, from the brief: --pal-<name> for each colour, --stage-<name> for each
     ground the sprites are played on. */`
    : kind === 'model'
      ? `  /* The palette: every colour a part may use, as pal('name') in the model script. */
  --pal-base: #888;`
      : `  /* The project's colours and type, as custom properties. */`
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
  art: `Set \`tile=\` from the brief (pixels a tile) and \`play=\` (the px it is drawn at in play) when the brief gives one; when it doesn't, choose and put \`data-question="What size is a tile drawn at in play?"\` on the board. A sprite that repeats gets class \`tile\` (or "tile" in its name), and the check looks at its seams. Put class \`art-ground\` on each ground the brief plays the sprites on (its colour, grid lines and all), so the check and \`look\` show them there. \`deploy design look <Sprite>\` draws one sprite as it is judged: close up, at play size on each ground, and a tile 3×3; look at it there rather than writing a preview of your own. \`export\` writes each sprite once, as an SVG named for its data-layer.

Pixel sprites can be written as text: design/pixels/<Name>.txt is a legend (\`K = ink\` for --pal-ink, \`. \` is see-through), then rows of equal width, a character a pixel, and \`tile\` on a line of its own for a tile. \`look\` and \`check --fix\` (or \`deploy design pixels\`) draw each grid into the art board as its svg.art-sprite, so the grid is what you edit:

    # design/pixels/Slime.txt
    K = ink
    G = moss
    ..KKKK..
    .KGGGGK.
    KGGGGGGK

\`<svg data-pixels="Slime" width="96" height="72"></svg>\` anywhere on the board shows that sprite again, at that size (in a scene, say).`,
  model:
    'The model is design/models/<Name>.py; its front faces -Y (the front view looks at it), z is up, metres. `look Model --angle 30,20` turns it.',
  logo: 'The mark is the svg with data-layer="mark"; the check draws it alone down to 16 px. Set fill-rule on the path itself.',
  game: 'Keep play and text out of the top 54 px and bottom 34 px, or put immersive=true in the head. `tap=44` in the head makes a control smaller than 44 px stop the check, and `reach=third` (or half) one outside the bottom third, where a thumb holding the phone reaches.',
};

/** design/README.md: the canvas in a page, for an agent who has never seen it. */
export const openReadme = (kind) => `# Design

An open canvas: boards are HTML pages, drawn and checked here before anything is built. The look
is yours to make from the brief. Several agents may work on this canvas, so write the project's
shared look into \`look.css\` and reuse it, and keep the brief in \`design/brief.md\` so the next
agent has it too (the figures it gives are never asked about).

## The loop
1. Draw \`design/boards/<Board>.html\`. Start from the board init placed (rename it with plain
   \`mv\` and its key in \`canvas.json\`). Link \`../look.css\` and put the shared look there.
2. \`deploy design look <Board>\` (or \`look <Sprite>\`) to see it (\`--zoom 3\` closer, \`--zoom 0.25\` from afar, \`--scheme dark\`, \`--angle 30\` for a model).
   Use it instead of starting a browser yourself.
3. \`deploy design check --fix\`: draws what changed beside main into \`output/design/pairs\`,
   places new boards, and lists problems (fix them) and advice (weigh it).
4. Before you call it done, look at it as it will be met: the mark at 16 px, a sprite at play size,
   a model from far off, a slide as from the back of the room (\`look --zoom 0.25\`).
5. \`deploy design export\` for the finished files (PDF, SVG marks and sprites, .glb models).

## A board
A standalone page with no scripts and no remote images, sized in its head:

    <meta name="design-board" content="${kinds[kind]?.meta ?? kinds.app.meta}">

Keys: width, height, platform, schemes (light, dark, or light dark), title, source, replaces, and
the brief's limits: \`size=\` and \`tris=\` for a model, \`tile=\` and \`play=\` for sprites,
\`tap=44\` and \`reach=third\` for the smallest control and how far up a thumb reaches,
\`palette=14\` (the most colours the brief allows; each must be one of look.css's --pal-*, and
nothing see-through) and \`pixels=hard\` (whole pixels only) when the brief asks for them, \`pages=\` for a document, \`min-text=28\` (or \`11pt\`) for the smallest type the brief allows, \`contrast=aa\`
to make low contrast stop the check. Name the parts others will
point at with \`data-layer\` IDs and keep them when you rework a board. A fact you made up that
the brief doesn't give (a price, an opening time) gets \`data-question="…"\` on its layer.
${kindTips[kind] ? `\n${kindTips[kind]}\n` : ''}
## canvas.json
Where boards sit: { "boards": { "<Board>.html": { "x", "y", "w", "h", "title" } }, "order": [],
"notes": {}, "schemes": ["light"] }. "schemes" is what every board draws in; \`check --fix\`
places new boards.

## What stops the check
A board that will not draw or build, text cut off or overflowing, text over text or past the
edge of its button, the starting board left untouched beside your own, a broken link or missing
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
