# Empty project push commands over HTTPS or SSH: parity

Board: `ProjectEmpty`, approved on main in fad74018. `parity-ProjectEmpty-<width>.png` has the board on the left and the built app on the right; `ProjectEmptyCode-1440.png` is the same section on the Code tab.

Captured from the production build run as `DEPLOY_ROLE=control node dist/server.js` on 127.0.0.1:5193 with Git SSH on 2223 and a throwaway data folder, using an empty hosted `recipes` project and the SSH tab chosen. The SSH choice is shared with the Clone menu and survives a reload.

Differences from the board:

- The address uses this fixture's host and port (`127.0.0.1:2223`) instead of `deploy.local:2222`.
- "Already running it? Add an app you shipped" appears only where adding an app is offered, as before; this fixture doesn't offer it.
