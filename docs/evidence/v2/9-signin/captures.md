# Capture handoff

Chromium failed to launch with `bootstrap_check_in … Permission denied (1100)`.
See `capture.log`. No implementation screenshots or pairs exist, so visual parity,
keyboard operation and scrolling have not been verified in a browser.

Start the standalone fixture from the repository root:

```sh
node docs/evidence/v2/9-signin/fixture-server.mjs
```

It serves the real slice components and synthetic API responses on **5197**;
Vite runs in middleware mode without a second port. It never imports the
coordinator or opens its database. It supplies its own tiny fixture router so
captures remain independent of production routing. The fixture alone simulates
certificate trust over loopback HTTP to show the passkey states. Production
still requires `isSecureContext` plus a successful HTTPS trust request.

| Board                                    | URL                                         | Widths   | Height |
| ---------------------------------------- | ------------------------------------------- | -------- | ------ |
| FirstAccount                             | http://127.0.0.1:5197/?board=FirstAccount   | 1440,700 | 900    |
| RecoverWeb                               | http://127.0.0.1:5197/?board=RecoverWeb     | 1440,700 | 900    |
| WebSignIn                                | http://127.0.0.1:5197/?board=WebSignIn      | 1440,700 | 900    |
| SessionExpired                           | http://127.0.0.1:5197/?board=SessionExpired | 1440,700 | 900    |
| PasskeyOffer                             | http://127.0.0.1:5197/?board=PasskeyOffer   | 1440,700 | 900    |
| Welcome                                  | http://127.0.0.1:5197/?board=Welcome        | 1440,700 | 900    |
| NewProject                               | http://127.0.0.1:5197/?board=NewProject     | 1440,700 | 900    |
| FirstTask                                | http://127.0.0.1:5197/?board=FirstTask      | 1440,700 | 900    |
| InstallApp                               | http://127.0.0.1:5197/?board=InstallApp     | 1440,700 | 900    |
| AppsHome                                 | http://127.0.0.1:5197/?board=AppsHome       | 1440,700 | 900    |
| AppsHomePhone                            | http://127.0.0.1:5197/?board=AppsHomePhone  | 390      | 844    |
| CLI browser approval (extra web surface) | http://127.0.0.1:5197/?board=CliLogin       | 1440,700 | 900    |
| Devices (no reference board)             | http://127.0.0.1:5197/?board=Devices        | 1440,700 | 900    |
| Account (no separate reference board)    | http://127.0.0.1:5197/?board=Account        | 1440,700 | 900    |

Capture each row using its exact URL/widths/height, for example:

```sh
node design/v2/tools/capture.mjs 'http://127.0.0.1:5197/?board=FirstAccount' docs/evidence/v2/9-signin/captures/FirstAccount 1440,700 900
uv run --no-project --python 3.13 --with pillow python design/v2/tools/pair.py docs/evidence/v2/9-signin/FirstAccount-1440.png design/v2/canvas/png/FirstAccount-1440.png docs/evidence/v2/9-signin/captures/FirstAccount-1440.png
```

Use the matching reference height if its checked-in PNG changes. `InstallSer`
and `CliLogin` are CLI storyboards, not web screens; no matching CLI screenshots
are claimed. `SignIn` is desktop-shell UI outside this branch's implementation;
`SignInPhone` is server-only here and its payload is documented in `pairing.md`.
The task fixture behind SessionExpired is synthetic; the task-page agent owns
that screen. Inspect each produced pair and correct discrepancies before claiming
parity. Stop the fixture with Ctrl-C when finished.
