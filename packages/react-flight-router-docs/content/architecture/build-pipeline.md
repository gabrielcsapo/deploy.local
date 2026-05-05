---
title: "Build Pipeline"
description: "Detailed breakdown of React Flight Router's 5-phase production build process, covering RSC bundling, client code-splitting, SSR builds, manifest generation, and server bundling."
---

# Build Pipeline

React Flight Router uses a 5-phase production build pipeline powered by Vite and Rollup. Each phase produces artifacts that the next phase depends on, resulting in a fully optimized production bundle.

Run the build with:

```bash
npx react-flight-router build
```

The build produces a detailed summary showing per-route sizes, shared framework chunks, and phase timings:

<!-- BUILD_OUTPUT_START -->

```
react-flight-router v0.5.0

  Build

  ✓ Phase 1  RSC server          114ms
  ✓ Phase 2  Client + SSR (parallel)    133ms
  ✓ Phase 3  Manifests             2ms
  ✓ Phase 4  Server entry          9ms

  Routes                                     Server    First Load JS

  ○ /                                             1.70 kB     219.81 kB
  ┌ ○ /                                             650 B     222.16 kB
  ├ ○ /about                                      1.30 kB     224.56 kB
  ├ ○ /broken                                       214 B     219.81 kB
  ├ ○ /dashboard                                    565 B     219.81 kB
  │ ├ ○ /dashboard/                                 453 B     219.81 kB
  │ └ ○ /dashboard/settings                         623 B     222.16 kB
  ├ ○ /posts                                        429 B     219.81 kB
  │ ├ ○ /posts/                                     984 B     219.81 kB
  │ └ λ /posts/:id                                1.48 kB     221.58 kB
  ├ λ /users/:id                                    831 B     219.81 kB
  │ ├ λ /users/:id/                                 894 B     219.81 kB
  │ └ λ /users/:id/posts                            831 B     219.81 kB
  ├ ○ /slow                                       2.03 kB     219.81 kB
  ├ ○ /suspense                                     453 B     219.81 kB
  │ └ ○ /suspense/                                5.63 kB     219.81 kB
  ├ ○ /tabs                                         791 B     219.81 kB
  │ ├ ○ /tabs/                                      774 B     219.81 kB
  │ ├ ○ /tabs/settings                              750 B     219.81 kB
  │ └ ○ /tabs/activity                             1023 B     219.81 kB
  ├ ○ /loading-with-component                       645 B     219.81 kB
  │ ├ ○ /loading-with-component/                  1.34 kB     219.81 kB
  │ └ ○ /loading-with-component/slow-child          801 B     219.81 kB
  ├ ○ /error-with-component                         625 B     219.81 kB
  │ ├ ○ /error-with-component/                    1.35 kB     219.81 kB
  │ └ ○ /error-with-component/client-error          311 B     219.91 kB
  ├ ○ /perf                                         742 B     225.70 kB
  ├ ○ /login                                        431 B     222.94 kB
  ├ ○ /register                                     435 B     223.41 kB
  ├ ○ /profile                                    1.57 kB     219.81 kB
  ├ ○ /shared-ui                                    530 B     219.81 kB
  └ ○ /explore                                      199 B     219.81 kB
    ├ ○ /explore/                                 1.68 kB     219.81 kB
    └ λ /explore/:universe                          199 B     219.81 kB
      └ λ /explore/:universe/:galaxy                199 B     219.81 kB
        └ λ /explore/:universe/:galaxy/:system      199 B     219.81 kB
          └ λ /explore/:universe/:galaxy/:s...      199 B     219.81 kB
            └ λ /explore/:universe/:galaxy/...      199 B     219.81 kB
              └ λ /explore/:universe/:galax...      199 B     219.81 kB
                └ λ /explore/:universe/:gal...      199 B     219.81 kB
                  └ λ /explore/:universe/:g...      199 B     219.81 kB
                    └ λ /explore/:universe/...      199 B     219.81 kB
                      └ λ /explore/:univers...      200 B     219.81 kB
                        └ λ /explore/:unive...      200 B     219.81 kB
                          └ λ /explore/:uni...      200 B     219.81 kB
                            └ λ /explore/:u...    1.84 kB     219.81 kB

  + First Load JS shared by all           219.81 kB
    ├ assets/client-D2qH1L1P.js                  174.74 kB
    ├ assets/client.browser-By49HwU0.js           23.56 kB
    ├ assets/react-D6R3Vvvr.js                     7.34 kB
    └ other shared chunks (framework)            14.16 kB

  ○ static   λ dynamic

  Modules: 23 client, 2 server actions, 2 css


  Output                                       Size       Gzip

  server       129 js                223.86 kB
  ssr          25 js                  32.01 kB
  client       37 js, 2 css          268.17 kB    98.40 kB
  manifests    5 json                 26.32 kB
  ───────────────────────────────────────────────────────
  total        198 files             550.36 kB

  ✓ Done in 394ms
```

<!-- BUILD_OUTPUT_END -->

## Overview

```
Phase 1        Phase 2        Phase 3        Phase 4         Phase 5
RSC Build  →  Client Build →  SSR Build  →  Manifests    →  Server Build
(server        (browser        (Node.js       (maps IDs       (bundles
 components)    chunks)         rendering)     to files)        server.ts)
```

## Phase 1: RSC Build

**Purpose**: Bundle server components with the `react-server` condition.

This phase uses Rollup to bundle all route modules and the RSC runtime into server-side JavaScript. The key aspects of this phase:

