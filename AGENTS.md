# deploy.local

Instructions for any agent working in this repository: web app, Mac desktop app, iPhone app, CLI and docs. The desktop app on Mac, Windows and Linux is Electron in `desktop/`; `native/Apple` contains the Swift iPhone app and its Mac-runnable package tests. Folder-specific notes live beside the code (for example [app/AGENTS.md](app/AGENTS.md)). react-flight-router, the router the web app is built on, lives in its own repository (react-flight-router on deploy.local) and is installed here from deploy.local's package registry: change it there, release a new version, then update the version in `package.json`.

## Visual changes: change the design first, get it approved, then build it

Any change people will see — layout, copy on screen, controls, states, window chrome, on web, desktop or iPhone — is drawn before it is built, and the owner approves it before the work moves forward.

The design lives in this repository, in `design/` (see `design/README.md`): `canvas.json` and one HTML board per screen, built from the design system in `design/ds/`. deploy.local shows it on its Design page, where designs are reviewed and approved. The claude.ai canvas it was imported from is an older mirror, not the source.

From a terminal, five commands do the steps (run them in the project's folder; `deploy design --help` lists them). An agent in a deploy.local task does the same with its `deploy_design` tool.

1. **Start from main.** `deploy design start "<title>"` fetches main, makes `design/<title>` from it in its own folder beside this one, and tells deploy.local who is working there. Edit the screen's board in `design/boards/` (and `canvas.json` for a new board, its place or its notes) with the design system and real copy. Keep every `data-layer` ID. Commit as you go. To look at the current design, render it from main with `node design/tools/render.mjs --main`, never from whatever is checked out.
2. **Check it and look at it.** `deploy design check` names new elements, draws each changed board beside main at its widths (web 1440 and 700, phone at its own) in light and dark into `output/design/pairs`, and lists problems: cut off at 700, a lost layer ID, a board missing from the canvas or the reverse, a link to no board. Fix every problem and look at every pair. Send the owner the before-and-after pairs in the conversation.
3. **Ask for approval.** `deploy design propose` checks again, pushes the branch and asks; it waits in Waiting on you. Nothing about the change is built, merged, pushed or released until the owner approves it.
4. **Hear back.** `deploy design feedback --wait` waits for the answer and prints the owner's note and every pin, numbered. When a pin is done, `deploy design resolve <n> "<what you did>"`, then propose again. Nobody waiting on the branch means the notes wait in the review until the owner starts a task for them.
5. **On approval, the design is on main.** Approving puts the branch's design files on main, so `design/` always shows the product as it should be; deploy.local removes the branch when it held only design files, and `feedback` removes your folder and local branch. Then start implementation.
6. **Build exactly what was approved.** If the build has to differ from the board (wording, a state the board missed, a platform constraint), stop and get approval for the difference the same way, and change the board so it matches what ships.
7. **Verify against the board.** Before calling it done, compare the real app with the approved board at the same widths (`design/tools/capture.mjs` and `pair.py`, see `design/README.md`) and report any gap.

Fixes that leave what people see unchanged (a crash, a wrong value) do not need a sketch. When in doubt, sketch.

Work delegated to subagents or other sessions follows the same rule. They change boards on a branch and report back; the owner approves in deploy.local or in the main conversation.

## Shipping

- Push only to deploy.local's own `origin`, never to GitHub.
- SER releases follow `deploy-update prepare` and then `activate`. CLI downloads live in `cli/` in the server's data directory, which outlives releases; the server serves whichever of that and the release's own `dist/cli` was built later. When the CLI changes, run `pnpm build:cli` at the released commit and swap the files into `cli/` there (copy to a sibling folder, then rename). Never copy into a release folder before activation: it changes the verified build.
- The Mac desktop app download works the same way from `desktop/` in the data directory: when the desktop app changes, run `pnpm build:desktop-download` on a Mac at the released commit and swap `dist/desktop` (the zip and `build-info.json`) into `desktop/` there.

## Clean up what was merged

When a branch is merged and accepted, remove its worktree, its local branch and its branch on `origin` as part of finishing the work. Whoever merged it does this, including an orchestrator merging delegated work.

- **Accepted means** the branch's commits are on `origin/main` (`git merge-base --is-ancestor <branch> origin/main`) or, for a design branch, the owner approved it in deploy.local. Approval copies files to main instead of merging, so git alone does not show a design branch as merged.
- **Remove in this order:** the worktree (`git worktree remove <path>`), the local branch (`git branch -d <branch>`), then the remote one (`git push origin --delete <branch>`). `-d` can refuse a branch whose own upstream is behind; once the ancestor check passes, `-D` is fine.
- **Keep** `main`, any branch whose review is still waiting on the owner (`deploy inbox` lists them), and any branch something is still working in.
- **Stop and tell the owner instead of forcing** when a worktree has uncommitted work, a lock held by a process that is still running, or a branch has commits that are not accepted.
