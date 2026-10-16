# Live design-system reference

Added `/dashboard/design-system`, linked from Settings and the command palette. The reference imports the actual JSON tokens and shared React primitives; Tailwind semantic utilities resolve to the same variables. Future application UI guidance is in `app/AGENTS.md` and `docs/design-system.md`.

Browser verification used the isolated application preview on 127.0.0.1:5189, backed by disposable fixture data. These screenshots are previews, not evidence of live SER activation.

Verified:

- Settings → Design system navigation; correct Settings rail selection, contextual sections and breadcrumb.
- Command palette search “design system” and Enter selection.
- Section anchors stay below the sticky location bar, including compact drawer navigation.
- Bordered field validation associates error text without changing its accessible label.
- Plain component search filters examples; computer/application filters use the same shared TextField.
- Toggle state changes; native disabled button semantics.
- Shared confirmation dialog keyboard focus, Escape dismissal and return to the opening button.
- Empty, loading and error specimens; Retry returns to empty without network or product mutations.
- React/Tailwind recipe selection and copying semantic metric classes to the clipboard.
- Desktop 1280 × 720; compact 390 × 844 has 390 px document width and 44 px input height. Table/code overflow remains local to its container.
- Typecheck, scoped formatting/lint and production build pass.

SER activation is recorded separately. No live data, worker configuration or database ownership was modified.
