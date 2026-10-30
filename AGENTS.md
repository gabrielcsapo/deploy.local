# deploy.local

Instructions for any agent working in this repository: web app, Mac desktop app, iPhone app, CLI and docs. Folder-specific notes live beside the code (for example `app/AGENTS.md`).

## Visual changes: sketch on the canvas, show before and after, get sign-off

Any change people will see — layout, copy on screen, controls, states, window chrome, on web, desktop or iPhone — is drawn before it is built, and the owner signs off before the work moves forward.

1. **Sketch it on the canvas first.** The product canvas is the "deploy.local Agents" Design artifact (https://claude.ai/artifact/3mS7t8tGJgTKdo1bnAanTr), built on the deploy.local Design System (https://claude.ai/artifact/5Sv6UWeiDvpgnenyfDurkZ). Draw the proposal with the installed design system and real copy, in the section that covers the screen.
2. **Show before and after, on the canvas and as a screenshot.** On the canvas, put a Before board (a copy of the current board, or the live app as it is today) beside an After board, labelled, with a short note listing each change and anything left as a proposal. Also render both and send the owner one before-and-after screenshot in the conversation, so they can judge it without opening the canvas. Desktop boards reflow; check them at about 700 px and 1440 px, phone boards at 390 px.
3. **Get explicit sign-off.** Ask the owner to approve the After as drawn. Nothing about the change is built, merged, pushed or released until they say yes. Comments or a "change X" mean revise the After, send a new screenshot and ask again.
4. **On approval, the After becomes the design.** Replace the screen's current board with the After, so the canvas always shows the product as it should be, and remove the Before and After pair and its note. Then start implementation.
5. **Build exactly what was approved.** If the build has to differ from the board (wording, a state the board missed, a platform constraint), stop and get sign-off on the difference the same way, and update the board so it matches what ships.
6. **Verify against the board.** Before calling it done, compare the real app with the approved board at the same widths and report any gap.

Fixes that leave what people see unchanged (a crash, a wrong value) do not need a sketch. When in doubt, sketch.

Work delegated to subagents or other sessions follows the same rule. They draw boards and report back; the owner is asked for sign-off in the main conversation.

## Shipping

- Push only to deploy.local's own `origin`, never to GitHub.
- SER releases follow `deploy-update prepare` and then `activate`. Copy the CLI downloads (`dist/cli`) into the release after activation, never before.
