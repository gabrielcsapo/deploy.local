# Request trace waterfall and span inspector

A developer investigating a slow request should be able to answer three questions from Requests. How long did the user wait? Which operations overlapped? What did the application record during the wait? The desktop and mobile web boards follow the same home-gym export through the browser, edge, server, and database. [Open the design review](https://deploy.local/dashboard/design?review=design%3A67d679c5-003f-45d0-b424-53a99dbb0149%3Adesign~opentelemetry-request-waterfall%3A26c6e2bd5440).

## Read the whole trace first

Open on the root interaction when one is available. The horizontal axis starts at its beginning. Each row represents a span, indented beneath its recorded parent. Parallel operations occupy the same part of the axis. Keep time with no recorded children visible. For an incomplete trace, show the available time range and identify the partial result. A missing parent or a device clock difference is insufficient evidence to infer a wait.

The fixture export lasts 15.2 seconds. Read workouts takes 12.1 seconds and overlaps Read sessions. Both reads finish before the upstream attempt times out. The database span can therefore succeed while the parent request returns HTTP 502. Keep the status attached to the operation that reported it.

## Inspect one span

Selecting a row or bar opens an inspector beside the timeline on desktop and a scrollable bottom sheet on narrow screens. Show the operation, service, elapsed time, share of the full trace, start offset, parent, and recorded status. Use the service name alongside its color and a visible error marker alongside the failure status.

Attributes are key/value pairs for the selected span. Events appear in timestamp order, with each offset measured from that span's start. A retained event attribute sits beneath its own event. Use a short empty state when a span has no recorded fields or events. Selecting another span replaces both lists.

In the design fixture, Read workouts has `db.operation.name = SELECT` and `app.rows_returned = 842`. Connection acquired appears at +11.8 s with `pool.name = reads`. Rows returned appears at +12.1 s. These are illustrative values. They show why a duration alone cannot tell a developer how long the query spent waiting for a connection.

## Move around the waterfall

- Collapse a parent to hide its descendants while keeping its bar in place.
- Focus span fits the selected operation and its descendants to the time axis. Full trace restores the original range. The inspector's share of trace keeps the full-trace denominator.
- Next error advances through recorded failures, expands the necessary ancestors, and selects the failed span. Close on mobile returns to the selected row.
- Support keyboard selection and visible focus. On a phone, preserve the current selection and zoom when the inspector closes.

## OpenTelemetry fields and retention

Use the same inspector for web, native, and backend spans. Join records by trace and span IDs and reconstruct hierarchy from parent IDs. Use recorded timestamps and durations, with service and instrumentation scope taken from the export.

The local receiver currently retains span identity, timing, status code, the HTTP route template, method and response status, event names and timestamps, and linked span IDs. The proposed extension lets each project choose additional span and event attribute keys to retain. Apply that selection at ingestion and bound the retained data per span. Existing traces continue to show the fields that were recorded. The database attributes and event attribute in the example require this extension.

## Review checks

- At desktop width, select Read workouts and read both events while the overlapping database reads remain visible.
- At phone width, open the same span, read the attributes and event offsets, focus the span, and return to the full trace.
- Advance through the fixture errors to the upstream timeout. Verify that the successful database read keeps its own status.
- Select Encode CSV after Read workouts and verify the inspector shows empty attributes and events. Check the design in light and dark mode.
