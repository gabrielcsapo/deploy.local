# Application design system

For UI work, use the in-app reference at `/dashboard/design-system` and the contract in `../docs/design-system.md`.

- Use `@/components/ui` for shared controls and feedback. Extend a shared component when a new reusable variant is needed, and add a live specimen in `routes/dashboard/design-system.client.tsx`.
- `design-tokens.json` owns palette, metric signals, typography, spacing, motion and composition rules. Run `node scripts/build-design-tokens.mjs` from the repository root after token changes; never hand-edit `design-tokens.css`.
- Use semantic Tailwind utilities from `theme.css` for composition. Keep raw colors and per-page control styling out of new views.
- The activity rail owns global navigation; the second sidebar owns context and local sections. Resource lists, tables and viewers fill the right pane. Avoid repeated headings and descriptions.
- Use `TextField appearance="plain"` inside existing toolbars or rows; use bordered fields in standalone forms. Preserve labels and visible keyboard focus.
- Metric colors identify measurements, not health. Show labels, units, missing values and recovery actions honestly.
- Verify changed flows in the browser at desktop and compact widths, including keyboard focus, scrolling and recovery. Run `pnpm typecheck` and `pnpm build`.

- Use shared motion tokens and `app/motion.css` for interaction feedback and overlay entry. Respect reduced motion globally, including portals. Keep routes, streamed text, resource rows, sidebar resizing and scroll restoration steady.
