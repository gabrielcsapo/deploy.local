# Changing a project's default branch: parity

Boards: `ProjectSettings` (the Default branch row) and `ProjectDefaultBranch` (the dialog), approved on main in 1478d6b9. Each `parity-<Board>-<width>.png` has the board on the left and the built app on the right.

Captured from the production build run as `DEPLOY_ROLE=control node dist/server.js` on 127.0.0.1:5193 with a throwaway data folder. A hosted `home-gym` project got `main`, `release/2.0` and `develop` pushed over HTTPS. `capture.mjs` opens Settings, opens Change, picks develop, and at 700 px presses Use develop: the row then reads `develop`, and the bare repository's HEAD is `refs/heads/develop`.

Differences from the boards:

- The fixture has no remote, so the dialog's note ends "main stays as it is." With a remote it adds "and the remote keeps its own default branch", naming GitHub, GitLab, Bitbucket or Codeberg when the address is one of theirs.
- All three branches were pushed seconds apart, so each says "last commit just now".
- The page around the row is this fixture's (no variables, no apps), not the board's home-gym cast.
- States the board does not draw: while branches load the list shows a skeleton; if they fail to load, a "Branches are unavailable" banner with Retry; the Use button is disabled until a different branch is picked; Change is hidden when the default branch is unknown.
