# react-flight-router

A general React Server Components routing library built on Vite, with SSR, server actions and client navigation.

No application- or host-specific logic or names. The router is a general library: integrations (telemetry endpoints, hosting platforms, a particular app's needs) come in through documented options or neutral RFR_* environment variables, and the application or host supplies the values. Never hard-code a product's names, paths, environment variables or behaviour in the router.

Run `pnpm --filter react-flight-router test` for the build, unit tests and compiled worker tests. Run browser tests from this directory with `pnpm exec playwright test --config e2e/playwright.config.ts` (build first). The local telemetry fixture uses temporary files and ports 5304–5307.

Publishing happens through deploy.local's pipeline when the package version changes on main.
