# Hosted projects and remote sync: parity

Boards: NewProject, NewProjectHosted, ProjectEmpty and ProjectSettings (approved in `design/project-without-repo`), plus AddRemote and RepositorySync (proposed in `design/project-sync-states`).

Captured from `fixture-server.mjs` (port 5184) behind `scripts/dev-ui.mjs` with `DEPLOY_DEV_API_ORIGIN=http://127.0.0.1:5184`. Each `<Board>-<width>.png` is the board on the left and the app on the right; `captures/` holds the app alone, including the states on the proposed boards.

| Board            | App                                                                       | Widths    |
| ---------------- | ------------------------------------------------------------------------- | --------- |
| NewProjectHosted | `/dashboard/projects`, New project, name only                             | 1440, 700 |
| NewProject       | New project with a remote (`captures/NewProject-remote-*`)                | 1440, 700 |
| ProjectEmpty     | `/dashboard/projects/recipes`                                             | 1440, 700 |
| ProjectSettings  | `/dashboard/projects/home-gym/settings`                                   | 1440, 700 |
| AddRemote        | `/dashboard/projects/recipes/settings`, Add remote                        | 1440, 700 |
| RepositorySync   | `pantry` (paused), `recipes` (no remote), `bazzite` (fetch only) settings | 1440, 700 |

## Differences

- **Fixture data, not the build:** the coordinator reads "the coordinator" because the fixture has no computer name (the app says SER there). The clone address shows the dev host, `127.0.0.1:5185`. The composer shows "Any free computer" and the default model instead of SER and Opus, and recipes shows the fixture's variables.
- **Already different before this change, left as they were:**
  - Project pages use the wide page column, so content is wider than the boards' 960 px column.
  - With a remote, New project inspects on an Inspect repository button rather than on its own, and has no "A task opens the first pull request" switch. Runs on and Address are read-only.
  - The Deploy file row always reads deploy.yaml, even before the file exists.
- **Changed on the proposed boards to match the build:**
  - The paused banner uses the app's warning icon (cloud).
  - Its action is "Open a pull request", which opens a pull request from the remote's main. Merging it makes the merge commit sync needs.
