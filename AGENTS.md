# deploy.local

Instructions for any agent working in this repository: web app, Mac desktop app, iPhone app, CLI and docs. The desktop app on Mac, Windows and Linux is Electron in `desktop/`; `native/Apple` contains the Swift iPhone app and its Mac-runnable package tests. Folder-specific notes live beside the code (for example [app/AGENTS.md](app/AGENTS.md)). react-flight-router, the router the web app is built on, lives in its own repository (react-flight-router on deploy.local) and is installed here from deploy.local's package registry: change it there, release a new version, then update the version in `package.json`.

## Visual changes: draw them on the branch with the code

Anything people will see — layout, copy on screen, controls, states, window chrome, on web, desktop or iPhone — is drawn as a board in `design/` on the same branch as the code that builds it. The branch is the design: merging it is the approval, and conflicts are resolved on rebase like any file. The design lives in `design/` (see `design/README.md`): `canvas.json` and one HTML board per screen, built from the design system in `design/ds/`. deploy.local shows any branch on its Design page.

1. **Learn the project once.** `deploy design guide` prints the platforms and sizes, the type and spacing scale, the components, the fixture names and the check codes.
2. **Start from what is right.** `deploy design status <Board>` names the current board of the screen (never one that was replaced), its source on the other platform, the components to use, open questions, and other branches changing the same board. Start from that board and its components, never a blank page or an older copy.
3. **Draw it with the code.** Read the app's code for the screen first and draw what it does, in its words. Edit the board in `design/boards/` with the design system's components and tokens and real copy from the fixtures. Keep every `data-layer` ID and give new layers names that say what they are. A new board's meta says its platform and, for a board drawn from another platform, `source=<Board>.html`. `design/README.md` lists the mistakes agents make most; read it before you draw.
4. **Never invent what the product doesn't decide.** When the code or the owner hasn't said (how long something is kept, a screen that doesn't exist yet), mark the layer with `data-question="…"` instead of making up a value. The owner answers it with a comment.
5. **Check it like a test.** `deploy design check --fix` draws each changed board beside main at its widths in light and dark into `output/design/pairs`, fixes what has one answer, and lists problems and notes. Fix every problem, read every note, then work through the review sheet it prints: open every pair, dark included, and answer its questions. If you can, have a second agent review the pairs too. A problem blocks the merge.
6. **Rebase, check again, merge.** A branch merges only when it is up to date with main and its check is clean.
7. **The board must match the app.** Before calling it done, compare the real app with the board at the same widths (`design/tools/capture.mjs` and `pair.py`, see `design/README.md`) and fix the board or the app so they agree.

Fixes that leave what people see unchanged (a crash, a wrong value) need no board. Work delegated to subagents or other sessions follows the same steps.

## Shipping

- Push only to deploy.local's own `origin`, never to GitHub.
- SER releases follow `deploy-update prepare` and then `activate`. CLI downloads live in `cli/` in the server's data directory, which outlives releases; the server serves whichever of that and the release's own `dist/cli` was built later. When the CLI changes, run `pnpm build:cli` at the released commit and swap the files into `cli/` there (copy to a sibling folder, then rename). Never copy into a release folder before activation: it changes the verified build.
- The Mac desktop app download works the same way from `desktop/` in the data directory: when the desktop app changes, run `pnpm build:desktop-download` on a Mac at the released commit and swap `dist/desktop` (the zip and `build-info.json`) into `desktop/` there.

## Clean up what was merged

When a branch is merged and accepted, remove its worktree, its local branch and its branch on `origin` as part of finishing the work. Whoever merged it does this, including an orchestrator merging delegated work.

- **Accepted means** the branch's commits are on `origin/main` (`git merge-base --is-ancestor <branch> origin/main`).
- **Remove in this order:** the worktree (`git worktree remove <path>`), the local branch (`git branch -d <branch>`), then the remote one (`git push origin --delete <branch>`). `-d` can refuse a branch whose own upstream is behind; once the ancestor check passes, `-D` is fine.
- **Keep** `main`, any branch whose review is still waiting on the owner (`deploy inbox` lists them), and any branch something is still working in.
- **Stop and tell the owner instead of forcing** when a worktree has uncommitted work, a lock held by a process that is still running, or a branch has commits that are not accepted.
