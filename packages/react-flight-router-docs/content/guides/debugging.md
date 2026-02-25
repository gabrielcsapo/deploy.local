---
title: "Debugging & Performance"
description: "How to enable performance logging in React Flight Router to diagnose slow requests, module loading, and rendering bottlenecks."
---

# Debugging & Performance

React Flight Router includes opt-in performance logging that shows timing breakdowns for every server request. This helps you identify bottlenecks in module loading, component rendering, RSC serialization, and SSR.

## Enabling Debug Logging

Set the `FLIGHT_DEBUG` environment variable:

```bash
FLIGHT_DEBUG=1 node dist/server.js
```

Or pass `debug: true` programmatically:

```ts
// Production server
const app = await createServer({ buildDir: "./dist", debug: true });

// Vite dev plugin
flightRouter({ debug: true });
```

When disabled (the default), all timing callsites are skipped via optional chaining — there is zero overhead.

## Log Output

Each request type produces a color-coded headline with a timing breakdown:

- **SSR** (green) — Initial page loads rendered to HTML
- **RSC** (cyan) — Client-side navigation fetching RSC payloads
- **ACTION** (magenta) — Server action execution

Dynamic route parameters are automatically masked with `****` to avoid exposing PII in logs.

### SSR Request

<!-- SSR_OUTPUT_START -->

```
[flight] SSR /about  4.0ms
    matchRoutes                    21µs
    buildSegmentMap                703µs
      load root                    72µs
      load about                   567µs
    rsc:serialize                  87µs
    rsc:buffer                     119µs
    ssr:deserializeRSC             927µs
    ssr:renderToHTML               1.6ms
```

<!-- SSR_OUTPUT_END -->

### RSC Navigation

<!-- RSC_OUTPUT_START -->

```
[flight] RSC /about  3.7ms
    matchRoutes                    32µs
    buildSegmentMap                140µs
      load about                   93µs
    rsc:serialize                  65µs
```

<!-- RSC_OUTPUT_END -->

### RSC Navigation (Dynamic Route)

When navigating to a dynamic route like `/posts/:id`, the param value is masked:

<!-- RSC_PARAM_OUTPUT_START -->

```
[flight] RSC /posts/****  177.1ms
    matchRoutes                    86µs
    buildSegmentMap                1.4ms
      load post-detail             1.3ms
    rsc:serialize                  38µs
```

<!-- RSC_PARAM_OUTPUT_END -->

### Server Action

<!-- ACTION_OUTPUT_START -->

```
[flight] ACTION addMessage  5.4ms
    action:decodeArgs              4.4ms
    action:loadModule(app/routes/actions)  29µs
    action:execute(addMessage)     27µs
    action:serialize               55µs
```

<!-- ACTION_OUTPUT_END -->

## What Each Timing Means

| Label                | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `matchRoutes`        | Route matching against the URL pathname                       |
| `buildSegmentMap`    | Loading and rendering all matched route components            |
| `load <id>`          | Importing a specific route module                             |
| `rsc:serialize`      | Serializing the React tree to RSC Flight format               |
| `rsc:buffer`         | Buffering the RSC stream for SSR (initial page loads only)    |
| `ssr:deserializeRSC` | Deserializing the RSC stream back into React elements for SSR |
| `ssr:renderToHTML`   | Rendering the React tree to HTML via react-dom/server         |
| `action:decodeArgs`  | Decoding the action's arguments from the request body         |
| `action:loadModule`  | Importing the server action module                            |
| `action:execute`     | Running the server action function                            |
| `action:serialize`   | Serializing the action's return value as RSC                  |

## Slow Operations

Operations taking longer than 100ms are highlighted in yellow in the terminal output. Common causes of slow operations:

- **Slow `load <id>`**: Module has heavy top-level side effects or large dependency trees. Consider lazy loading or code splitting.
- **Slow `buildSegmentMap`**: Many route segments being rendered. Check if segment diffing is working (partial updates should only render changed segments).
- **Slow `ssr:renderToHTML`**: Components doing heavy computation during render. Consider moving data fetching to server actions or caching.
- **Slow `action:execute`**: The server action itself is slow (database queries, external API calls, etc.).
