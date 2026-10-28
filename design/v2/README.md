# deploy.local v2 design

This folder is the source of the v2 design. The published copies are views of it:

- **Canvas:** https://claude.ai/artifact/3mS7t8tGJgTKdo1bnAanTr (131 boards on 11 pages, one page per flow)
- **Design system:** https://claude.ai/artifact/5Sv6UWeiDvpgnenyfDurkZ
- **Implementation brief:** [docs/plans/v2-design-implementation.md](../../docs/plans/v2-design-implementation.md)

## Layout

| Path                               | What it is                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/flows.py`                   | The map: canvas pages → steps → boards per platform (web, iPhone, desktop app, CLI). The Coverage board and the canvas layout both read it. |
| `tools/b_*.py`                     | Board generators, grouped by flow. Each module fills `B[name] = (page, title, html[, w, h])`.                                               |
| `tools/shell.py`, `tools/icons.py` | Shared pieces: sidebar, heads, composer, work log, phone frame, icons.                                                                      |
| `ds/project/`                      | The design system: `tokens.json`, `components/bundle.css` (the `dl-*` classes), component cards, and the README with the build rules.       |
| `tokens.css`                       | Generated from `ds/project/tokens.json`.                                                                                                    |
| `canvas/project/`                  | Generated boards (`*.dc.html`) and `canvas.json`. This is exactly what gets published to the canvas.                                        |
| `canvas/png/`                      | Generated renders. Web boards are rendered at 1440 and 700 px (`Name-1440.png`, `Name-700.png`), iPhone boards at 390 px.                   |

Everything under `canvas/` is generated. Edit `tools/` or `ds/`, never `canvas/` by hand.

## Rebuilding

Run these from the repo root. They need `uv` and Google Chrome.

```bash
design/v2/build.sh
```

`build.sh` rebuilds every board, lays out the canvas, and renders every PNG (about a minute).

```bash
design/v2/build.sh Live Inbox
```

Pass board names to rebuild everything but render only those boards.

## Changing the design

1. Edit the generator (`tools/b_*.py`) or the design system (`ds/project/`). Add a new board to a step in `tools/flows.py`, or it won't be placed on the canvas.
2. Run `design/v2/build.sh`.
3. Publish `canvas/project/` to the canvas artifact.
4. Commit the source and the regenerated `canvas/` in the same commit.

A design change and the code that implements it can land separately. When the code lands, its evidence must match the board as of that commit.

## Parity: implementation against design

Each slice in the brief names its boards. A slice is done when its screens match those boards.

- **Capture:** screenshot the implementation at the board's widths (1440 and 700 for web, 390 for iPhone) with the same data the board shows. Use the fixture names from the boards: home-gym, SER, bazzite, Scout, Warden.
- **Screenshot:** start your page against a fixture on ports 5180–5199, then run `node design/v2/tools/capture.mjs <url> docs/evidence/v2/<slice>/captures/<Board> 1440,700 <height>`. Add `--dark` for the dark theme. It uses headless Playwright Chromium from `node_modules`; you don't need a desktop browser or screen control.
- **Pair:** put each screenshot next to the board with `tools/pair.py`, and save it under `docs/evidence/v2/<slice>/`:

  ```bash
  uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/1-inbox/inbox-700.png design/v2/canvas/png/Inbox-700.png /path/to/screenshot.png
  ```

- **What must match:** structure, words, states and hierarchy. Pixel-exact is not required, but every difference is either fixed or written down in the slice's evidence note as a deliberate change.
- **When the code is right and the board is wrong:** update the board here in the same PR, so design and code never drift apart.
