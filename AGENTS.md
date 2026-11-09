# deploy.local

Instructions for any agent working in this repository: web app, Mac desktop app, iPhone app, CLI and docs. The desktop app on Mac, Windows and Linux is Electron in `desktop/`; `native/Apple` contains the Swift iPhone app and its Mac-runnable package tests. Folder-specific notes live beside the code (for example [app/AGENTS.md](app/AGENTS.md) and [packages/react-flight-router/AGENTS.md](packages/react-flight-router/AGENTS.md)).

## Visual changes: change the design first, get it approved, then build it

Any change people will see — layout, copy on screen, controls, states, window chrome, on web, desktop or iPhone — is drawn before it is built, and the owner approves it before the work moves forward.

The design lives in this repository, in `design/` (see `design/README.md`): `canvas.json` and one HTML board per screen, built from the design system in `design/ds/`. deploy.local shows it on its Design page, where designs are reviewed and approved. The claude.ai canvas it was imported from is an older mirror, not the source.

1. **Change the design on a design branch.** Edit the screen's board in `design/boards/` (and `canvas.json` for a new board, its place or its notes) with the design system and real copy. Keep every `data-layer` ID; after adding elements, run `node scripts/design-layers.mjs` on the boards you changed. Agents working in a deploy.local task report where they work with `deploy_design` (presence) and commit as they go.
2. **Render it and show before and after.** Render each changed board with `node design/tools/render.mjs <Board>`: web boards at 1440 and 700 px, phone boards at 390. Look at every width. Send the owner one before-and-after screenshot in the conversation; in deploy.local the task's Design tab and its chat card show Before (main) and After (the branch) side by side.
3. **Get explicit approval.** Propose the design for review: Propose on the Design page, or `deploy_design` with action `propose` from a task. It waits in Waiting on you. Nothing about the change is built, merged, pushed or released until the owner approves it. Asking for changes means revise the boards and propose again.
4. **On approval, the design is on main.** Approving puts the branch's design files on main, so `design/` always shows the product as it should be. Then start implementation.
5. **Build exactly what was approved.** If the build has to differ from the board (wording, a state the board missed, a platform constraint), stop and get approval for the difference the same way, and change the board so it matches what ships.
6. **Verify against the board.** Before calling it done, compare the real app with the approved board at the same widths (`design/tools/capture.mjs` and `pair.py`, see `design/README.md`) and report any gap.

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
