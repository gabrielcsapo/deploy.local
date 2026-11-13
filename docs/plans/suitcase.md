# Suitcase retirement

Suitcase and portable second sites are retired. deploy.local has one Home coordinator and its
enrolled execution computers. Worker computers, agent jobs, remote workers, application graphs,
backups, and Home recovery bundles remain supported.

The former portable-site implementation has been removed: pairing and offline administrator
projection; event, artifact, and telemetry exchange; replica selection and publication; portability
analysis and capacity planning; data-policy changes, synchronization, and reconciliation; release
candidates and cross-site authority transfers; and recovered-site re-adoption.

Ordinary graph execution uses coordinator or enrolled-worker placement. Stable Home and application
identities are maintained by `server/local-site.ts`. The historical `fleets`, `sites`, and
`application_aliases` rows still supply IDs required by existing application and recovery records.
They do not make a second site available.

The owner approved removing the portable-site runtime and its data inventory on 2026-11-13.
No portable-site inventory, export, or migration is required before retirement. The existing
`server/home-coordinator.ts` guard still refuses portable installations or orphaned replica data;
removing that inventory gate is a later step in [the one-server plan](one-server.md), not a new
owner prerequisite. Ordinary application storage and Home recovery remain supported.

Remaining portable schema cleanup follows forward migrations in that plan. Historical application manifests and signed
Catalog documents can still contain inert portability/reconciliation fields: changing their
canonical representation would change stored revision digests and signed release identities.
Recovery snapshots retain their existing inventory format and validation so older Home bundles
remain verifiable and restorable. Restore no longer starts a Suitcase re-adoption workflow.

Historical changelog/About copy is unchanged pending a separately approved screen change. The
remaining copy is not a setup guide or evidence that portable sites are supported.

See [the project workspace plan](project-workspace.md#retire-suitcase-and-portable-sites) for the
retirement decision and [the README](../../README.md#one-home-coordinator) for the current topology.
