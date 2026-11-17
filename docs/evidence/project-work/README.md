# Project Work

Board: `design/boards/ProjectWork.html` (approved on main in a7b7fcbd, "Projects first"). It draws a project's Work tab at 1440 and 700 and, in its sidebar, the Group tasks setting Work.

Verified against the **built** server (`pnpm build`, then `node dist/server.js`) with a fresh data directory, seeded through the product's stores (`save`, `registerUser`, `createAgent`) with the board's names: deploy.local, home-gym, tally, react-flight-router, SER, bazzite, Code reviewer and the other four agents. Running runs and agent-found issues are written as records, since nothing short of a live worker or an agent run produces them.

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

The seed, the state capture script and the behaviour script were kept outside the repository with this run (see the report that came with this note).

## Paired images (board left, page right)

| Image                                         | State                                                  |
| --------------------------------------------- | ------------------------------------------------------ |
| `ProjectWork-1440.png`, `ProjectWork-700.png` | Open, with the sidebar grouped by Work                 |
| `ProjectWork-dark-1440.png`                   | Same, dark theme                                       |
| `Shipped-1440.png`, `Shipped-700.png`         | Shipped 31                                             |
| `NewIdea-1440.png`, `NewIdea-700.png`         | New idea dialog                                        |
| `OpenUpNext-1440.png`, `OpenUpNext-700.png`   | An Up next row opened: Cancel / Start                  |
| `OpenFound-1440.png`, `OpenFound-700.png`     | A Found by agents row opened: Dismiss / Add to Up next |
| `Empty-1440.png`, `Empty-700.png`             | A project with no work                                 |
| `GroupMenu-1440.png`                          | Sidebar Group tasks menu open, Work ticked             |
| `Focus-1440.png`                              | Keyboard focus on the Up next row                      |

The board draws only the first two; the others are paired with it for context.

## What matches

- Tabs, then Open | Shipped with counts and New idea at the end of the row, then Needs you, Running, Up next and Found by agents in that order, each section left out when empty. Up next and Found by agents carry the board's lines under their titles.
- Row words: "Ready to merge · #18 · checks passed", "On SER for 12 min", "Found by Code reviewer · on bazzite", "Written by Gabriel", "Found by Code reviewer in PR #15", "Found by Code reviewer". Leads: attention, running spinner, bulb. Times at the end, chevrons on every row.
- One 896 px column for tabs and rows at 1440; full width with 20 px gutters at 700, no horizontal scroll.
- Sidebar in Work: Agents stay, then one heading per project with live work, each with its + (New task in …) and its live rows; work with no project under Chats. Project headings link to `/dashboard/projects/<id>/work`.
- `/dashboard/projects/<id>/issues` and `/pulls` answer 302 to `/work`; the old `/dashboard/repositories/<id>/issues` 308s to `/work`; a pull request's own page still opens.

## Fixed in this pass

- **Column width.** Work used the wide project page (1200 px), so at 1440 its rows ran 112 px past the tabs on each side. Work now keeps the tabs' 896 px column, as the board draws it.
- **Section spacing.** Titles had 24 px above their rows and 4 px to the line under them; the board has 12 px and 0. Now 12 and 0, with 12 under the line.
- **Focus ring on rows that open a dialog.** Up next and Found rows are buttons; their ring sat outside the row and the group's rounded clip hid it. They now use the inset ring the link rows use.
- **New idea dialog** was titled "New issue" with "Create issue". It is now "New idea" with "Add to Up next", the words of the button that opens it and the section it lands in.
- **Empty state's New task** went to the home page; it now starts a task in this project.

## Behaviour checked in the browser (built server)

- Add to Up next on a found row moves it to Up next (it keeps "Found by Code reviewer in PR #15").
- Dismiss closes the finding; Found by agents disappears when it was the last one.
- New idea with a title and description adds a row at the top of Up next, "Written by Gabriel · now".
- Start on an Up next row creates a task and opens it; the row moves to Running.
- Group tasks: Work → Date (Today, Yesterday) → Project (… No project) → Work (… Chats). The choice is stored in `deploy.sidebar.tasks`, survives a reload, and focus returns to the Group tasks button.
- Tab order: tabs, Open, Shipped, New idea, then each row top to bottom, then the sidebar. No console or page errors.

## Differences from the board

Data the product does not have, left out rather than faked:

- **"4 files changed"** after "On SER for 12 min": rows do not read a task's diff.
- **"reviewed by Code reviewer"** on the Needs you row: nothing records an agent's review of a pull request.
- **The cross-project row** "Rename prefetchRSC to prefetchRoute · From react-flight-router · 3 places here · #52 · ready once 0.17.0 is published": there is no code index or cross-project work yet, so Open is 6 where the board says 7.
- **Inline code** in row titles (`prefetchRSC`): titles are plain text.
- **Tabs** Graph, Apps 1, Releases and Logs: they appear only when the project has an index, apps or releases. The fixture project has none.

Choices the board does not settle:

- **Running row numbers.** A running task with an issue shows its number ("… on bazzite · #21"); the board's row has none.
- **Sidebar order.** Projects are ordered by their latest live task (home-gym 3m first), rows newest first. The board lists deploy.local, home-gym, react-flight-router, tally, which reads as alphabetical or current project first, and puts Self-release (12m) above Repositories (4m).
- **Group tasks button in Work.** The board draws no Group tasks button on Work's first heading (its menu lists only Date and Project). The app keeps the button there with a third choice, Work, or there would be no way back.
- **A dismissed finding counts as Shipped** ("Closed"), raising Shipped by one. Dismissed work may deserve to leave the list instead.
- **New idea's Description** is a one-line field, as the old New issue dialog had.
- **Shipped** has no section title; the board does not draw it.

Already different across the app, not part of this change:

- The header shows "Project" after the breadcrumb and no Search button.
- The sidebar puts Agents above Waiting on you, shows "Waiting on you 0" when nothing waits, draws agents on two lines ("Say hello"), shows today's times as clock times (3:28) where the board has 3m, and the account footer shows the username.
- Agent avatars in the fixture are random glyphs, not the board's.
