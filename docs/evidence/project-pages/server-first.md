# Server-first project pages: implementation report

The changes are left in the working tree. No git writes, design edits, native/desktop edits or long-running servers were used.

## Identity and scope

`getRequest()` supplies each project server component's request. `projectPageOwner` reads only the HttpOnly cookie and validates the stored session; explicit API headers cannot select a server-render identity. Missing, malformed, expired or revoked cookies produce no seed and preserve the original browser-fetch path. Server request deduplication uses a `WeakMap<Request, ...>`, never a shared URL-keyed data cache. HTML is private/no-store. Browser resource caches reset on account changes, seed providers reject invalidated/other-owner seeds, and speculative router responses are discarded across identity changes, including late in-flight responses.

`server/auth-cookie.ts` centralizes the existing cookie format. All cookies use HttpOnly, SameSite=Lax, Path=/ and Secure on HTTPS (TLS socket or forwarded HTTPS). These sign-in paths now use the same request-aware builder:

- Password login and registration in `server/api/auth.ts`.
- Initial owner setup and passkey verification in `server/v2/auth.ts`.
- Approved CLI polling and paired-device token exchange in `server/v2/auth.ts`.
- Existing trusted sessions and tokens supplied by the desktop bridge use the validated adoption path. Certificate trust itself does not mint a session.

`POST /api/v2/auth/session` validates the explicit username/token headers before adopting them into a cookie. The browser calls it once per token, including on local-storage identity changes; successful authenticated API calls also repair a missing/mismatched cookie. Existing users do not need to sign in again. JSON response shapes of existing endpoints are unchanged. `DELETE /api/v2/auth/session` clears the cookie even for an expired session; logout and device-session revocation clear it too. A session revoked elsewhere is rejected immediately and its cookie expires on the next API/document/RSC request.

No admin-only node response is seeded. The coordinator's display name is provided separately; sensitive node configuration is not serialized.

## Route data

`server/v2/project-page.ts` calls the same in-process functions as the JSON APIs. Project membership/repository reads opt into existing presentation views. There are no self-HTTP requests. Live discovery membership now uses indexed lookups for this owner's apps instead of scanning the catalog installation table. Shared overview, workspace-state and live-app projections were extracted without changing API response shapes.

