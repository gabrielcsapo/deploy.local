# Shared application UI

Live reference: `/dashboard/design-system` (Settings → Design system, or command palette).

Import from `@/components/ui`. Native button/input props pass through to the underlying element, including refs. Use `Button` variants `primary`, `secondary` (default), `quiet` or `danger`; it defaults to `type="button"`. Use `TextField` with a required `label`, optional associated `error`, and `appearance="plain"` for toolbar/row inputs. `Metric` requires a signal and visible label; pass a value including units or an explicit unavailable state.

The entry point also exports the existing application feedback, confirmation dialog and toggle components. Extend these components and add a live specimen instead of introducing a competing control implementation.

Tokens live in `app/design-tokens.json`; generated variables in `app/design-tokens.css`; Tailwind utilities in `app/theme.css`; shared primitive styles in `ui.css`. See `docs/design-system.md` for the full contract and maintenance steps.
