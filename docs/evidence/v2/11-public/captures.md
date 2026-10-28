# Public slice capture handoff

Chromium launch failed in this sandbox with `bootstrap_check_in … Permission denied (1100)`.
No new captures or paired visual sign-off are claimed. The static Live images in
`app/routes/v2-public/about/live-{1440,700}.png` are byte-for-byte copies of the real Live fixture
captures already committed in `docs/evidence/v2/2-live/captures/`. They are not board renders.
Both reused images were inspected. A fresh 390-wide Live image is still needed.

Start only these two isolated processes, from the repo root:

```sh
node docs/evidence/v2/11-public/fixture-server.mjs
DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5199 pnpm exec vite --host 127.0.0.1 --port 5198 --strictPort
```

The fixture server reuses the Live slice's API data without changing its file or port. It also
serves the production edge HTML functions at the URLs below. No coordinator or Docker is used.

First refresh the product's real Live asset:

```sh
node design/v2/tools/capture.mjs http://127.0.0.1:5198/dashboard/live app/routes/v2-public/about/live 1440,700 1100
node design/v2/tools/capture.mjs http://127.0.0.1:5198/dashboard/live app/routes/v2-public/about/live 390 1100
```

After capturing 390, point the `<source>` import in `page.tsx` at `live-390.png` instead of
`live-700.png`; the current narrow asset is an explicit fallback. Capture and review the product
again after that change. This shows the responsive web Live screen, not native iPhone UI.

| Board / screen                   | Exact URL                                                                        | Widths   | Height |
| -------------------------------- | -------------------------------------------------------------------------------- | -------- | ------ |
| Landing                          | `http://127.0.0.1:5198/about`                                                    | 1440,700 | 2120   |
| LandingPhone                     | `http://127.0.0.1:5198/about`                                                    | 390      | 844    |
| Landing, complete phone page     | `http://127.0.0.1:5198/about`                                                    | 390      | 2500   |
| Changelog, board fixture         | `http://127.0.0.1:5198/docs/evidence/v2/11-public/fixture.html?screen=changelog` | 1440,700 | 1100   |
| Changelog, real build-time notes | `http://127.0.0.1:5198/changelog`                                                | 1440,700 | 1100   |
| AppNotFound                      | `http://127.0.0.1:5199/__fixtures/app-not-found`                                 | 1440,700 | 900    |
| AppUnavailable                   | `http://127.0.0.1:5199/__fixtures/app-unavailable`                               | 1440,700 | 900    |
| AppUnavailable, stopped          | `http://127.0.0.1:5199/__fixtures/app-stopped`                                   | 1440,700 | 900    |
| In-app 404 / Empty               | `http://127.0.0.1:5198/docs/evidence/v2/11-public/fixture.html?screen=not-found` | 1440,700 | 900    |
| Error recovery                   | `http://127.0.0.1:5198/docs/evidence/v2/11-public/fixture.html?screen=error`     | 1440,700 | 900    |

For each row run:

```sh
node design/v2/tools/capture.mjs '<exact URL>' docs/evidence/v2/11-public/captures/<Board> <widths> <height>
```

Pair each applicable render with `design/v2/tools/pair.py` (board left, implementation right).
Inspect each pair and fix unintentional differences before visual acceptance. For LandingPhone,
the board includes Safari's top safe area and bottom address bar; the page intentionally does
not draw browser chrome. Test the copy button, mobile menu, keyboard focus, footer links and
horizontal scrolling at 390. Also capture dark mode with `--dark` and inspect recovery states.
Stop both fixture processes afterward.