| Route                                       | Initial server data                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard/projects`                       | Owner's projects, live summary, workspace state, waiting/answered inbox                                                                  |
| Project layout / overview                   | Above plus project overview (repository, tasks, issues, pulls, apps), release history, open pull list and unlinked-app choices           |
| Issues / Apps                               | Existing project overview/membership data                                                                                                |
| Single-app overview and nested app overview | Live-app health, history and release details, plus shared live/inbox data; both `useData` and the separate `useLive` consumer are seeded |
| Code                                        | Repository metadata, selected tree/blob, README and requested history; preparing-repository errors are seeded too                        |
| Pull list                                   | Open list and first five merged pulls                                                                                                    |
| Pull detail                                 | Pull record and diff                                                                                                                     |
| Pipelines                                   | Run list and initially selected run's details                                                                                            |
| Releases / release detail                   | Project/release data and rollback history                                                                                                |
| Settings / nested app settings              | Project settings, repository settings, app health/runtime data                                                                           |
| Requests / request detail                   | Summary/list with URL filters or selected request details, including header breadcrumb data                                              |
| Performance                                 | Selected app's owner-checked telemetry range                                                                                             |
| Logs                                        | Source URLs; live byte streams stay in the browser                                                                                       |

Release output streams and log bytes remain browser-driven. Task-row snapshot/diff enrichment stays in the browser because it can read transcripts/checkpoint data; task titles/statuses already come in the overview/workspace seed. Sidebar user, agents, package-service and admin node resources retain their existing browser requests. Pages outside projects receive no seed and keep browser loading.

## Seeding, hydration and live updates

`DataSeeds` supplies path-keyed values/errors with the owner, timestamp, event cursor, origin and server timezone. `useData`, `useResource`, `remembered`, inbox initialization, app-health `useLive`, releases and logs consume those values on the first render. A fresh seed (10 seconds) skips the initial request. `useResource` retains its polling; live health retains its 15-second interval; event subscriptions, reconnect snapshots and explicit retry continue refreshing. A first event snapshot whose cursor advanced beyond the server seed forces a refresh, avoiding a lost update between render and subscription.

SSR never writes the browser resource cache. Cache timestamps favor a newer browser answer over an older prefetched seed. Account changes clear caches and event subscriptions. Time, day labels, chart coordinates, request clocks and browser-origin links use server values through hydration and then resume browser formatting. Inert `data-project-seed` markers expose only seeded paths/timestamps to the proof runner, not credentials or private payloads.

Tab-specific server reads sit under the existing project content Suspense boundary. Authenticated project fallbacks do not insert skeleton markup. The persistent project header and tabs stay mounted.

## Navigation and prefetch

The router eagerly installed Suspense sentinels and committed async navigation updates outside a transition. The narrow package change adds opt-in `retainContent` to navigation/Link, skips those sentinels and commits the destination with `startTransition`. Existing navigation behavior is the default for other routes. A package test covers both the fetch wait and a still-suspending streamed destination, with the old page and pending link preserved.

Project tabs use the existing router `Link` pending state and `prefetch="intent"`. Plain project-row anchors prefetch after an 80 ms hover or immediately on focus; delegated project navigations use `retainContent`. Nothing prefetches on render. The exported prefetch-cache reset prevents an old identity's in-flight response from repopulating the cache.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm lint:design`, `pnpm build`: passed; lint retains existing repository warnings.
- Client project/live/tasks/releases/sidebar/shared UI and neighboring tests: 148 passing after the added seeded-health regression.
- Server identity/auth-cookie/API/fixture/materialized-view tests: 79 passing; one existing HTTP auth-routing test cannot bind `127.0.0.1:5180` in this sandbox (`EPERM`).
- Full router build/Vitest suite: 311 passing; seven existing node-listener tests fail only because loopback listeners are prohibited (`EPERM`). Compiled worker/action tests were run separately despite that suite failure: 24 passing, two loopback-listener tests blocked by the same restriction.
- Production build exercised through the real router's in-process `fetch` interface: 24 project URLs return HTTP 200 with no skeleton markup or streamed render error, including nested app health/settings/requests/performance, pull/release detail and preparing repositories. This does not listen on a port or run a server process.
- Unit coverage includes seeded initial request suppression plus event/reconnect refresh, browser cache identity isolation, SSR owner isolation despite conflicting headers, and missing/malformed/expired/revoked cookie fallback.

The pinned pnpm 11.1.3 cannot be downloaded in this sandbox. Checks used installed pnpm 11.25.0 with a command-local `--pm-on-fail=ignore` override (and a temporary PATH wrapper for nested calls). No package-manager configuration was changed.

## Browser proof and remaining limitations

Run the build/seed/server instructions in [README.md](README.md), then:

```sh
node docs/evidence/project-pages/server-first.mjs \
  http://127.0.0.1:5188 /tmp/project-pages-seed.json \
  output/project-pages/server-first
```

The Playwright script and seed cookie instructions are delivered, but browser hydration, first-complete-paint counts, screenshots and delayed-navigation behavior have not been run here. The orchestrator must run this proof; a server-response check cannot substitute for it.

**The strict cold-navigation requirement remains incomplete.** Existing repository views launch Git when cold/expired (the ref cadence is two seconds); workspace capabilities can probe CLI binaries; live health collection can wait for HTTP checks. The shared page loader currently awaits these existing readers before rendering the header. Consequently this implementation does not guarantee zero child processes on a cold navigation or immediate header streaming when those shared reads are slow. These are genuine unmet requirements, not merely unverified benchmarks. Tab reads have their own boundary, but that alone does not solve cold shared-reader latency. No new background warmup service or alternate Git implementation was introduced to conceal that limitation.

Real worker health, populated telemetry, active releases and event-driven browser refresh still need the live proof in addition to unit tests. The fixture deliberately uses stopped apps without Docker/workers.

