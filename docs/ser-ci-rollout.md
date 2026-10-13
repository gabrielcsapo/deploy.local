# SER controller rollout candidate

The candidate combines merged improvements commit
`5cd16c4f2f05fc3a66061c7df0e10872ff2a60b8` with the exact release-critical
`b561c209..61cae703` differences from the currently serving controller. This
retains legacy Groffee preservation, original/data-host-key layout checks, durable
legacy recovery fencing, HTTP/public Git SSH verification, source rebuild/retry,
runtime reporting, owner controls and edge-cache invalidation. Overlapping API,
Docker and dashboard sections retain both legacy guards and scoped CI fences.

The explicit CA-generation profile from `b51815ee` is included. It affects future
generation only; existing public certificates and private keys are retained and
must not be regenerated or reinstalled. This is a new combined candidate rather
than deployment of the older improvements baseline by itself. Independent
read-only reviews found the live compatibility implementation retained.

Gabriel approved installation and the preserving Wander transition on October
13, 2026 at 15:45 UTC. This does not authorize credentials, secrets, trust-branch
configuration, automatic pipeline activation, data deletion, or destructive
rollback. The original eight dirty files and nine stashes remain untouched.

Before installation: confirm live identity, make an independent consistent
controller SQLite backup and verify an isolated migration/restore rehearsal,
retain the original service unit/checkpoint and built serving checkout, validate
combined tests/builds and exact artifact hashes, then switch only the controller
systemd override. Retain the original DEPLOY_DATA_DIR. Sudo requires a user
handoff; no password or credential contents are accessed by the agent.

Wander remains on its existing legacy container and physical data/upload binds.
Its prepared overlay uses the existing desired digest as a repository-base
directive; it does not use --replace or delete/redeploy. The plan correctly flags
a durable-provider compatibility boundary and required backup. Full independent
cold backup plus database/media/upload restore verification is mandatory before
activation. Graph recovery cannot archive bind resources, and scoped CI rejects
bind applications. This overlay does not enable the CI publication pipeline.

A further supported-boundary blocker prevents Wander activation: an ordinary
owner stop is not a durable writer fence. startAllContainers can restart the
retained canonical legacy container during controller boot, while graph
single-writer checks track graph instances only. No new maintenance/adoption
platform, state patch, or policy workaround is included. Resolve this boundary
with an explicitly reviewed and tested supported path before quiescing Wander.
