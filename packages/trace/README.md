# Request spans

Every proxied app response carries an edge-generated `x-request-id`. The edge forwards that ID to the app, and forwards a version 00 W3C `traceparent` for each upstream attempt. The response also carries the edge's trace context. In browser DevTools, the response timing lists `edge-headers` and any `route-publication` or `retry-backoff` wait in milliseconds. A retry keeps the HTTP request ID and the trace ID and gets a new attempt span ID.

### On a server

Import the workspace module from `@deploy-local/trace`. Start one trace per inbound request. Use fixed operation names and pass the span to parallel work explicitly.

```js
import { startTrace } from '@deploy-local/trace';

async function handle(request) {
  const trace = startTrace(request.headers.get('traceparent'));
  const result = await trace.span('catalog.load', async (span) => {
    const rows = await span.span('db.read', () => loadRows());
    return rows;
  });
  const response = Response.json(result);
  response.headers.append('Server-Timing', trace.serverTiming());
  return response;
}
```

For a call to another trusted service, set the outbound request's `traceparent` to the active span's `traceparent`. deploy.local can then group the HTTP requests. The helper preserves return values and rethrows errors from the measured function. Finish spans before sending response headers. Existing servers can keep sending ordinary `Server-Timing` metrics for `match`, `render`, `action`, `db` and `queue`.

### In a browser or native app

Start a root trace at the interaction. Attach a fetch span to the network request and record work after the response on the same trace.

```js
const trace = startTrace();
const response = await trace.span('shelf.fetch', (span) =>
  fetch('/shelf', { headers: { traceparent: span.traceparent } }),
);
const shelf = await trace.span('shelf.decode', () => response.json());
const requestId = response.headers.get('x-request-id');
if (requestId) {
  const event = trace.clientEvent(requestId, '/shelf');
  const body = JSON.stringify({ v: 1, build: null, events: [event] });
  navigator.sendBeacon('/__deploy/telemetry', body);
}
```

The same HTTP contract works with URLSession. See [the runnable Swift example](../../examples/instrumentation/client.swift). Supply the route pattern, such as `/items/:id`. Each request can attach one completed client span batch with up to 16 spans. A span carries its operation name, span and parent IDs, its start offset and duration in milliseconds, and an optional failure flag. Use a monotonic clock on each device. Offsets from different processes have separate origins. Client spans and navigation milestones expire after seven days.

### Read a trace

In an authenticated deploy.local session, open `/api/apps/<app>/requests/<x-request-id>` to see the request, edge attempts, retry waits, app phases, and any joined browser or native timing. Use `/api/apps/<app>/traces/<trace-id>` to find related requests in that app. Both lookups enforce app ownership. The second returns up to 100 requests and indicates truncation.

Every proxied request records its ID, cache outcome, time to upstream headers when available, and edge elapsed time in the existing buffered request log. Slow requests (one second or longer), errors, cancellations, retries, requests with a trace parent, and instrumented server spans retain the individual attempts. About one in 256 other requests retains that detail. The longest operations can overlap. A router commit is a client milestone; individual content can finish loading later.

### Trace an interaction through visible content

Use `@deploy-local/trace/interaction` in a browser or add the `InteractionTracing` Swift package. Configure one tracer per signed-in owner and service origin. The application supplies an authenticated, same-origin reporter and a stable owner scope. In the browser, pass sessionStorage to retain pending events across page loads in that tab. Apple clients use UserDefaults. Flush after reconnect or session restoration and call close on sign-out.

```js
import { interactionTracer } from '@deploy-local/trace/interaction';

const tracer = interactionTracer({ origin: location.origin, scope, storage: sessionStorage, send });
const open = tracer.start('detail.open');
const response = await open.fetch('/api/detail');
const detail = await open.span('detail.decode', () => response.json());
// From the callback that presents this particular detail to the user
open.finish('details.visible');
```

In Swift, create `InteractionTracer(scope:send:)`, start the same operation, wrap its network work in `InteractionScope.$current.withValue(open)`, and use `Interaction.data(_:session:origin:)` in the existing transport. Finish from the visible-content callback. On either platform a failed or abandoned interaction can finish with an error or cancelled outcome. Use fixed names such as `detail.decode` that contain no user data.

The reporter sends an InteractionEvent to the application's own backend. From there forward `{v:2,interaction:event}` with the deployment's server telemetry credential to the existing server ingestion endpoint. Look up the trace by its trace ID even when there were no requests. Each client keeps at most 16 queued events and 16 child spans per interaction. Lookup joins matching edge requests by ID. Child durations are measured on the clock of the process doing the work.

The collector retains the first 20 healthy opens per project per minute, then samples one in 16 up to 60 healthy opens. A separate 60 slots are available for errors, cancellations and interactions of at least one second. The interaction_volume table counts retained and sampled-out envelopes per project and minute. Network rejection and events evicted on a device are outside these counts. Both the counts and collected interactions expire after seven days.

### Export OpenTelemetry spans