## Files changed

- `app/auth.ts`
- `app/components/ui/v2/Tabs.tsx`
- `app/components/ui/v2/tabs.test.mjs`
- `app/root.tsx`
- `app/routes/dashboard/detail/shared.tsx`
- `app/routes/dashboard/v2-layout.client.tsx`
- `app/routes/dashboard/v2/data/adopt-session.ts`
- `app/routes/dashboard/v2/data/event-feed.ts`
- `app/routes/dashboard/v2/data/hooks.test.mjs`
- `app/routes/dashboard/v2/data/hooks.tsx`
- `app/routes/dashboard/v2/data/inbox-store.ts`
- `app/routes/dashboard/v2/data/links.ts`
- `app/routes/dashboard/v2/data/seeds.tsx`
- `app/routes/dashboard/v2/data/time.ts`
- `app/routes/dashboard/v2/live/data.test.mjs`
- `app/routes/dashboard/v2/live/data.ts`
- `app/routes/dashboard/v2/live/page.client.tsx`
- `app/routes/dashboard/v2/live/presentation.ts`
- `app/routes/dashboard/v2/projects/code-preparing.test.mjs`
- `app/routes/dashboard/v2/projects/code.client.tsx`
- `app/routes/dashboard/v2/projects/content.client.tsx`
- `app/routes/dashboard/v2/projects/data.test.mjs`
- `app/routes/dashboard/v2/projects/data.ts`
- `app/routes/dashboard/v2/projects/formatting.ts`
- `app/routes/dashboard/v2/projects/layout.tsx`
- `app/routes/dashboard/v2/projects/logs.client.tsx`
- `app/routes/dashboard/v2/projects/page.client.tsx`
- `app/routes/dashboard/v2/projects/page.tsx`
- `app/routes/dashboard/v2/projects/performance.client.tsx`
- `app/routes/dashboard/v2/projects/pipelines.client.tsx`
- `app/routes/dashboard/v2/projects/repository-settings.client.tsx`
- `app/routes/dashboard/v2/projects/requests.client.tsx`
- `app/routes/dashboard/v2/projects/requests.ts`
- `app/routes/dashboard/v2/projects/routes.ts`
- `app/routes/dashboard/v2/projects/settings.client.tsx`
- `app/routes/dashboard/v2/projects/tab.tsx`
- `app/routes/dashboard/v2/releases/page.client.tsx`
- `app/routes/dashboard/v2/releases/page.tsx`
- `app/routes/dashboard/v2/releases/routes.ts`
- `app/routes/dashboard/v2/start/layout.tsx`
- `app/routes/dashboard/v2/tasks/pull.client.tsx`
- `app/routes/dashboard/v2/tasks/pulls.client.tsx`
- `app/routes/dashboard/v2/tasks/pulls.tsx`
- `app/routes/root.client.tsx`
- `docs/evidence/project-pages/README.md`
- `docs/evidence/project-pages/seed.mts`
- `docs/evidence/project-pages/server-first.md`
- `docs/evidence/project-pages/server-first.mjs`
- `packages/react-flight-router/src/client/index.ts`
- `packages/react-flight-router/src/client/link.tsx`
- `packages/react-flight-router/src/client/prefetch-cache.test.ts`
- `packages/react-flight-router/src/client/prefetch-cache.ts`
- `packages/react-flight-router/src/client/router-context.test.tsx`
- `packages/react-flight-router/src/client/router-context.tsx`
- `scripts/component-harness.mjs`
- `server.ts`
- `server/api/auth.ts`
- `server/api/shared.ts`
- `server/auth-cookie.ts`
- `server/v2/auth-cookie.test.ts`
- `server/v2/auth.ts`
- `server/v2/live.ts`
- `server/v2/project-page.test.ts`
- `server/v2/project-page.ts`
- `server/v2/settings.ts`
- `server/v2/test-request.ts`
- `server/workspace/api.ts`
- `server/workspace/read-state.ts`
- `vite.config.ts`
