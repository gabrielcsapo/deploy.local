# Comfortable spacing and shared motion

Live release: `90cfc2fe6a965ebe70b29007bb0b2a6ec9af5013`, branch `codex/design-system-ser`.

A separate design agent audited spacing and motion, then reviewed the implementation. Its findings led to fixes for legacy button transition specificity, native Create project dialog coverage, compact settings insets and stale density documentation.

The system now uses 24 px desktop / 16 px compact inner insets, 40 px desktop navigation, resource rows with a 56 px minimum, 13 px resource text, quieter separators and 32 px form-section spacing. Actual repository rows measure 57 px because their button and cell padding remain accessible rather than being clipped. Source, diffs and log lines retain their dense reading rhythm. The shared page's decorative square grid is removed. The composer has an inset surface with rounded corners.

Motion is encoded in `app/design-tokens.json`, generated into CSS, mapped to Tailwind and applied through `app/motion.css`: 120 ms feedback, 180 ms state transitions, 220 ms overlay entry and 240 ms compact drawers. Duration, easing, travel and scale have named roles. Shared buttons, switches, select popups, dialogs, popovers and disclosures consume the contract. React dialogs close immediately on unmount; the 140 ms exit role is available for surfaces that remain mounted. Routes, streamed text, table geometry and sidebar resizing do not animate.

The in-app reference at `/dashboard/design-system#design-motion` includes replay, reduced-motion preview, a disclosure and the actual shared confirmation dialog, plus React/Tailwind recipes. Browser-computed values confirmed the 220 ms reveal and dialog, 240 ms drawer, disabled reveal under the scoped reduced-motion preview, focus inside the dialog and restoration to its trigger after Escape. The root reduced-motion rule covers portal content, backdrops and native select pickers; the OS preference itself was left unchanged.

Verified the actual SER repository, application table, computer disclosure, provider settings, conversation and design reference. Checked desktop 1280×800 and compact 390×844 layouts, local pane scrolling, sidebar keyboard resizing and compact drawer navigation. `repository-before.png` and `repository-after.png` show the same live verification branch before and after. Other screenshots show the deployed application.

Local typecheck, build, scoped lint and formatting passed. Clean SER preparation passed typecheck, production build and 580 tests: **566 passed, 14 skipped, zero failed**. Activation used `deploy-update` without sudo after confirming zero active deployments, queued deployments or coding runs. Unrelated dirty work was preserved; scoped validation was used because the repository-wide hook already reports unrelated formatting issues.
