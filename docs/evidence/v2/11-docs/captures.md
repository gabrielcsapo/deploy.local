# Docs captures

Capture is **blocked** in this sandbox. Chromium exited at launch with
`bootstrap_check_in … Permission denied (1100)`; see `capture.log`. No implementation
PNG or pair exists, and visual acceptance is not claimed.

From the repository root, start the isolated, hydrated fixture:

```sh
node docs/evidence/v2/11-docs/fixture-server.mjs
```

It listens only on **127.0.0.1:5180**, serves the actual 19 route components, and uses
no coordinator, account, database, worker or Docker. Port 5181 is reserved for
validation. The fixture includes legacy root header/footer markers to confirm that
the docs-scoped chrome rule hides them. Stop this process with Ctrl-C afterwards.

| Board       | Exact URL                           | Width | Height |
| ----------- | ----------------------------------- | ----- | ------ |
| DocsHome    | http://127.0.0.1:5180/docs          | 1440  | 1420   |
| DocsHome    | http://127.0.0.1:5180/docs          | 700   | 1420   |
| DocsArticle | http://127.0.0.1:5180/docs/releases | 1440  | 1240   |
| DocsArticle | http://127.0.0.1:5180/docs/releases | 700   | 1240   |
| DocsPhone   | http://127.0.0.1:5180/docs/releases | 390   | 844    |

```sh
node design/v2/tools/capture.mjs http://127.0.0.1:5180/docs docs/evidence/v2/11-docs/DocsHome-implementation 1440,700 1420
node design/v2/tools/capture.mjs http://127.0.0.1:5180/docs/releases docs/evidence/v2/11-docs/DocsArticle-implementation 1440,700 1240
node design/v2/tools/capture.mjs http://127.0.0.1:5180/docs/releases docs/evidence/v2/11-docs/DocsPhone-implementation 390 844
```

Pair with the unchanged boards, board on the left:

```sh
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/11-docs/DocsHome-1440.png design/v2/canvas/png/DocsHome-1440.png docs/evidence/v2/11-docs/DocsHome-implementation-1440.png
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/11-docs/DocsHome-700.png design/v2/canvas/png/DocsHome-700.png docs/evidence/v2/11-docs/DocsHome-implementation-700.png
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/11-docs/DocsArticle-1440.png design/v2/canvas/png/DocsArticle-1440.png docs/evidence/v2/11-docs/DocsArticle-implementation-1440.png
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/11-docs/DocsArticle-700.png design/v2/canvas/png/DocsArticle-700.png docs/evidence/v2/11-docs/DocsArticle-implementation-700.png
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/11-docs/DocsPhone-390.png design/v2/canvas/png/DocsPhone-390.png docs/evidence/v2/11-docs/DocsPhone-implementation-390.png
```

Review the pairs yourself, then check these interactions in the same headless fixture:

- At 1440, type `certificate` into Search docs; follow its heading result. Test an
  empty result and clear. Cmd/Ctrl-K focuses search; Tab reaches each result.
- At 700 and 390, open the menu, search, follow a result, and reopen the menu.
  Escape closes the menu and restores focus to its button. Menu links have 44px targets.
- Expand On this page with the keyboard and follow Rolling back. Check that the
  menu, long article, code blocks, previous/next links and edit link scroll without
  horizontal overflow. The article stays readable when contents are collapsed.
- Confirm one header and one article heading; the fixture's legacy markers are hidden.
- Repeat on the actual app after merging public chrome changes. This isolated
  fixture validates docs components; it is not an end-to-end root-router capture.

The 700px board's three squeezed columns are deliberately replaced by the narrow
layout. DocsPhone's simulated browser controls and blank clipped continuation are
not app content. The real document scrolls. See `notes.md` for all content differences.
