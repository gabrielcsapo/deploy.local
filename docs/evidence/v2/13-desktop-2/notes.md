# Slice 13 part 2 — desktop

Work in progress; native visual acceptance is not yet claimed.

The tray now renders the attention SVG, decision attribution/reason/time, Live app health rows,
computer activity, Take new tasks and footer shortcuts. The build copies `app/design-tokens.css`
into the desktop assets; the packaged app reads only its local copy. Take new tasks uses the
computers admission API, preserving current tasks and the worker process.

Run apps and Serve models remain disabled. `server/v2/computers.ts` rejects changes to both roles
with 409 because runtime reconfiguration is missing. Remote workers do not advertise either
role. Setup explains this limitation; no application or model runtime is installed.

Deliberate Tray differences: use server-provided reasons and health summaries, abbreviate only
elapsed decision times, and show only measured computer activity. The computer contract has no
task start time, so no invented task duration. No battery pause promise: the switch says current
tasks keep running. Missing inventory or Live data reads Unavailable. OS window decoration and
notification chrome belong to Electron/the OS.