Any application with an OTLP/HTTP trace exporter can send spans to the deployment's collector. Configure these variables in the **server process** before initializing the SDK. The shell expands the collector URL and token that the host supplies to that deployment.

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${RFR_TELEMETRY_URL%/}/v1/traces"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer%20${RFR_TELEMETRY_TOKEN}"
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
```

Register a tracer provider and a batch span processor. Set `service.name` to a stable service name. Use the W3C Trace Context propagator for requests between your services. A browser or native client can propagate `traceparent` and `tracestate` to its application backend. Use an application-authenticated forwarder for client exports and keep the deployment token on the server.

The receiver accepts OTLP traces as binary protobuf or OTLP JSON, optionally gzip compressed. Its success acknowledgment follows persistence, including on remote workers. Replaying a batch with the same trace and span IDs is safe. Limits are 512 KiB compressed and decoded, 1,024 spans per export, and 4,096 new spans per deployment in a rolling minute. Reduce batch size on HTTP 413. Back off on HTTP 429 or 503.

The project-scoped trace lookup above includes a `spans` array, including for traces with no edge request. Retention is seven days. Stored fields include service, instrumentation scope, operation name, IDs, parent, span kind, status code, nanosecond timestamps, bounded event names/times and link IDs. HTTP route template, method and status code are the supported span attributes. Use fixed operation and event names and route templates without personal data. Client interaction events also include a wall-clock start for waterfall placement and measure their duration on the client's monotonic clock.

### Export application flows over OTLP

Web clients can use `exportInteractions(events, serviceName)` from the `otlp` entry point in an interaction tracer's `sendBatch` callback. Apple clients use `InteractionTracer(batchingScope:sendBatch:)` and `TraceExport.body(_:service:)`. Both produce OTLP/HTTP JSON. Supply an authenticated reporter for the signed-in owner. Use stable operation names and an explicit allowlist of API route families. Both clients forward W3C trace context to their own origin and retain at most 16 completed interactions during an outage.

The coordinator accepts its own authenticated clients at `POST /api/control/otel/v1/traces`. Each owner can list recent traces at `GET /api/control/traces` and read one at `GET /api/control/traces/<trace-id>`. Hosted apps send through their private collector URL using the deployment credential. Open a hosted request in Requests to inspect its waterfall.

Operators can select up to 16 additional attribute keys per project with `DEPLOY_OTEL_ATTRIBUTES`, a JSON object mapping the deployment name (or `control:<owner>`) to an array of keys. For example, `{"example":["db.operation.name","app.rows_returned","pool.name"]}` retains those scalar attributes on spans and events. The receiver bounds string values to 160 characters and retains up to 32 events per span. Only select fields safe for project owners to read.

### Links that work before hydration

For a server-rendered page with interaction tracing enabled, put the static `navigationHandoffScript` from `@deploy-local/trace/otlp` in a classic inline script in the document head. Set its `data-trace-scope` to the signed-in tracer's scope and `data-trace-paths` to a space-separated allowlist of exact, public destination paths. Supply both as HTML attributes.

When the client configures tracing, call `takeNavigationStart(enabled ? scope : undefined)` and pass its result as the third argument to `observeNavigation(tracer, nameRoute, documentStart)`. This retires the early listener. A trusted same-tab click that loaded a new document can then use the normal destination milestone and fetch spans. The timestamp is relative to the destination's time origin and can be negative. A handoff requires a same-origin referrer, a matching owner and route, and a click within the last 30 seconds. Direct visits, reloads and history restores use the ordinary page-load path.

### Audit one flow in another app

1. Pick one action and the outcome a person can observe. Name the root, its ending milestone and the services a successful run should reach. Include a cached run if that path can complete locally.
2. Instrument at those boundaries. On Apple, attach `traceDisplayTick(_:start:)` to an appearing view and pass its operation name or `nil` while hidden. The closure starts an interaction with the app's existing signed-in tracer. The root ends at `screen.display_tick`, the first display-link callback after SwiftUI observes that view. A screen that leaves first ends at `navigation.left`. Use a recording or another independent signal to measure readable text, decoded media or a completed animation. A request or display callback alone cannot establish those outcomes.
3. Exercise the ordinary UI. Use an owner-authenticated GET to `/api/apps/<app>/traces` for a hosted app or `/api/control/traces` for the coordinator. Each lists up to 100 trace IDs among the latest 1,024 spans, including client-only traces. Append `/<traceId>` to retrieve each detail. Keep the raw exports local. Check the root, its milestone and parent links, including edge attempts. For an operation that crosses the network, pass one `--require-service` for each expected service.
4. Repeat control and candidate in alternating, matched pairs with the same account, content, cache state, device and build configuration. Pass the number of attempted actions to `--expected-trials` so a missing export fails the audit. Keep failures and cancellations in the coverage count and compare successful durations separately. Report user-visible timings alongside span timings.

From the deploy.local checkout, this command checks one or more trace-detail JSON files and reports the median successful root duration. A failed check returns a nonzero status.

```sh
node scripts/perf/audit-trace.ts --service example.apple \
  --root screen.library.present --event screen.display_tick --expected-trials 6 trial-*.json
```

For web navigation audits, exercise the earliest actionable link as well as a hydrated page. In a browser test, call `auditNavigation` from `scripts/perf/audit-navigation.mjs` with a fresh signed-in Playwright page per trial. Set `settleMs: 0` for the first visible link and repeat with a delay on a fresh page. The helper distinguishes a full document load from a client-side transition and lists matching OTLP/JSON root trace IDs emitted after the trusted click. An empty list means no matching root with the requested milestone was observed during `exportWaitMs` (default five seconds). Use the owner trace endpoint and `audit-trace.ts` to check receipt and parent links.

```js
const result = await auditNavigation(page, {
  from: baseUrl,
  to: '/library',
  link: (page) => page.getByRole('link', { name: 'Library', exact: true }).first(),
  endpoint: '/otel/v1/traces',
  service: 'example.web',
  root: 'screen.library.open',
  event: 'catalog.ready',
});
```
