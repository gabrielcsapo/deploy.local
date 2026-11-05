# react-flight-router docs

From the repository root, install with `pnpm install --frozen-lockfile`, then run
`pnpm --filter react-flight-router-docs build:deploy`.

This produces `dist/flight-router-docs.tar.gz` in this package: a self-contained
static site, `deploy.yaml`, nginx configuration and Dockerfile. The bundle serves
at `/` and falls back to `index.html` for client-side routes. It needs no Node
runtime or registry access in its container. Building does not deploy anything.

To deploy later, extract the archive into a new directory **outside a Git checkout**
and run `deploy push` from that directory. The CLI uses Git's file list inside a
checkout, which would omit the ignored `dist` assets. Do not deploy this source
directory directly: its Dockerfile expects the generated bundle's `site/` files.
The declared application is `flight-router-docs` (`https://flight-router-docs.local`).
No root `deploy.yaml` is required or added to deploy.local itself.

`pnpm --filter react-flight-router-docs build` builds the static site with the
checked-in example output. Refreshing that output is a separate authoring task:
`pnpm --filter react-flight-router-docs refresh:examples` builds the example and
launches Chromium. It is not part of a docs build or `pnpm test`.
