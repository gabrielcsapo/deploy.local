# A pull request no task opened: Merge and Close

Boards: `design/boards/PullRequestOpen.html` (ready to merge), `PullRequestBlocked.html` (conflicts with main, files filtered, an image opened) and `PullRequest.html` (merged, ⋯ menu open), approved in 6aae1d22 ("A pull request no task opened: Merge and Close, and a calmer page"), with the canvas note `pull-request-states` for every other state.

Verified against the **built** server (`pnpm build`, then `node dist/server.js` and the Git service `node dist/workspace-repository-worker.js`, which runs merges) with a fresh data directory. The fixture repository is real: a bare repository that borrows this checkout's objects and holds only the fixture's branches, so `build/project-work` is the board's own branch at 8ab72bd against main at 870ade7: four commits (two of them merges from main), 68 files, +1599 −371, and the `docs/evidence/project-work` PNGs.

| #   | Branch                        | State                                                                              |
| --- | ----------------------------- | ---------------------------------------------------------------------------------- |
| 26  | `build/project-work`          | Open, mergeable, 4 checks passed (the board's PullRequestOpen)                     |
| 27  | `build/project-work-settings` | #26 plus one commit; main changed the same lines, so it conflicts in the two files |
| 16  | `gabriel/published-checks`    | Merged two days ago, three commits, four files, released                           |
| 20  | `gabriel/retry-release`       | Closed                                                                             |
| 28  | `gabriel/flaky-test`          | Open, the required `test` check failed                                             |
| 29  | `gabriel/calmer-header`       | Open, required checks running (2 of 4 done)                                        |
| 30  | `gabriel/nothing-new`         | Open, nothing main does not already have                                           |
| 31  | `task/task-pull`              | A task's own pull request, to check the task page's merge                          |

```bash
export DEPLOY_DATA_DIR="$(mktemp -d)"            # empty; the seed creates the account
node --import tsx <seed>/pr-seed.mts > seed.json # prints a local fixture token
pnpm build
DEPLOY_NODE_NAME=SER DEPLOY_ROLE=control CONTROL_PORT=5196 DEPLOY_MDNS_ADDRESS=127.0.0.1 \
  DEPLOY_PUBLIC_ORIGIN=http://127.0.0.1:5196 DOCKER_HOST=unix:///nonexistent/docker.sock \
  node dist/server.js
node dist/workspace-repository-worker.js         # same DEPLOY_DATA_DIR; merges run here
```

Each state is captured by a Playwright script with the fixture's sign-in at width × the board's height: PullRequestOpen as loaded; PullRequestBlocked after typing `ProjectWork-` into Filter files and opening `captures/ProjectWork-1440.png`; PullRequest after opening `server/releases/verify.ts` and the ⋯ menu. The seed and both scripts were kept outside the repository with this run (see the report that came with this note).

## Paired images (board left, page right)

One pair per board and width, `<Board>-1440.png` and `<Board>-700.png`; the page's own screenshots are in `captures/`.

| Board                | State                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `PullRequestOpen`    | Ready to merge: Close and Merge; files folded, eight then Show 60 more  |
| `PullRequestBlocked` | Conflicts with main; Filter files reads `ProjectWork-`, an image opened |
| `PullRequest`        | Merged, with the ⋯ menu open and the first diff opened                  |

## What matches

- The decision row under the title, in every state the note lists, with the note's words: "Ready to merge · Checks passed, no conflicts with main" (Close quiet, Merge primary); "Conflicts with main" with conflictReason()'s first sentence (Close, Update from main in a task); "Checks running · Required pipeline checks have not passed for 0be519d yet: 2 of 4 done." (Merge disabled); "Checks failed · … : test failed." with `test` linking to its run (Close, Fix in a task); "Nothing to merge · … has no commits that main does not already have." (Close primary); "Merging into main…" with a spinner and no actions; "Merge failed · <the server's error>" (Close, Retry merge); "Closed · Gabriel closed this pull request 2 days ago." (Reopen). A merged pull request has no decision row. The old "Opened from a branch, not by a task…" notice is gone in every state.
- ⋯ beside the title: Start a task on this branch (open), Start a follow-up task on main (merged or closed).
- The header's New task is secondary on an open pull request and primary once it is merged or closed.
- The page keeps the tabs' 896 px column at 1440, as Work does; full width with 20 px gutters at 700, no horizontal scroll.
- The description's Markdown list is a bulleted list, with inline code as drawn.
- The checks row ("4 checks passed · on 8ab72bd ›") opens the pull request's pipeline run.
- Commits: the two merges from main fold into "2 merges from main · latest … ago", which opens to list them.
- Files changed: Filter files in the section head, all files folded, eight rows then "Show 60 more"; "4 of 68" while filtering; image rows read "Image · added", and an opened image shows its preview with "1440 × 960 · 123 KB".
- Merged: "Merged into main by Gabriel · <commit> · 2 days ago" and "Released to SER".

The note's other states are in `captures/` as the page shows them (no board draws them): `State-failed-*` (Checks failed, `test` links to its run), `State-running-*` (Checks running, Merge disabled), `State-nothing-*` (Nothing to merge), `State-closed-*` (Closed, Reopen), `State-merge-failed-1440` (Merge failed, Retry merge) and `Description-lists.png` (an ordered list with a nested list, a nested bullet, a link, inline code and a code block).

## Server additions

The diff read (`GET /api/projects/:project/pulls/:id/diff`) gains what a pull request with no task needs, and the task page keeps reading what it read before:

- `mergeBlockKind` (`status`, `no-changes`, `conflicts`, `checks` or null) says which rule blocks the merge.
- `conflictSummary` is conflictReason()'s first sentence on its own, naming the files as a sentence would ("… in a and b."). `mergeBlock` keeps both sentences for the task page.
- `requiredChecks` (only when checks block it): the run, its status, how many jobs are done of how many, and which failed.
- Each commit carries its `parents`, and `mergesTarget` when it merges the target branch in, so merges from main can fold.

A first message from the start page may carry `ref` with its project (`/api/composer/messages`), so a task starts at a branch: "Start a task on this branch", "Start a follow-up task on main", "Update from main in a task" and "Fix in a task" use it. Server tests cover each.

## Behaviour checked in the browser (built server)

- **Merge merges.** On #26 Merge shows "Merging into main…", then the page becomes the merged state: the pill reads Merged, the byline "Gabriel merged 4 commits into main from build/project-work just now", "Merged into main by Gabriel · ddfff9c · just now", no decision row, ⋯ offers Start a follow-up task on main, and the header's New task is primary again. main moved to a merge commit whose parents are the old main and 8ab72bd. The project's Work tab lists "Merged · #26" under Shipped.
- **A merge that fails.** With main's ref lock held, Merge shows "Merging into main…" and then "Merge failed · Git command failed (128): fatal: prepare: cannot lock ref 'refs/heads/main' …" with Close and Retry merge; main did not move. With the lock released, Retry merge lands it.
- **Close, then Reopen** (#30): "Closed · Gabriel closed this pull request just now." with Reopen and the pill reading Closed; Reopen brings back "Nothing to merge".
- **Files:** Filter files narrows 68 to "4 of 68" and Escape clears it; Show 60 more lists all 68 and goes away; an image opens as its preview with "1440 × 960 · 123 KB"; a text file opens as its diff, focus moves to its fold button and back to its row when folded.
- **Merges from main:** "2 merges from main · latest … ago" opens (`aria-expanded`) to list both merge commits.
- **⋯ menu:** Start a task on this branch opens New task with deploy.local chosen and "On build/project-work, the branch of pull request #26 (…): " begun; sending it starts a task in deploy.local whose base is 8ab72bd. Start a follow-up task on main (#16) starts one at main's tip. Fix in a task (#28) and Update from main in a task (#27) start tasks on their branches at once, with first messages that say what to do ("The test check failed on gabriel/flaky-test at 2cddb32, so pull request #28 (…) cannot merge. Find out why and fix it. The failed run is at …"; "Merge main into build/project-work-settings and resolve the conflicts in app/routes/dashboard/v2/SidebarTasks.tsx and server/v2/settings.ts, so pull request #27 (…) can merge.").
- **Checks row:** "4 checks passed" opens Pipelines with that pull request's run selected (8ab72bd, typecheck, lint, test and build passed).
- **Keyboard:** from the title, Tab reaches ⋯ (More), Close, Merge, the checks row, the commits, 2 merges from main, then Filter files. Each shows its focus ring (the filter's ring is on its field). Enter on ⋯ opens the menu with focus on its item; Escape closes it and returns focus to ⋯.
- **The task page's own merge** still works: Merge only on a task's pull request (#31) merges it.
- No console or page errors in any state at either width; no horizontal scroll at 700.

## Differences from the boards

Data, from a fixture that is this repository's real history:

- **PullRequestBlocked is #27, not #26.** #26 has to stay mergeable for PullRequestOpen and Merge, so the conflicting pull request is its branch plus one commit (`build/project-work-settings`): 5 commits where the board says 4, and +1601 −373.
- **Commit bylines** read "Gabriel J. Csapo" (the commits' real author) and real times, where the board says "Gabriel · 6 hours ago".
- **PullRequest (merged)** lists its files in path order, as the note asks, so the opened `server/releases/verify.ts` is last where the board draws it first; its diff lines are the fixture's.
- **The image preview** is the PNG itself at the board's 540 px; the board draws the page it shows.

Deliberate, where the boards say nothing:

- **Filter files shows only when there are more than eight files**, so the merged board's four files have no field, as drawn there.
- **Ready to merge without any checks** reads "No conflicts with main" rather than claiming checks passed.
- **Checks blocked with no run recorded yet** reads "Required pipeline checks have not passed for <commit> yet." without a count.
- **A merge failure only stays the decision for the version it tried.** Once main or the branch moves, the page judges the new version (Merge again, or Conflicts).
- **The old "Closed by …" row** under the description is gone: the decision row says who closed it and when.

Unchanged and outside this board's scope:

- The project header's "Project" label beside the crumb and a Pipelines tab (the fixture's deploy.yaml has a pipeline).
- The checks row when not all have passed reads "3 checks passed" with a clock, as before.
- ⋯ shows the design system's pressed background while its menu is open; the board draws it plain.
