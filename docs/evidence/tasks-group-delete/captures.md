# Tasks by project and task delete: capture fixture

Run from the repository root with dependencies installed:

```sh
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5191 node --import tsx docs/evidence/tasks-group-delete/fixture-server.ts
```

The fixture mounts the real `V2Layout`, task page and start page through Vite on loopback only, using `fixture-router.tsx` in place of the router. Every API response is seeded in memory; the only writes go to a temporary directory printed at startup and removed on Ctrl-C. It uses no coordinator, database, Git, workers, credentials, mDNS or remote requests (the CSP allows only the fixture's own origin, so the app's Google Fonts stylesheet is blocked and text renders in the system font). Unknown API routes return 404, and mutations other than task delete and starting a task return 405.

The cast is the TasksByProject board's: deploy.local (7 tasks, so "Show 2 more" appears), home-gym, tally, and Fix bazzite startup with no project. Cache Discover images on SER failed and stopped; its branch is scout/discover-cache with 2 commits not on main. Self-release pipeline and Fix the sync migration are running. Times are relative to now.

Each reset reseeds and opens the task page. The `fixture-*` parameters choose the grouping and click the same controls a person would, so a plain screenshot shows an open menu.

| State       | Board          | Reset URL                                         |
| ----------- | -------------- | ------------------------------------------------- |
| by-project  | TasksByProject | http://127.0.0.1:5191/__fixture?state=by-project  |
| group-menu  | TasksGroupMenu | http://127.0.0.1:5191/__fixture?state=group-menu  |
| row-menu    | TaskRowMenu    | http://127.0.0.1:5191/__fixture?state=row-menu    |
| task-menu   | TaskMenuDelete | http://127.0.0.1:5191/__fixture?state=task-menu   |
| delete      | TaskDelete     | http://127.0.0.1:5191/__fixture?state=delete      |
| new-task-in | (none)         | http://127.0.0.1:5191/__fixture?state=new-task-in |

Capture and pair (boards rendered with `node design/tools/render.mjs <Board>`):

```sh
for pair in by-project:TasksByProject group-menu:TasksGroupMenu row-menu:TaskRowMenu task-menu:TaskMenuDelete delete:TaskDelete; do
  node design/tools/capture.mjs "http://127.0.0.1:5191/__fixture?state=${pair%%:*}" docs/evidence/tasks-group-delete/captures/${pair##*:} 1440,700 900
done
node design/tools/capture.mjs "http://127.0.0.1:5191/__fixture?state=new-task-in" docs/evidence/tasks-group-delete/captures/NewTaskIn 1440,700 900
for b in TasksByProject TasksGroupMenu TaskRowMenu TaskMenuDelete TaskDelete; do for w in 1440 700; do
  uv run --no-project --python 3.13 --with pillow python design/tools/pair.py docs/evidence/tasks-group-delete/$b-$w.png output/design/$b-$w.png docs/evidence/tasks-group-delete/captures/$b-$w.png
done; done
```

Each pair is the board on the left and the app on the right. `node docs/evidence/tasks-group-delete/verify.mjs` drives the running fixture with real pointer and keyboard input: hover and keyboard focus swap the time for ⋯, right-click opens the menu, a running task has neither, a menu on the last row scrolls fully into the sidebar, Show 2 more, deleting a row, switching grouping, deleting the open task (start page, then Not found), and a project's + choosing that project on the start page and sending it. `--check` on the fixture server runs its data checks without a browser or socket.

Remaining differences from the boards, all outside this change unless noted:

- Sidebar times read as clock times (9:15) where the boards show elapsed (2m, 22m). The app's list format, used by Date mode and agents, is unchanged.
- A failed task shows the app's stalled clock icon, where the boards show the red failed icon.
- The sidebar keeps its Agents and Waiting on you sections; the boards show seeded agents and hide an empty Waiting on you.
- The task page is the app's current page (status line, tabs, details panel, work log collapsed) rather than the boards' simplified one; this change only adds its Delete task… item.
- In the captures the first menu item and the dialog's Cancel show a focus ring, because the fixture opens them by script. With a real mouse click no ring shows (checked in verify-time probing); with the keyboard it does.
- Text wraps a little differently because the fixture blocks the remote font.
