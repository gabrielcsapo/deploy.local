# One search: capture fixture and remaining differences

Run from the repository root with dependencies installed:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5192 node --import tsx docs/evidence/one-search/fixture-server.ts
```

The fixture mounts the real `V2Layout`, start page and a project's Code tab through Vite on loopback only. Every API response is seeded in memory with the boards' cast; it uses no coordinator, database, Git, workers or credentials. `fixture-q` types into the real search box the way a person would.

| State     | Board           | Reset URL                                       |
| --------- | --------------- | ----------------------------------------------- |
| names     | CommandPalette  | http://127.0.0.1:5192/__fixture?state=names     |
| text      | SearchText      | http://127.0.0.1:5192/__fixture?state=text      |
| searching | SearchSearching | http://127.0.0.1:5192/__fixture?state=searching |
| code      | SearchCode      | http://127.0.0.1:5192/__fixture?state=code      |
| none      | SearchNone      | http://127.0.0.1:5192/__fixture?state=none      |
| project   | SearchProject   | http://127.0.0.1:5192/__fixture?state=project   |
| file      | CodeFileMatch   | http://127.0.0.1:5192/__fixture?state=file      |
| code-tab  | Code            | http://127.0.0.1:5192/__fixture?state=code-tab  |

Each `<Board>-<width>.png` here is the board on the left and the app on the right, at 1440 and 700.

## Differences from the boards

Not yet decided by the owner:

- The footer has no "? all shortcuts": there is no shortcuts list for it to open.
- Ask names the first agent in the sidebar (Release notes writer in the fixture). The boards show Code reviewer and give no rule for which agent is asked.
- With nothing typed the box shows only its field; no board draws that state.

Known and outside this change:

- Times read as clock times (10:31) where the boards show elapsed (3m, done 2h ago), as in the sidebar.
- App rows say Worker or Web app without health (the boards add Healthy or Failing).
- Computers, pull requests and issues open their list, not the single item.
- The fixture's Code tab is mounted without the project page's header and tabs, and its inbox is not seeded in the shape the sidebar reads, so Waiting on you is missing from the names capture.
- A message result opens its chat; the chat does not yet scroll to that message.

Not built: iPhone Search (SearchPhone and the Search button on the Work boards).
