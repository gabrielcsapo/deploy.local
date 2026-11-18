# Project Work

Boards: `design/boards/ProjectWork.html` (approved in a7b7fcbd, "Projects first") and its other states, `ProjectWorkShipped`, `ProjectWorkIdea`, `ProjectWorkFound`, `ProjectWorkNew`, `ProjectWorkEmpty` and `ProjectWorkGroupMenu` (approved in 81632046, "Work's other states"), with the canvas notes project-work-sidebar, project-work-empty and project-work-states.

Verified against the **built** server (`pnpm build`, then `node dist/server.js`) with a fresh data directory, seeded through the product's stores (`save`, `registerUser`, `createAgent`) with the board's names: deploy.local, home-gym, tally, react-flight-router, SER, bazzite, Code reviewer and the other four agents. Running runs and agent-found issues are written as records, since nothing short of a live worker or an agent run produces them. Shipped is seeded as the board lists it (Merged · #47 … Closed · #12 … Finished … Merged · #40, 1d to 10d) followed by older merged work, 31 in all. Two extra projects give the other empty lines: `archive` (everything shipped) and `react-flight-router` (nothing shipped).

```bash
export DEPLOY_DATA_DIR="$(mktemp -d)"            # empty; the seed creates the account
node --import tsx <seed>/project-work-seed.mts > seed.json   # prints a local fixture token
pnpm build
DEPLOY_ROLE=control CONTROL_PORT=5188 DEPLOY_MDNS_ADDRESS=127.0.0.1 \
  DEPLOY_PUBLIC_ORIGIN=http://127.0.0.1:5188 DOCKER_HOST=unix:///nonexistent/docker.sock \
  node dist/server.js
node design/tools/capture.mjs http://127.0.0.1:5188/dashboard/projects/deploy-local/work \
  docs/evidence/project-work/captures/ProjectWork 1440,700 960 \
  --storage 'deploy-sh-auth={"username":"gabriel","token":"…"}' --storage deploy.sidebar.tasks=work
```

`ProjectWork` and `ProjectWorkEmpty` (the `quiet` project) are captured with `capture.mjs`. The states that need a click (Shipped, the three dialogs, the Group tasks menu) are captured by a Playwright script with the same sign-in, viewport (width × 960) and grouping. The seed, that capture script and the behaviour script were kept outside the repository with this run (see the report that came with this note).

## Paired images (board left, page right)

One pair per board and width, `<Board>-1440.png` and `<Board>-700.png`; the page's own screenshots are in `captures/`.

| Board                  | State                                                          |
| ---------------------- | -------------------------------------------------------------- |
| `ProjectWork`          | Open, with the sidebar grouped by Work                         |
| `ProjectWorkShipped`   | Shipped 31                                                     |
| `ProjectWorkIdea`      | An Up next row opened: byline, description, Cancel / Start     |
| `ProjectWorkFound`     | A Found by agents row opened: byline, Dismiss / Add to Up next |
| `ProjectWorkNew`       | New idea, with a title and a several-line description          |
| `ProjectWorkEmpty`     | A project with no work                                         |
| `ProjectWorkGroupMenu` | Group tasks menu on the first project heading, Work ticked     |

`ProjectWorkGroupMenu-700` has no menu: below 820 px the sidebar is hidden, and the board's 700 draws the page alone. `captures/NothingOpen-*` and `captures/NothingShipped-*` show the two empty lines the project-work-empty note records; no board draws them.

## What matches

- Tabs, then Open | Shipped with counts and New idea at the end of the row, then Needs you, Running, Up next and Found by agents in that order, each section left out when empty. Up next and Found by agents carry the board's lines under their titles.
- Row words: "Ready to merge · #18 · checks passed", "On SER for 12 min", "Found by Code reviewer · on bazzite", "Written by Gabriel", "Found by Code reviewer in PR #15", "Found by Code reviewer". Leads: attention, running spinner, bulb. Times at the end, chevrons on every row.
- One 896 px column for tabs and rows at 1440; full width with 20 px gutters at 700, no horizontal scroll.
- Sidebar in Work: Agents stay, then one heading per project with live work, each with its + (New task in …) and its live rows; work with no project under Chats. Project headings link to `/dashboard/projects/<id>/work`.
- `/dashboard/projects/<id>/issues` and `/pulls` answer 302 to `/work`; the old `/dashboard/repositories/<id>/issues` 308s to `/work`; a pull request's own page still opens.

## Fixed in this pass

Against the second round of boards (Work's other states):

- **Shipped rows** have no chevrons, so their times line up in one column (`Item` takes `chevron={false}`). A task that finished without a merged pull request reads "Finished" (it read "Done"); the lines are "Merged · #N", "Closed · #N" and "Finished". The server test covers "Finished".
- **An opened Up next or Found row** carries its byline under the title in the dialog's head, with when it was written or found: "Written by Gabriel · 3 days ago", "Found by Code reviewer in PR #15 · 3 days ago" (`Dialog` takes `meta`). The body is the description alone.
- **New idea's Description** is a four-line text area in the body's type, as drawn.
- **Empty project**: no Open | Shipped switch and no New idea bar, only the empty state: bulb, "No work yet", "Ideas you write down and tasks you start show here.", New idea and New task.
- **Nothing open** reads "Everything here has shipped." with New idea and New task; **Nothing shipped yet** reads "Merged pull requests, finished tasks and closed ideas show here." with no actions, as the project-work-empty note records.

From the first round:

- **Column width.** Work keeps the tabs' 896 px column, as the board draws it.
- **Section spacing.** 12 px between a title and its rows, 0 to the line under it, 12 under the line.
- **Focus ring on rows that open a dialog** is inset, as on link rows.
- **New idea dialog** is "New idea" with "Add to Up next".
- **Empty state's New task** starts a task in this project.

## Behaviour checked in the browser (built server)

- Add to Up next on a found row moves it to Up next (it keeps "Found by Code reviewer in PR #15").
- Dismiss closes the finding; Found by agents disappears when it was the last one.
- New idea with a title and a description (typed into the text area) adds a row at the top of Up next.
- Dialogs: New idea puts focus in Title; an opened Up next or Found row puts it on the first action (Cancel, Dismiss), since the dialog has no field. Escape closes each one and focus returns to the row (or to New idea) that opened it.
- Start on an Up next row creates a task and opens it; the row moves to Running.
- Group tasks: Work → Date (Today, Yesterday) → Project (… No project) → Work (… Chats). The choice is stored in `deploy.sidebar.tasks`, survives a reload, and focus returns to the Group tasks button.
- Tab order: tabs, Open, Shipped, New idea, then each row top to bottom, then the sidebar. No console or page errors in any state at either width.

## Differences from the board

Data the product does not have, left out rather than faked:

- **"4 files changed"** after "On SER for 12 min": rows do not read a task's diff.
- **"reviewed by Code reviewer"** on the Needs you row: nothing records an agent's review of a pull request.
- **The cross-project row** "Rename prefetchRSC to prefetchRoute · From react-flight-router · 3 places here · #52 · ready once 0.17.0 is published": there is no code index or cross-project work yet, so Open is 6 where the board says 7, and Work's tab count is 6.
- **Inline code** in row titles (`prefetchRSC`): titles are plain text.
- **Tabs** Graph, Apps 1, Releases and Logs: they appear only when the project has an index, apps or releases. The fixture project has none.
- **Shipped's tail.** The board stops at its eleventh row; the fixture lists the rest of the 31 below it (Show checks on pull requests · #15 at 11d, then older merges).

Choices the board does not settle:

- **Running row numbers.** A running task with an issue shows its number ("… on bazzite · #21"); the board's row has none.
- **Sidebar order.** Projects are ordered by their most recent live work, newest first, as the project-work-sidebar note says, so home-gym (3m) comes before deploy.local here. The boards draw deploy.local first and put Self-release (12m) above Repositories (4m), which the note does not follow.
- **Running row times.** A row that started hours ago shows "5h"; the board writes "today". Work uses the same short times as every other list.
- **"Nothing open"** keeps the Open | Shipped switch (Shipped is the only way to the shipped work) and the empty state's bulb; the note records only its words and actions.
- **Dismissed findings** count as Shipped ("Closed · #N"), as closed ideas do.

Already different across the app, not part of this change:

- The header shows "Project" after the breadcrumb and no Search button.
- The sidebar puts Agents above Waiting on you, shows "Waiting on you 0" when nothing waits, draws agents on two lines ("Say hello"), shows today's times as clock times (3:28) where the board has 3m, and the account footer shows the username.
- Agent avatars in the fixture are random glyphs, not the board's.