- **`react-server` condition**: React's server variant is used, which provides `React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE` required by `react-server-dom-webpack/server`. This variant of React excludes client-only APIs like `useState`.
- **`'use client'` processing**: When the bundler encounters a `'use client'` directive, it replaces the module contents with client component references (proxies) instead of the actual component code. These references contain a module ID and export name that the client can resolve later.
- **RSC runtime bundling**: Because the `react-server` condition cannot be used globally (SSR needs `useState`, etc.), React and `react-server-dom-webpack/server` are bundled directly into `rsc-runtime.js` with the server variant resolved via custom Rollup plugins.

**Output**: `dist/server/rsc-entry.js`, `dist/server/rsc-runtime.js`

## Phase 2: Client Build

**Purpose**: Bundle client components, the client entry point, and CSS for the browser.

This phase produces the JavaScript and CSS that runs in the user's browser:

- **Client components**: Every module marked with `'use client'` is bundled as a separate entry point, enabling per-route code-splitting. Chunks are loaded on demand when a route is navigated to.
- **Client entry**: The main entry point that bootstraps the RSC client, sets up the router, and handles hydration.
- **CSS entries**: Server components can import CSS files (e.g., Tailwind), but those imports do not produce client CSS on their own. The build orchestrator scans for `.css` imports in server components and adds them as explicit client build entries.
- **App plugins**: The orchestrator loads the application's `vite.config.ts` to extract user plugins (such as `@tailwindcss/vite`), filtering out framework-internal plugins, and applies them to this phase.

**Output**: `dist/client/index.html`, `dist/client/assets/*.js`, `dist/client/assets/*.css`

## Phase 3: SSR Build

**Purpose**: Bundle client components for server-side rendering in Node.js.

The same client components from Phase 2 are bundled again, but this time targeting Node.js instead of the browser. During SSR, the server needs to render client components to HTML -- this requires the actual component code (not the proxies from Phase 1).

The SSR build produces Node.js-compatible modules that can be imported by the SSR renderer via `__webpack_require__` shims.

**Output**: `dist/server/ssr/*.js`

## Phase 4: Manifest Generation

**Purpose**: Create mapping files that connect module IDs to their physical locations.

Three manifests are generated:

### RSC Client Manifest

Maps module IDs to client chunk URLs. When the RSC renderer encounters a client component reference, it uses this manifest to tell the browser which JavaScript file to load.

```json
{
  "app/routes/counter.js": {
    "id": "app/routes/counter.js",
    "chunks": ["assets/counter-Bx1k2f.js"],
    "name": "default"
  }
}
```

### SSR Manifest

Maps module IDs to SSR bundle paths. During server-side rendering, the SSR deserializer uses this manifest to resolve client component references to the Node.js bundles from Phase 3.

```json
{
  "app/routes/counter.js": {
    "id": "./ssr/app/routes/counter.js",
    "chunks": [],
    "name": "default"
  }
}
```

### Server Actions Manifest

Maps action IDs to their server module paths. When the client invokes a server action, the server uses this manifest to locate and execute the correct function.

**Output**: `dist/manifests/client-manifest.json`, `dist/manifests/ssr-manifest.json`, `dist/manifests/server-actions-manifest.json`

A `build-meta.json` file is also generated with metadata about the build, such as CSS file paths for SSR injection.

## Phase 5: Server Build

**Purpose**: Bundle the production server entry point.

The final phase bundles `server.ts` into a single `dist/server.js` file that can be deployed and run with Node.js. This server handles:

- Serving static assets from `dist/client/`
- RSC rendering for both initial page loads and client-side navigation
- Server-side rendering (SSR) for initial page loads
- Server action execution

**Output**: `dist/server.js`

## Build Output Structure

The complete build output is organized as follows:

```
dist/
├── server.js                    # Production server entry (Phase 5)
├── server/
│   ├── rsc-entry.js             # RSC route bundle (Phase 1)
│   ├── rsc-runtime.js           # Bundled React server runtime (Phase 1)
│   └── ssr/                     # SSR client component bundles (Phase 3)
│       └── app/
│           └── routes/
│               ├── counter.js
│               └── ...
├── client/
│   ├── index.html               # HTML shell (Phase 2)
│   └── assets/                  # Browser JS and CSS chunks (Phase 2)
│       ├── entry-client-D4f2a.js
│       ├── counter-Bx1k2f.js
│       ├── styles-a1B2c3.css
│       └── ...
└── manifests/                   # Module ID mappings (Phase 4)
    ├── client-manifest.json
    ├── ssr-manifest.json
    ├── server-actions-manifest.json
    └── build-meta.json
```

## Key Design Decisions

### Why bundle React into the RSC runtime?

The `react-server` condition provides server-only internals that `react-server-dom-webpack/server` requires. However, applying `--conditions=react-server` globally would break SSR, which needs client APIs like `useState`. Bundling the server variant of React directly into `rsc-runtime.js` isolates this concern.

### Why three separate builds for components?

A single component may need to exist in three forms:

1. **RSC build**: As a proxy/reference (for `'use client'` modules) or as actual server code (for server components)
2. **Client build**: As browser-optimized JavaScript with code-splitting
3. **SSR build**: As Node.js-compatible JavaScript for server HTML rendering

### Why scan for CSS imports separately?

CSS imported by server components is processed during the RSC build but does not automatically produce client-side CSS files. The orchestrator explicitly adds these CSS files as client build entries to ensure they appear in the final output.

## See also

- [How It Works](./how-it-works.md) — high-level architecture and request flow
- [Segment Diffing](./segment-diffing.md) — how navigation minimizes re-rendering
- [Vite Configuration](../getting-started/vite-config.md) — plugin setup that drives the build
