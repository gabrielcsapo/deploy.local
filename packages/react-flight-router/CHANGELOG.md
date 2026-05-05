# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0](https://github.com/gabrielcsapo/flight-router/compare/v0.5.0...v0.6.0) (2026-05-05)

### Features

- adds the parallel routes ([bb68f41](https://github.com/gabrielcsapo/flight-router/commit/bb68f41768022836a14025555787f7de70ad9729))

## [0.5.0](https://github.com/gabrielcsapo/flight-router/compare/v0.4.4...v0.5.0) (2026-05-04)

### Features

- **server:** renderTimeoutMs option for SSR + main-thread actions ([a80ef71](https://github.com/gabrielcsapo/flight-router/commit/a80ef71f58d5c637d80160e02b6f6fa99b844bbf))

### Bug Fixes

- **docs:** changelog generator to handle scoped commits ([c88056e](https://github.com/gabrielcsapo/flight-router/commit/c88056e0252e82f80d4b1f2c6ac16b7f58a512ed))
- **server:** evict failed SSR module imports so the next request retries ([1ef9140](https://github.com/gabrielcsapo/flight-router/commit/1ef9140acec6a4548bdf50c7d5f49170b8a00036))
- fixes ci tests ([8531097](https://github.com/gabrielcsapo/flight-router/commit/8531097c1540f5e23c3ad3b4349559b6838bb851))

### Chores

- fixes lint violations ([5f0b06e](https://github.com/gabrielcsapo/flight-router/commit/5f0b06ebf2b67a8cacfd7650b328c62115178b62))
- updates dependencies to latest ([c78c3c1](https://github.com/gabrielcsapo/flight-router/commit/c78c3c14119fc52c77feffe817c1c65161beb95d))

### Performance

- **client:** apply fastPathname to useLocation, share helper across hooks ([1f7f59d](https://github.com/gabrielcsapo/flight-router/commit/1f7f59deba58eb31697c104bd2a83ea7bdfe268a))
- **client:** precompute parentKey → childKey map for Outlet lookup ([b955656](https://github.com/gabrielcsapo/flight-router/commit/b9556561e85674418c376ecb97e9ce0bdb7b8976))
- **client:** fast-path pathname extraction in Link instead of new URL() ([7ff04e3](https://github.com/gabrielcsapo/flight-router/commit/7ff04e3fba79d355d272e87f77f4ff8f2384731a))
- **server:** stream SSR with full module map (eliminate buffer step) ([9a8cd46](https://github.com/gabrielcsapo/flight-router/commit/9a8cd46bc92137ab6e95bd27474466f24e4da3fd))
- **server:** detach socket close listener after response finishes ([f990820](https://github.com/gabrielcsapo/flight-router/commit/f99082092d51310f5b19a93ce737ebaecb704a61))
- **client:** split RouterContext into actions/location/segments - Pre-split, every router state change replaced the entire context value, re-rendering every component that used useRouter() — including <Link>s in stable layouts that didn't actually depend on the changed slice. - Split into three contexts so consumers subscribe only to what they need: - NavigationActions: navigate, refresh (rarely change) - Location: url, pendingUrl, state (URL transitions) - Segments: segments, params, … (per-render) - Internal components (Link, Outlet, useSearchParams, ScrollRestoration) use narrow hooks. useRouter() still returns the merged value for backward compatibility. ([6468526](https://github.com/gabrielcsapo/flight-router/commit/6468526dc173a96d6a8d133a2d475284bb323b77))
- **dev:** swap manifest Proxy linear-scan for cached Map lookup - react-server-dom-webpack hits the dev client/server-actions manifests once per client component reference per RSC render. The previous implementation iterated the underlying module Set on every property access, calling getModuleId() each time — O(M) per lookup, O(M·R) per render. - Hoist the manifests to plugin instantiation time and back them with Map<moduleId, entry> lookups that lazily rebuild only when the module Set grows. Module Sets are insertion-only in dev (transformed modules are added, never removed), so size equality is a sufficient cache key. ([5a2cb8e](https://github.com/gabrielcsapo/flight-router/commit/5a2cb8ec16484a22802c3fe892c1ed1abc336592))
- **server:** load route boundaries parallel to segment map - buildBoundaryComponents and buildSegmentMap depend only on and were running sequentially. Kick off the boundary load first so it overlaps with segment-map build, then await it afterward. - Adds a buildBoundaryComponents timing entry that now measures wait duration (typically 0 ms). - Bench (cold-start RSC, 50 iters, route with loading + error boundaries): total mean 10.66 → 10.55 ms (-1%) total p99 13.90 → 11.30 ms (-19%) ([9d71e95](https://github.com/gabrielcsapo/flight-router/commit/9d71e9567044c81e60196acbc0e20ce2dcb4696d))
- cache static assets in-memory, async-read on miss Bench (autocannon, 100 conns, 10s): 24K → 36K RPS (+50%), p99 7ms → 5ms. ([cc7e220](https://github.com/gabrielcsapo/flight-router/commit/cc7e220f687e6644fb7cfef7e75a94c35159086f))

## [0.4.4](https://github.com/gabrielcsapo/flight-router/compare/v0.4.3...v0.4.4) (2026-04-03)

### Features

- adds mimeType option for createServer and adds more default mimeTypes ([0e73cf4](https://github.com/gabrielcsapo/flight-router/commit/0e73cf45abaf424bcfa8d319e6b334394633fcea))

### Chores

- update dev dependencies to latest ([29f2ae6](https://github.com/gabrielcsapo/flight-router/commit/29f2ae6541839cb2d7514b8b7bceb4c2530ca8f3))

## [0.4.3](https://github.com/gabrielcsapo/flight-router/compare/v0.4.2...v0.4.3) (2026-04-02)

### Features

- adds support for passing server actions as props to client components ([fc452f1](https://github.com/gabrielcsapo/flight-router/commit/fc452f138df1790e82bd7338ec09920cc3f5f48f))

## [0.4.2](https://github.com/gabrielcsapo/flight-router/compare/v0.4.1...v0.4.2) (2026-03-24)

### Features

- adds refresh in client router ([bdf1ab2](https://github.com/gabrielcsapo/flight-router/commit/bdf1ab2cf82b4ca20cf571c757e3962b485f8ef0))

## [0.4.1](https://github.com/gabrielcsapo/flight-router/compare/v0.4.0...v0.4.1) (2026-03-23)

### Features

- adds the ability to redirect in the server context ([78703fe](https://github.com/gabrielcsapo/flight-router/commit/78703fe12ade226a878b0cee207c43ae784c9917))

### Chores

- upgrade to vite@8 ([064587e](https://github.com/gabrielcsapo/flight-router/commit/064587e3809722260725f3d77c7ca994824c0bd0))

## [0.4.0](https://github.com/gabrielcsapo/flight-router/compare/v0.3.5...v0.4.0) (2026-03-09)

### Features

- prefetch links (#11) ([40f00d8](https://github.com/gabrielcsapo/flight-router/commit/40f00d895e9d354f8ec0234f50ae01c5ba1a3cae))
- support error and loading transitions on the client ([53dbd56](https://github.com/gabrielcsapo/flight-router/commit/53dbd566dfa0a4d8b743c342673dd6ce20f6d61a))

### Bug Fixes

- ensure full waterfall in CLI perf output ([64b1388](https://github.com/gabrielcsapo/flight-router/commit/64b13887398ecf1a6ad772e2e0b573ad0fd6165b))

### Performance

- add response compression and memoize router context (#10) ([389c3fa](https://github.com/gabrielcsapo/flight-router/commit/389c3fa6b941b8ac7d2dcbbfd25f464c771ba1ab))
- performance optimizations and vitest migration - Add .catch() handler to initial RSC stream deserialization to show fallback UI instead of blank page on failure - Enable minify: true for RSC, SSR, and server entry builds to reduce server bundle size by 10-20% - Parallelize boundary module loading in buildBoundaryComponents across all matches and within each match - Memoize useSearchParams URL parsing with useMemo to prevent new object references on every render - Cache SuspenseSentinel element as a module-level constant to avoid createElement calls on every navigation - Migrate test runner from node:test to Vitest for route-matcher, segment-diff, scroll-restoration, and build-config tests - Add new test coverage for build config minification settings and parallel boundary module loading ([99f5cdc](https://github.com/gabrielcsapo/flight-router/commit/99f5cdcbfef7d45c9d46859a29f1363f422a6de8))

### Other

- chore(docs): arrange information architecture - fixes mdx links ([ee0857e](https://github.com/gabrielcsapo/flight-router/commit/ee0857e19274fd93c2b262a46047f37d087b0a07))

## [0.3.5](https://github.com/gabrielcsapo/flight-router/compare/v0.3.4...v0.3.5) (2026-03-04)

### Features

- improve route mtach performance — navigate callback identity is now stable across navigations, preventing unnecessary re-renders of consumers - useLocation return in useMemo — avoids creating a new URL object and result object on every render - Converted onlySegments to a Set<string> for O(1) lookups instead of O(n) Array.includes() in buildSegmentMap and key merging - Parallelized module loading with Promise.all — all route components load concurrently, results are processed sequentially to preserve error handler semantics ([98b3e21](https://github.com/gabrielcsapo/flight-router/commit/98b3e2196983b5cd8c5877674e6dd0c5c2b81746))

## [0.3.4](https://github.com/gabrielcsapo/flight-router/compare/v0.3.3...v0.3.4) (2026-03-04)

### Bug Fixes

- ensure packages being required also go through client manifest generation ([949ef64](https://github.com/gabrielcsapo/flight-router/commit/949ef64426de307ac900daf0e8b3b8742bdaef51))

## [0.3.3](https://github.com/gabrielcsapo/flight-router/compare/v0.3.2...v0.3.3) (2026-03-03)

### Bug Fixes

- ensure we pass define forwarding to all parts of the build process ([cfc8712](https://github.com/gabrielcsapo/flight-router/commit/cfc871268a438835596ef95e59478e9e3085ee25))

### Chores

- updates deps to latest ([4483736](https://github.com/gabrielcsapo/flight-router/commit/4483736b51d22dd7da8c5c38884d295749ed6c65))

### Other

- chore(docs): update worker thread with example ([8121d3c](https://github.com/gabrielcsapo/flight-router/commit/8121d3cde5996ff1959c58c517d8858df89ba136))

## [0.3.2](https://github.com/gabrielcsapo/flight-router/compare/v0.3.1...v0.3.2) (2026-03-01)

### Features

- adds the ability to build actions to workers - adds framework way to get getRequest in server context ([c834a11](https://github.com/gabrielcsapo/flight-router/commit/c834a112d8880bc396c21a785bbfa4f510681773))

### Bug Fixes

- fixes edge case for abort to be caused 'enqueueModel is not a function' ([433b4ef](https://github.com/gabrielcsapo/flight-router/commit/433b4efde5a780a350e8020bedeb0350441c9cda))

## [0.3.1](https://github.com/gabrielcsapo/flight-router/compare/v0.3.0...v0.3.1) (2026-02-28)

### Features

- handles aborts mid route navigation for actions and route navigation ([95a1a57](https://github.com/gabrielcsapo/flight-router/commit/95a1a57d379536b631ed93d3189c515d438a9a92))

## [0.3.0](https://github.com/gabrielcsapo/flight-router/compare/v0.2.3...v0.3.0) (2026-02-26)

### Features

- add perf hooks in dev and prod ([9aab73e](https://github.com/gabrielcsapo/flight-router/commit/9aab73e1d729db7de0ca74a78a0cfefb027173c7))

## [0.2.3](https://github.com/gabrielcsapo/flight-router/compare/v0.2.2...v0.2.3) (2026-02-26)

### Bug Fixes

- improve scroll restoration to retry on fully rendered pages ([e207d1c](https://github.com/gabrielcsapo/flight-router/commit/e207d1c34f56866954f92a82925a685e288d9cf1))

## [0.2.2](https://github.com/gabrielcsapo/flight-router/compare/v0.2.1...v0.2.2) (2026-02-26)

### Features

- adds suspense support ([1bc6113](https://github.com/gabrielcsapo/flight-router/commit/1bc61136e029f3994ff4920a3041ef0c496d994e))

## [0.2.1](https://github.com/gabrielcsapo/flight-router/compare/v0.2.0...v0.2.1) (2026-02-26)

### Features

- handles request context to handle cookies, headers and auth ([de4b748](https://github.com/gabrielcsapo/flight-router/commit/de4b7489f01340a98bf1e329cee60d153c01f619))

## [0.2.0](https://github.com/gabrielcsapo/flight-router/compare/v0.1.6...v0.2.0) (2026-02-25)

### Features

- adds debug flag - enables runtime logging to identify slow downs - accounts for PII leakage ([11e07a1](https://github.com/gabrielcsapo/flight-router/commit/11e07a107c3a2a6699d6ae0cc721a9805f1d2bd5))

## [0.1.6](https://github.com/gabrielcsapo/flight-router/compare/v0.1.5...v0.1.6) (2026-02-25)

### Bug Fixes

- fix manifest collisions - adds build time check to validate routes are server components - adds tabs example to ensure manifest collisions are working (making sure files that share the same prefix) - fixes bug when linking react-flight-router where the resolve dependencies should come from the app root ([f00c944](https://github.com/gabrielcsapo/flight-router/commit/f00c9442bde3b4866f5845daa8a015a4f4760de9))
- fix param passing to child components in client side navigation and in SSR ([9c648db](https://github.com/gabrielcsapo/flight-router/commit/9c648db2e385a90018e7931193cf221b4675321f))

## [0.1.5](https://github.com/gabrielcsapo/flight-router/compare/v0.1.4...v0.1.5) (2026-02-25)

### Bug Fixes

- nested app/app when resolving client module in production ([20947a7](https://github.com/gabrielcsapo/flight-router/commit/20947a78f581260529993af8f3a1ed1609f9c11d))

## [0.1.4](https://github.com/gabrielcsapo/flight-router/compare/v0.1.3...v0.1.4) (2026-02-25)

### Bug Fixes

- fixes getModuleId in deployed environment ([bf338c5](https://github.com/gabrielcsapo/flight-router/commit/bf338c58de43eb03fa0453ae225cd0cf2ee8a92d))

## [0.1.3](https://github.com/gabrielcsapo/flight-router/compare/v0.1.2...v0.1.3) (2026-02-25)

### Bug Fixes

- do not externalize react-flight-router ([a4caa85](https://github.com/gabrielcsapo/flight-router/commit/a4caa85544ebd2fc5415763b2e0c7a739d0d671f))

## [0.1.2](https://github.com/gabrielcsapo/flight-router/compare/v0.1.1...v0.1.2) (2026-02-25)

### Features

- adds error route boundaries - fixes issue with not being able to support vite plugins in ssr build - adds more tests to validate fixes ([140528d](https://github.com/gabrielcsapo/flight-router/commit/140528d94c07aa880eeb3074dfe930ff16818b28))

## [0.1.1](https://github.com/gabrielcsapo/flight-router/compare/v0.1.0...v0.1.1) (2026-02-25)

### Bug Fixes

- fixes type exports using typesVersions ([4e43a84](https://github.com/gabrielcsapo/flight-router/commit/4e43a84444c78a4d7e66bb13e40fa8d1094a8e4f))

## [0.1.0](https://github.com/gabrielcsapo/flight-router/releases/tag/v0.1.0) (2026-02-25)

### Features

- adds new functionality - updates the doc site and adds better search - adds 404 pages - adds useSearchParams - adds functionality to links for active and pending state ([d053f90](https://github.com/gabrielcsapo/flight-router/commit/d053f907aca7510e10b17b111997eb9bfd5eb35b))
- adds route based breakdown - adds stress testing of route diffing ([ac6bed5](https://github.com/gabrielcsapo/flight-router/commit/ac6bed5d541a350e22cbd089855d0aa49ae857c7))
- docs site ([1a8a801](https://github.com/gabrielcsapo/flight-router/commit/1a8a80127a93ce9d443edfc7d15f000994fe43d8))
- ssr support in dev - adds e2e tests for dev ([6b04a81](https://github.com/gabrielcsapo/flight-router/commit/6b04a8114816c20c2f7999829df3d3c2dd949424))
- more use cases, readme ([e39935d](https://github.com/gabrielcsapo/flight-router/commit/e39935db419fe7a8f9d3acd95a566b352b733a09))
- dynamic module resolution instead of all client components loading at the start ([0a0134a](https://github.com/gabrielcsapo/flight-router/commit/0a0134a9ff7721ff499fec68b4c97ce69ad51e43))
- adds ssr support ([4f73616](https://github.com/gabrielcsapo/flight-router/commit/4f73616c36329ce5b36921f67f9aa53e436ee587))
- basic dev and server build usage ([f253a31](https://github.com/gabrielcsapo/flight-router/commit/f253a31a04807e64c71f7cf6cd1fd9666092d230))

### Bug Fixes

- fix release script not formatting files ([339b6b5](https://github.com/gabrielcsapo/flight-router/commit/339b6b539256a48d007e0f8cf8920bc1d0793edd))
- adds note example and fixes a deriveModuleId bug - adds tests - updates docs ([cabd67f](https://github.com/gabrielcsapo/flight-router/commit/cabd67f7288b419aa774e685b6428edc97b123e5))

### Chores

- fix e2e flow where bin is not linked after build ([b814f20](https://github.com/gabrielcsapo/flight-router/commit/b814f20fc6c0beb5d6952ecbd812979b778c8fc0))
- bump deps to latest ([04a6037](https://github.com/gabrielcsapo/flight-router/commit/04a603762b5f8f10a2d002f5b5e11b234ddb890b))
- moves names - consolidates readme ([8cb1e67](https://github.com/gabrielcsapo/flight-router/commit/8cb1e673e29d43166148e8db2ec04f7f383f4de2))
- rename test to example ([73a30d0](https://github.com/gabrielcsapo/flight-router/commit/73a30d0c2965923e886063c0da06ea68a8a9a89f))
- adds oxlint and oxfmt ([27d5f98](https://github.com/gabrielcsapo/flight-router/commit/27d5f9887510400a4e6d3d7d7c8580d521475549))
