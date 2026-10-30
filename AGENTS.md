# deploy.local

Instructions for any agent working in this repository: web app, Mac desktop app, iPhone app, CLI and docs. Folder-specific notes live beside the code (for example `app/AGENTS.md`).

## Visual changes: sketch on the canvas, show before and after, get sign-off

Any change people will see — layout, copy on screen, controls, states, window chrome, on web, desktop or iPhone — is drawn before it is built, and the owner signs off before the work moves forward.

1. **Sketch it on the canvas first.** The product canvas is the "deploy.local Agents" Design artifact (https://claude.ai/artifact/3mS7t8tGJgTKdo1bnAanTr), built on the deploy.local Design System (https://claude.ai/artifact/5Sv6UWeiDvpgnenyfDurkZ). Revise the board that covers the screen, or add one beside it in the right section, using the installed design system and real copy.
2. **Show before and after.** Put the current screen (the existing board, or a screenshot of the live app) next to the proposed one, labelled Before and After, with a short note listing each change and anything left as a proposal. Desktop boards reflow; check them at about 700 px and 1440 px, phone boards at 390 px.
3. **Get explicit sign-off.** Ask the owner to approve the boards as drawn. Do not build, merge, push or release the visual change until they say yes. Comments or a "change X" mean revise the boards and ask again.
4. **Build exactly what was approved.** If the build has to differ from the boards (wording, a state the boards missed, a platform constraint), stop and get sign-off on the difference before shipping it. Then update the boards so they match what ships.
5. **Verify against the boards.** Before calling it done, compare the real app with the approved boards at the same widths and report any gap.

Fixes that leave what people see unchanged (a crash, a wrong value) do not need a sketch. When in doubt, sketch.

Work delegated to subagents or other sessions follows the same rule. They draw boards and report back; the owner is asked for sign-off in the main conversation.

## Shipping

- Push only to deploy.local's own `origin`, never to GitHub.
- SER releases follow `deploy-update prepare` and then `activate`. Copy the CLI downloads (`dist/cli`) into the release after activation, never before.
