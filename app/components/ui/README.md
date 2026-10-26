# Shared application UI

Live reference: `/dashboard/design-system` (Settings → Design system, or command palette).

Import from `@/components/ui`. Native button/input props pass through to the underlying element, including refs. Use `Button` variants `primary`, `secondary` (default), `quiet` or `danger`; it defaults to `type="button"`. Use `TextField` with a required `label`, optional associated `error`, and `appearance="plain"` for entry inside already bounded rows. Use `SearchField` for list-page search: its accessible label, search icon, subtle field boundary and 36 px height are shared across lists. `Metric` requires a signal and visible label; pass a value including units or an explicit unavailable state.

The entry point also exports the existing application feedback, confirmation dialog and toggle components. Extend these components and add a live specimen instead of introducing a competing control implementation.

Tokens live in `app/design-tokens.json`; generated variables in `app/design-tokens.css`; Tailwind utilities in `app/theme.css`; shared primitive styles in `ui.css`. See `docs/design-system.md` for the full contract and maintenance steps.

`StatCard` is available from the same UI entry point for analytics summaries. Pass `signal` to use the metric palette; latency percentile lines use solid p50, dashed p95 and dotted p99 patterns rather than health colors.

Use `Select` for labeled dropdowns; it accepts native select props and children. The trigger and customizable popup use shared tokens, with an accessible native picker fallback. The workspace sidebar divider shares the documented sizing tokens and persists the chosen width.

Motion values come from the same token contract. Shared controls and dialogs use `app/motion.css`; use `ds-motion-enter` or `motion-safe:animate-surface-enter` for a newly revealed surface. See the live Motion section for duration, easing, reduced-motion behavior and React/Tailwind recipes.

Use `IconButton icon="close" label="Close panel"` for utility actions, `CopyButton label="Copy command" text={command}` for clipboard feedback and selectable fallback, and `ActionCluster` to align related actions with close last. Sizes are compact/default/touch; toggles pass `pressed`. See Actions and iconography in the design contract and the live Actions specimen.
