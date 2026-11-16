# Clone URLs, Download ZIP and SSH keys: parity

Boards: `CodeClone`, `Project`, `Settings` (SSH keys section) and `SshKeyAdd`, approved on main in fd696518. Each `<Board>-<width>.png` has the board on the left and the built app on the right, at 1440 and 700.

## How these were captured

The production build (`react-flight-router build` and `scripts/build-server-extras.mjs`) ran as `DEPLOY_ROLE=control node dist/server.js` on 127.0.0.1:5193, with a throwaway `DEPLOY_DATA_DIR`, `DEPLOY_MDNS_ADDRESS=127.0.0.1` and Git SSH on 2223, plus `server/workspace/repository-worker.ts`. A test account and a hosted `forma` project were created through the API. A commit was pushed over HTTPS and the repository was cloned over SSH with a throwaway key, so "Used … ago" is real. `capture.mjs` signs in with that account's cookie, sets the clone tab to SSH and opens each state.

Checked by hand in the same build:

- `git clone ssh://git@127.0.0.1:2223/forma.git`, the address the SSH tab shows, clones.
- Download ZIP returns `forma-main.zip` with a `forma-main/` folder, using the browser's sign-in cookie.
- Add key in the dialog adds a key, takes its name from the key's comment (`gabriel@bazzite` → `bazzite`) and shows it as Never used.

## Differences from the boards

- Settings: the SSH keys section is on the Account and SSH keys page, below the password form, as before. The board draws it on the General page under Account. Its placement is unchanged by this work.
- The capture uses this fixture's data (one project, one or two keys, the 127.0.0.1 host), not the boards' cast.
- States the boards do not draw, built with the words below:
  - No keys: a row "No SSH keys yet · Add this computer's key to clone and push over SSH."
  - SSH off on the server: no SSH tab in the Clone menu or on the Overview, and on Settings a row "SSH is off on this server · Clone over HTTPS for now. Whoever runs this server can turn SSH on with DEPLOY_SSH_PORT."
- The Clone menu starts on HTTPS and remembers the last tab in this browser. The boards show the SSH tab.
- Download ZIP is `git archive`: files tracked with Git LFS come out as their pointer files.
