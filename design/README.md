# deploy.local design

This folder is the source of deploy.local's design: every screen on web, the Mac app and iPhone, drawn as a board. People and agents change a design the same way they change code, on a branch, and it reaches main through review.

The claude.ai canvas (https://claude.ai/artifact/3mS7t8tGJgTKdo1bnAanTr) shows the same boards; it was imported from there on 2026-10-30.

## Layout

| Path                | What it is                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas.json`       | The canvas: each board's position, size and title, the board order, and the notes beside them.                                                                                   |
| `boards/*.html`     | One standalone page per board, styled only by the design system. `<meta name="design-board">` gives its size.                                                                    |
| `ds/deploy-local/`  | The design system the boards use: `tokens.css`, `tokens.json` and `components/bundle.css` (the `dl-*` classes).                                                                  |
| `ds/README.md`      | The design system's rules: content, visual foundations, components.                                                                                                              |
| `tools/render.mjs`  | Renders boards to `output/design/<Board>-<width>.png` (web at 1440 and 700 px, phone at 390). `--main` renders the approved design from `origin/main` into `output/design-main`. |
| `tools/capture.mjs` | Screenshots a running page at the board widths, for parity evidence.                                                                                                             |
| `tools/pair.py`     | Puts screenshots side by side.                                                                                                                                                   |

## Layers

Every element a person or an agent can point at carries a `data-layer` ID that is unique within its board. Layers, selections, comments, history and agent edits all refer to the same ID, so keep it when you change an element and never reuse one for something else. New elements get IDs from:

```bash
node scripts/design-layers.mjs design/boards/Welcome.html
```

The server tests check that every board on the canvas exists and has unique layer IDs.

## Changing a design

1. Fetch `origin` and start a branch from `origin/main`. Edit the board in `design/boards/` (and `canvas.json` for a new board, its place or its notes) on that branch.
2. Render it at its widths with `node design/tools/render.mjs <Board>` and check it. The renderer refuses a checkout that lacks design changes main has, because approvals land on main without touching your checkout; `--stale-ok` renders it anyway. To review the current design, use `--main`.
3. Ask for review. Nothing visual is built until the design is approved (see `AGENTS.md`).

## Parity: implementation against design

A screen is done when it matches its board at the board's widths (1440 and 700 for web, 390 for iPhone) with the same data the board shows. Use the fixture names from the boards: home-gym, tally, SER, bazzite, Release notes writer, Ops watcher, Code reviewer, Researcher, Designer.

- **Board:** `node design/tools/render.mjs <Board>` writes `output/design/<Board>-<width>.png`.
- **Screenshot:** start your page against a fixture on ports 5180–5199, then run `node design/tools/capture.mjs <url> docs/evidence/<slice>/captures/<Board> 1440,700 <height>`. Add `--dark` for the dark theme.
- **Pair:** `uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/<slice>/<Board>-700.png output/design/<Board>-700.png <screenshot>`.
- **What must match:** structure, words, states and hierarchy. Pixel-exact is not required, but every difference is either fixed or written down in the slice's evidence note as a deliberate change.
