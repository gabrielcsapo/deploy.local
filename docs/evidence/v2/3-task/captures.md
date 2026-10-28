# Post-fix captures pending

Chromium cannot launch in this sandbox (`bootstrap_check_in … Permission denied (1100)`).
The existing pairs and raw captures are **pre-fix**. See `notes.md` for startup commands and
`capture-error.log` for the post-fix attempt. Run `node docs/evidence/v2/3-task/capture-all.mjs`
on a permitted host to capture and pair all rows below.

Each URL uses origin `http://127.0.0.1:5187`. Every row needs **1440×900 and 700×900**, light
mode, fresh browser state. Output prefix is `docs/evidence/v2/3-task/captures/<Board>`.

| Board        | Exact URL                                                     |
| ------------ | ------------------------------------------------------------- |
| Task         | http://127.0.0.1:5187/dashboard/tasks/Task                    |
| TaskChanges  | http://127.0.0.1:5187/dashboard/tasks/TaskChanges/changes     |
| TaskChecks   | http://127.0.0.1:5187/dashboard/tasks/TaskChecks/checks       |
| Review       | http://127.0.0.1:5187/dashboard/tasks/Review                  |
| PullRequests | http://127.0.0.1:5187/dashboard/projects/deploy%2Elocal/pulls |
| FirstTask    | http://127.0.0.1:5187/dashboard/tasks/FirstTask               |
| TaskStalled  | http://127.0.0.1:5187/dashboard/tasks/TaskStalled             |
| TaskFailed   | http://127.0.0.1:5187/dashboard/tasks/TaskFailed              |
| NewProduct   | http://127.0.0.1:5187/dashboard/tasks/NewProduct              |
| LongChat     | http://127.0.0.1:5187/dashboard/tasks/LongChat                |
| ShipDialog   | http://127.0.0.1:5187/dashboard/tasks/ShipDialog#ship         |

Inspect all pairs after recapture. For ShipDialog, also verify centered bounding box and dimmed
backdrop at both widths, contained keyboard focus, Escape/backdrop dismissal, trigger focus
restoration and vertical scrolling in a short viewport. Check the screenshot gallery keeps two
portrait captures and one landscape capture on one scrollable row; check output selection,
⋯ Refresh/Open project, panel close, PR search and first-task dismissal.
