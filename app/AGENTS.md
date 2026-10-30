# Application design system

Any visible change is sketched on the product canvas, shown as before and after, and signed off by the owner before it is built (see `../AGENTS.md`). For the code itself, use the in-app reference at `/dashboard/design-system` and the contract in `../docs/design-system.md`.

- Use `@/components/ui` for shared controls and feedback; the dashboard's components and `dl-*` styles live in `components/ui/v2/`. Extend a shared component when a new reusable variant is needed, and add a live specimen in `routes/dashboard/design-system.client.tsx`.
- `design-tokens.json` owns palette, metric signals, typography, spacing, motion and composition rules. Run `node scripts/build-design-tokens.mjs` from the repository root after token changes; never hand-edit `design-tokens.css`.
- Use semantic Tailwind utilities from `theme.css` for composition. Keep raw colors and per-page control styling out of new views.
- One sidebar owns navigation, agents, Waiting on you and recent tasks; each page has one header (`Head`) and its content. Below 820 px the sidebar hides, so every page's header carries the menu button that opens it. Avoid repeated headings and descriptions.
- Never hardcode the coordinator's name ("SER"); use `useCoordinatorName()`.
- In the Mac app there is no title bar: the desktop app sets `deploy-desktop-mac` (and `deploy-desktop-fullscreen`) on the page, and `routes/dashboard/v2-shell.css` keeps room for the traffic lights and the drag regions. New top rows that should drag the window need the same treatment.
- Bordered fields in standalone forms; plain entry inside already bounded toolbars or rows. Preserve labels and visible keyboard focus.
- Metric colors identify measurements, not health. Show labels, units, missing values and recovery actions honestly.
- Verify changed flows against the approved boards at desktop and compact widths, including keyboard focus, scrolling and recovery. Run `pnpm typecheck`, `pnpm lint:design` and `pnpm build`.

- Use shared motion tokens and `app/motion.css` for interaction feedback and overlay entry. Respect reduced motion globally, including portals. Keep routes, streamed text, resource rows, sidebar resizing and scroll restoration steady.
