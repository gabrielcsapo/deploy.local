# deploy.local design

This folder is the source of deploy.local's design: every screen on web, the Mac app and iPhone, drawn as a board. People and agents change a design the same way they change code: on a branch, beside the code, merged when its check is clean.

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

A design is the boards on a branch, beside the code that builds them. Merging the branch is the approval. From the project's folder:

1. `deploy design guide` once: platforms and sizes, the type and spacing scale, components, fixture names and the check codes.
2. `deploy design status <Board>` before you start: the current board of that screen (boards that were replaced are never offered), its source on the other platform, components, open questions and other branches changing it.
3. Edit the boards in `design/boards/` (and `canvas.json` for a new board's place, title and notes). Mark what the product doesn't decide with `data-question="…"` instead of inventing it.
4. `deploy design check --fix` runs on this computer: it draws each changed board beside main in light and dark into `output/design/pairs`, fixes what has one answer (layer IDs, heights) and lists problems (block the merge) and notes (taste: type or spacing off the scale, edges nearly aligned, rows unlike their siblings, a second primary button, layer names that say nothing). Look at every pair.
5. Rebase on main, run check again, merge when it is clean.

### Board meta

`<meta name="design-board" content="width=390,height=844,platform=phone,source=PipelineRun.html">`. Keys: `width`, `height`, `platform` (web, phone, mac…), `schemes`, `title`, `source` (the board this one was drawn from on another platform) and `replaces` (boards this one replaced, space-separated). A replaced board stays on main for history; `status` and agents start from the board that replaced it.

## Parity: implementation against design

A screen is done when it matches its board at the board's widths (1440 and 700 for web, 390 for iPhone) with the same data the board shows. Use the fixture names from the boards: home-gym, tally, SER, bazzite, Release notes writer, Ops watcher, Code reviewer, Researcher, Designer.

- **Board:** `node design/tools/render.mjs <Board>` writes `output/design/<Board>-<width>.png`.
- **Screenshot:** start your page against a fixture on ports 5180–5199, then run `node design/tools/capture.mjs <url> docs/evidence/<slice>/captures/<Board> 1440,700 <height>`. Add `--dark` for the dark theme.
- **Pair:** `uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/<slice>/<Board>-700.png output/design/<Board>-700.png <screenshot>`.
- **What must match:** structure, words, states and hierarchy. Pixel-exact is not required, but every difference is either fixed or written down in the slice's evidence note as a deliberate change.
