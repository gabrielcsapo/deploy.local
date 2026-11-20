# Workday quality: Waiting on you, its item page and Welcome

Approved design: f85d7363 ("Workday quality"), boards Inbox, InboxDetail, Welcome and WelcomeNarrow.

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5192 node --import tsx docs/evidence/workday-quality/fixture-server.ts
```

The fixture mounts the real `V2Layout`, Waiting on you page and new-task page through Vite on loopback, with `../board-parity/fixture-router.tsx` in place of the router. Every API response is seeded in memory with the Inbox board's cast (Roll back forma?, six designs, four proposals, one question); mutations return 405. Design previews are the board renders in `output/design` (render `Computer`, `Diagnostics` and `DiagnosticsEmpty` first). The account is not yet welcomed, so `/dashboard` shows Welcome.

| Board       | URL                                                                          | Widths    |
| ----------- | ---------------------------------------------------------------------------- | --------- |
| Inbox       | `/dashboard/inbox?item=design%3Adeploy-local%3Aserver-diagnostics%3A2a91c0e` | 1440      |
| Inbox       | `/dashboard/inbox`                                                           | 700       |
| InboxDetail | `/dashboard/inbox?item=design%3Adeploy-local%3Aserver-diagnostics%3A2a91c0e` | 700, 1440 |
| Welcome     | `/dashboard`                                                                 | 1440, 700 |

Each pair (`<Board>[-dark]-<width>.png`) is the board on the left and the app on the right. Dark boards were drawn with `data-theme="dark"` on the board page.

## Differences left on purpose

- **Proposals has no slot footnote, and Keep pull requests smaller has a proposal mark, not a learning mark.** Waiting on you has no proposal-slot or learning data yet; nothing is shown rather than an invented count.
- **11 notes names the notes** ("Overview, Git, Processes, API requests, Traffic and 6 more") instead of the board's generic "What each screen does and when it shows", the same way the screens row names screens.
- **Crops are the review's real previews**, cut around the change at about the screen's own size and outlined in After, not the board's hand-drawn minis. In dark they stay light: previews are drawn in light.
- **The sidebar is unchanged** apart from its Waiting on you rows opening the item here: its section order (Agents before Waiting on you) and row times ("2:27" rather than "17m") are the existing sidebar's.
- **Welcome's composer** keeps the app's placeholder ("Ask, build, or follow up…"), project chip and model choice; only its raised hero treatment changed.
- **Text renders in the system font** in these captures: the fixture page does not load Hanken Grotesk.
