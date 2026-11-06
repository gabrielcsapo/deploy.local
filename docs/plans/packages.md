# Packages: hosting our own npm packages and crates

Status: proposal, waiting for the owner's approval of the design (`design/packages`). Nothing here is built yet.

deploy.local should build its own infrastructure without depending on GitHub, npmjs.org or crates.io being up. This plan does two things:

1. It brings `react-flight-router` (today a separate repository, published to npmjs.org) into the deploy.local repository.
2. It adds **Packages** to deploy.local: a private npm registry and a private Cargo registry that people and releases publish to, plus a copy of everything projects install from npmjs.org and crates.io, so installs keep working offline.

The boards are in section 10 of the canvas (`design/canvas.json`, “10 · Packages”): `Packages`, `Package`, `PackagesCache`, `PackagesSetup`, `TaskPublish`, `PipelineRun`, `CliPackages` and `PackagesPhone`, plus changes to `Settings` (Package keys) and `SettingsPhone` (a Packages row).

`docs/plans/repository-server.md` says not to introduce “an artifact-management system” for deployments. That still holds for deployments: releases keep building from source. Packages is a separate decision, made on purpose for libraries and offline builds.

---

## Part 1: react-flight-router moves into this repository

### What it is today

- A pnpm monorepo (`pnpm@10.24.0`, no `engines`) with 120 commits, 35 tags and version 0.12.1. deploy.local installs 0.12.0 from npmjs.org.
- The published package, `packages/react-flight-router`, holds about 11k lines of TypeScript and 4.4k lines of tests. It builds with plain `tsc` into `dist/`, has one bin (`react-flight-router`), is ESM only, and peers on react 19, react-server-dom-webpack 19, vite 8, @vitejs/plugin-react 6, hono 4 and @hono/node-server 2.
- Private packages beside it: `docs` (a Vite + MDX site on GitHub Pages), `react-flight-router-example`, `react-flight-router-notes-example`, `react-flight-router-e2e` (Playwright specs and benchmarks) and `shared-ui`.
- Tests: 20 vitest files (happy-dom) plus a `node:test` worker-pool test against `dist`. There are 17 Playwright specs on ports 3000, 3001 and 5173. CI (`.github/workflows/e2e.yml`) runs only lint and e2e, never the unit tests.
- Release: `scripts/release.mjs` bumps the version, writes the changelog from conventional commits, tags `vX.Y.Z`, runs `pnpm publish` to npmjs.org and pushes to `origin`. The local clone has no remote. Repository URLs point at both `github.com/gabrielcsapo/flight-router` and `…/react-flight-router`.

### Recommendation: workspace packages in deploy.local, consumed with `workspace:*`

deploy.local is the router's main user, and the two often change together. Keeping them in one repository makes a router fix and its use in deploy.local one pull request, with one set of checks, and no publish-bump-install round trip.

**Considered and not chosen: its own hosted project, consumed from Packages.** That keeps the release cadences apart, but deploy.local's own build would then need deploy.local's registry to install. That creates a bootstrap problem on a fresh machine or during recovery, and every router change would need a publish before deploy.local could use it. Other projects still get it from Packages (below), so nothing is lost.

### What moves where

The history is imported with `git filter-repo` path renames and merged with `--allow-unrelated-histories`, so `git log --follow` and blame keep working. Tags are renamed `react-flight-router@0.12.1` so they don't collide with deploy.local's own `vX.Y.Z` tags.

| From (react-flight-router repo)                                                                  | To (deploy.local)                                   |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `packages/react-flight-router/`                                                                  | `packages/react-flight-router/`                     |
| root `CHANGELOG.md`, `README.md`                                                                 | `packages/react-flight-router/`                     |
| `scripts/release.mjs`                                                                            | replaced (see Releasing)                            |
| `packages/docs/`                                                                                 | `packages/react-flight-router-docs/`                |
| `packages/react-flight-router-example/`                                                          | same name                                           |
| `packages/react-flight-router-notes-example/`                                                    | same name                                           |
| `packages/react-flight-router-e2e/`                                                              | same name                                           |
| `packages/shared-ui/`                                                                            | `packages/react-flight-router-shared-ui/` (renamed) |
| root `package.json`, lockfiles, `.husky`, `.github/`, `.DS_Store`, nested `pnpm-lock.yaml` files | dropped                                             |

Everything lands under the existing `packages/*` workspace glob, so `pnpm-workspace.yaml` only gains a catalog.

### Build, tooling and tests

- **One version of each shared dependency.** A pnpm `catalog:` covers react, react-dom, react-server-dom-webpack, vite, @vitejs/plugin-react, hono, @hono/node-server, vitest and playwright. The router's packages use `catalog:` and deploy.local's root uses the same entries.
- **TypeScript.** The router uses TS 6 and deploy.local uses TS 7. The library builds with the root's TS 7. If the declaration output differs in a way that matters, the library alone keeps TS 6 as a dev dependency. This is checked in the first slice.
- **Format and lint.** One commit reformats the router with deploy.local's oxfmt config (single quotes) and is listed in `.git-blame-ignore-revs`. The router's oxlint plugins (react, unicorn, import) stay in a nested `.oxlintrc.json` under its packages.
- **Build order.** deploy.local's `dev`, `typecheck`, `build` and `test` first run `pnpm --filter react-flight-router build`, through a small `scripts/flight-router.mjs` that skips the build when `dist` is newer than `src`. The root `build` calls `node packages/react-flight-router/dist/bin/react-flight-router.js build` directly instead of relying on a bin link made before `dist` existed (the router's CI re-ran `pnpm install` for this reason). SER's `deploy-update prepare` runs install, typecheck, build and test, so it picks this up with no changes.
- **Unit tests** join `pnpm test` through `scripts/test.mjs`. That adds the 20 vitest files and the worker-pool test, so they run on every SER release for the first time.
- **End-to-end tests and benchmarks** stay out of `deploy-update prepare`, which already takes about 10 minutes. They become a `deploy.yaml` pipeline job, `flight-router-e2e` (Linux, Chromium), on pushes to main and on pull requests that touch `packages/react-flight-router*`. `server/pipeline-spec.ts` gains an optional `paths:` filter for this.
- **Open: where the e2e job lives.** Pipelines are read from a root `deploy.yaml`, and a root `deploy.yaml` on main marks the project as deployment-configured, even with only a pipeline in it. That would change deploy.local's own shipping controls, so the job isn't added yet. Until a pipeline can exist without that, the end-to-end specs run by hand with `pnpm --filter react-flight-router-e2e test:e2e`. `pipeline.publish` for the router depends on the same fix.
- **Docs.** `packages/react-flight-router-docs` is deployed as a static app on deploy.local instead of GitHub Pages. Vite's `base` becomes `/`, and links to GitHub point at deploy.local's code page. The GitHub Pages workflow goes away.

### Releasing the router after the move

The version is set in the pull request (as `TaskPublish` shows). Merging to main makes the pipeline publish the new version to Packages (Part 2), so nobody releases it by hand. The conventional-commit changelog generator stays as `pnpm --filter react-flight-router changelog`, run in that pull request. `repository` fields point at deploy.local's repository.

npmjs.org: by default nothing more is published there, and 0.12.1 stays the last public version. Whether to keep mirroring releases to npmjs.org for outside users is the owner's call (question 1 below).

The old repository folder is left as it is. Archiving the GitHub repository is for the owner to do; this plan never pushes to GitHub.

**Part 1 does not depend on Part 2.** `workspace:*` needs no registry, so Part 1 can land first.

---

## Part 2: Packages in deploy.local

### Shape

- Packages runs in the control server as `server/packages/`: `npm.ts`, `cargo.ts`, `cache.ts`, `store.ts` and `keys.ts`. It uses plain `node:http` handlers like the rest of `server/api.ts`.
- **Considered and not chosen: Verdaccio or kellnr as managed apps.** They would need their own accounts, another process to supervise, and npm or crates.io to install them. The npm registry protocol and Cargo's sparse-index protocol are small enough to serve directly.
- **Addresses.** These end up in committed `.npmrc` and `.cargo/config.toml` files, so they must not change later:
  - npm: `https://deploy.local/npm/`
  - Cargo, private: `sparse+https://deploy.local/cargo/index/`
  - Cargo, copy of crates.io: `sparse+https://deploy.local/cargo/crates-io/`

  The edge (`server/edge/index.ts:127-134`) forwards `/npm/` and `/cargo/` to control. Project and repository names `npm` and `cargo` become reserved, because the web app's top-level `:repository` route would otherwise take them. The web pages live at `/packages`, `/packages/npm/<name>` and `/packages/cargo/<name>`.

### npm

- **Hosted endpoints:**
  - `GET /npm/:name`: the packument, abbreviated when the client sends `Accept: application/vnd.npm.install-v1+json`.
  - `GET /npm/:name/-/:file.tgz`
  - `PUT /npm/:name`: publish. Only new versions are accepted. A changed `deprecated` field is accepted as a deprecation.
  - `PUT|DELETE /npm/-/package/:name/dist-tags/:tag`
  - `GET /npm/-/whoami` and `GET /npm/-/ping`
  - `GET /-/v1/search` (hosted packages only)
- **Refused, with a message:**
  - Unpublish (`DELETE`): “Versions are never removed. Deprecate it instead.”
  - `npm login` / `adduser`: “Run deploy packages login.”
- **Scoped names** (`@scope%2fname`) work. New private packages should use `@deploy.local/…`.
- **No mixing of names.** A name with any version published here is served only from here: deploy.local never merges in npmjs.org's versions for it, and never falls through to npmjs.org for it. This closes off dependency confusion in both directions.
- **Publishing a name that already exists on npmjs.org** (react-flight-router does) needs an admin and `--claim`. The CLI then offers to bring over every existing version from npmjs.org as “Brought over” versions (the `Package` board), so old lockfiles still install.
- **Audit** (`/-/npm/v1/security/advisories/bulk`) is passed through to npmjs.org when it can be reached. Offline it answers with an empty result and a warning header.

### Cargo

- **Private registry `deploy-local`:**
  - Sparse index at `/cargo/index/`. `config.json` gives `{"dl": …, "api": "https://deploy.local/cargo", "auth-required": true}`. Index files (`1/`, `2/`, `3/a/`, `ab/cd/`) are generated from the database.
  - API:
    - `PUT /cargo/api/v1/crates/new`: the binary publish format, new versions only.
    - `DELETE /cargo/api/v1/crates/:name/:version/yank` and `PUT …/unyank`
    - `GET …/owners`: returns the publisher.
    - `GET /cargo/api/v1/crates/:name/:version/download`
  - Crates may depend on crates.io crates. Those dependencies name crates.io's index, and Cargo's source replacement sends them to the copy.
- **Copy of crates.io:** at `/cargo/crates-io/`, an exact mirror. Index files are fetched from `index.crates.io` and kept. `.crate` files come from `static.crates.io` and are checked against the index `cksum` (sha256). Cargo's source replacement requires a mirror to be exact, which is why private crates live in a separate registry rather than in the copy.
- `auth-required` (stable since Cargo 1.74) means Cargo sends the key on every request, including downloads.

### Who can do what (auth)

Everything reuses deploy.local accounts. **Every request needs a credential**: there is no anonymous install, even on the LAN.

| Credential                                                                       | Where it comes from                                                                                                                                     | Install                                          | Publish                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------- |
| **Package key** `dlp_<32 random bytes, base64url>`                               | `deploy packages login` mints it from your CLI sign-in. Listed in Settings → Package keys, with a label, scope and last use. Revoked at once by Remove. | yes                                              | if scoped “Installs and publishes” |
| CLI session (Basic `username:token`, exactly as Git over HTTPS accepts it today) | `deploy login`                                                                                                                                          | yes                                              | yes                                |
| Computer key (Basic `workspace-worker.<id>` or worker headers)                   | already on every computer                                                                                                                               | yes                                              | no                                 |
| Pipeline token, 30 minutes, scoped to one project's packages (like `ci_` tokens) | minted for a pipeline's publish step only; its jobs never see it                                                                                        | yes                                              | that project's packages only       |
| Agent run token (`X-Deploy-Agent-Token`)                                         | agent runs                                                                                                                                              | no (agents install through their computer's key) | no                                 |

- Package keys are stored sha256-hashed, like worker tokens. npm sends them as `_authToken` (Bearer). Cargo sends the raw value in `Authorization`, so both `dlp_…` and `Bearer dlp_…` are accepted.
- Package keys exist so that npm and Cargo keep working when the 30-day CLI session rotates. The session still works for one-off use, so “reuse CLI tokens” holds.
- **Who may publish.**
  - A new name: any signed-in person, or a pipeline.
  - Later versions: the person who first published it, any admin, or a pipeline of the project the package belongs to.
  - The package's project is the repository it was published from: given by the pipeline, or by `repository` / the git remote when a person publishes.
- **Agents and tasks never publish.** A computer's key only installs, so `npm publish` inside a task gets a 403: “Tasks can't publish. Set the version in the pull request; the pipeline publishes it when it merges.” No publish card goes to Waiting on you, which keeps to “Shipping is yours to start”.

### Storage

- **Tables in `deploy.db`**, added by a hand-written migration in `drizzle/` as the repository does for 0034 onward:
  - `packages`: ecosystem, name, project_id, created_by, created_at
  - `package_versions`: version, sha256, integrity, size, manifest, published_by, published_via (`person`, `release` or `import`), commit, deprecated, yanked, created_at
  - `package_tags`
  - `package_keys`
  - `package_cache_entries`: ecosystem, kind (`doc` or `file`), key, sha256, size, etag, fetched_at, last_used_at
  - `package_pins`: which cached files a live release, its rollback target, or a project's lockfile on main needs
- **Files in the data folder**, so they outlive releases:
  - `<data>/packages/hosted/sha256/<2>/<hash>`: private packages. **Backed up** with deploy.local's own data.
  - `<data>/packages/cache/sha256/<2>/<hash>` and `<data>/packages/cache/docs/…`: the copy. **Not backed up**, because it can be fetched again.
- Writes follow the LFS pattern (`repository-lfs.ts`): stream to a `wx` temp file, check the hash, then rename. Downloads stream with `pipeline(createReadStream, res)`, with ETag support.
- The Backups page needs no change: its wording covers deploy.local's data, and hosted packages are part of that.

### How the copy behaves

- **Packuments and index files** are served from the copy if it was fetched less than 5 minutes ago. Otherwise they are revalidated with ETag. If the source fails (a connection error, a 5 s timeout or a 5xx), the copy is served and the source is marked unreachable. Tarball URLs in packuments are rewritten to `https://deploy.local/npm/…`.
- **Tarballs and `.crate` files** never change once published, so they are kept by hash and checked against `dist.integrity` (sha512) or `cksum`. A file that fails the check is never stored.
- **While a source is down**, deploy.local checks it every minute. The Copies tab shows the banner and Unreachable, and the sidebar shows “Using copies”.
- **Packages kept.** On each push to main, and daily, deploy.local reads each project's lockfiles on main:
  - npm: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` (v1 and berry), `bun.lock`
  - Cargo: `Cargo.lock`

  It fetches anything missing in the background. The Copies tab gives a project its own row only when something is missing or removed.

- **This is not a promise that builds work offline.** It covers npm packages and crates. App builds also need their Docker image (see Not covered), and the board says so.
- **A package its source removes.** npmjs.org can pull a version, for example as malware. When revalidation finds a kept version gone from its packument, deploy.local stops serving it (a 404 that names the source and the date) and keeps the file out of installs, even if it is pinned. The project with that version in its lockfile gets a Removed row, and a rollback that needs it fails and says why. While the source is unreachable this can't be known, so kept versions are still served. A yanked crate is different: Cargo still allows it for existing lockfiles, so it keeps being served.
- **Pins.** When a release builds, deploy.local records which files it installed. Files needed by the live release, its rollback target, or main's lockfile are pinned, so a rollback never needs the internet.
- **Keeping and clearing.** Daily, files that are unpinned and unused for 90 days are deleted. The default size limit is 20 GB: past 90% the oldest unpinned files go first, and Storage says so. Both values are settings on the Copies tab.
- **Not covered:**
  - git and GitHub tarball dependencies
  - Docker images (app builds pull `node` images)
  - nodejs.org downloads (`build:cli`)
  - PyPI and Swift packages

  These are listed as follow-ups. Docker images matter most for fully offline app builds.

### How builds use it

- **Tasks and pipelines on every computer**: `server/workspace/job-runner.ts` and `shell-environment.ts`.
  - npm: the computer writes a job-scoped `npmrc` (`registry=https://deploy.local/npm/`, `//deploy.local/npm/:_authToken=<computer key>`, `cafile=<SER's CA>`) and sets `NPM_CONFIG_USERCONFIG`. npm, pnpm, Yarn and Bun all read it.
  - Cargo: each computer gets its own persistent `CARGO_HOME` (`<worker data>/cargo-home`) with a `config.toml` holding the two registries, the source replacement and `http.cainfo`. Its credentials come from `CARGO_REGISTRIES_DEPLOY_LOCAL_TOKEN`.
- **Job containers** get the CA file and these configs mounted, and `--add-host deploy.local:<SER's address>`. On SER that is `host-gateway`. On other computers it is the address mDNS resolved on the host, because containers don't resolve `.local` names.
- **App builds**: the Dockerfile generated by `server/docker.ts`. The `npmrc` and CA are passed as BuildKit secrets (`RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install`), so no key ends up in an image layer.
- **Lockfiles keep working:**
  - pnpm's lockfile stores integrity, not URLs.
  - npm rewrites `registry.npmjs.org` resolved URLs to the configured registry by default (`replace-registry-host=npmjs`).
  - Yarn v1 lockfiles keep their `resolved` URLs, so `deploy packages use` rewrites those hosts once, as a one-time lockfile change.
- **Per project:** Project settings get a Packages group with one switch, Install through deploy.local, on by default. Off means the public registries directly, which helps when debugging.
- **deploy.local itself.** Its committed files don't point at its own registry, so a fresh machine can still install. `self-update` passes `npm_config_registry=https://deploy.local/npm/` only when `/npm/-/ping` answers, and otherwise installs from npmjs.org.
- **People's own computers:**
  - `deploy packages login` writes the auth lines to `~/.npmrc` and `~/.cargo/credentials.toml`, and makes sure SER's CA is trusted: `cafile` for npm, `http.cainfo` for Cargo on Linux, the keychain on macOS.
  - `deploy packages use` writes the project's `.npmrc` and `.cargo/config.toml` (shown on the `PackagesSetup` board). These hold addresses only, never keys.
  - **Committing them has a cost.** Once they are committed, anyone who can't reach deploy.local can't install the project, including the owner away from SER. npm and Cargo have no fallback registry. So `use` is optional, the board and the command both say this, and `deploy packages use --off` removes the files. deploy.local's own computers don't need these files, because jobs get their config from the computer.

### Publishing

- **People:**
  - `deploy packages publish [--tag next] [--dry-run] [--claim]` in a folder with `package.json` or `Cargo.toml`. For npm it runs `pnpm pack`, which turns `workspace:` ranges into real versions. For Cargo it runs `cargo package`. It then uploads with your package key and prints steps (the `CliPackages` board).
  - `deploy publish` is already the CI release command, so it stays as it is.
  - Plain `npm publish`, `pnpm publish` and `cargo publish --registry deploy-local` also work after `deploy packages login`.
- **Pipelines** are the normal way to publish, so nobody has to release a package by hand:
  - `deploy.yaml`'s `pipeline:` gains `publish:`, beside `jobs:` and `deploy:` in `server/pipeline-spec.ts`. It is a list of repository subfolders (for deploy.local: `- packages/react-flight-router`), validated like `pipeline.deploy.path`. It works with npm packages and Cargo crates.
  - Publishing runs as a step of its own, after every job has passed. If a job fails, nothing is published.
  - For each listed folder, the step reads the version. If that version is already published, it is skipped, which is not a failure. So a pipeline can run on every push, and only a change of version publishes.
  - Otherwise it packs the folder at that commit (running `prepublishOnly`) on a Linux computer and publishes it with a pipeline token. The token goes to this step only, so job commands can't publish.
  - Only pipelines allowed to deploy may publish: the repository owner's, never `pull_request` runs (the same rule as `assertAgentApplication`). Claiming a name that exists on npmjs.org still needs an admin.
  - A failed publish fails the run and says why. Run pipeline retries it, and whatever already published is skipped. Several packages are published one at a time, so a retry finishes only what is left.
  - A pull request that changes one of those versions shows "Merging publishes react-flight-router 0.12.2" in the task's status line and a Package row in its panel (the `TaskPublish` board). Its pipeline packs the folder and checks that the version is free, without publishing.
  - The run shows what it published or skipped (the `PipelineRun` board), and the package's version row names the run.
- **Never replaced.** A version that exists is refused (“0.3.2 is already published. Nothing changed.”).
  - `deploy packages deprecate <name>@<range> "<message>"` and `deploy packages yank <crate>@<version>` correct mistakes. The package page's version rows offer the same.
  - Nothing is ever deleted.

### What each app shows

- **Web:**
  - **Sidebar.** Packages sits below Computers and appears once deploy.local has served any package. It reads “Using copies” while npmjs.org or crates.io is down. On approval, every board's sidebar gets the row in one mechanical commit.
  - **Packages page** (`Packages`): three tabs.
    - Private: the packages deploy.local hosts.
    - Copies (`PackagesCache`): sources, packages kept per project, storage.
    - The bare name `/packages` opens Private.
    - Set up (`PackagesSetup`).
  - **A package** (`Package`): install command and registry, versions, and the projects that use it, read from each project's lockfile on main.
  - **A project with packages** gets a Packages tab after Releases with the same rows. Not drawn: it reuses the list.
  - **Project settings** get the Packages switch. Not drawn: one row in the existing Settings pattern.
  - **Settings → General** gets Package keys (`Settings`).
  - **A task** whose merge publishes shows it in the status line and panel (`TaskPublish`).
  - **A pipeline run** lists the packages it published or skipped, below its jobs (`PipelineRun`). It also draws the Pipelines tab, which the app has today but no board has shown.
- **Mac:** the Electron window loads the same web pages, so the Mac shows exactly the web screens. Nothing native is added, and there are no new notifications, because publishing never waits on a decision.
- **iPhone:** Settings → Agents and data gets a Packages row (`SettingsPhone`). It opens a read-only list (`PackagesPhone`): private packages, sources and what is kept. A package row opens its versions in a sheet. Not drawn: it uses the same rows.
- **CLI:** `deploy packages` (list), `login`, `use`, `publish`, `deprecate`, `yank`, and `copies` (status, or `fetch` to get what a project's lockfile is missing). Each gets a line in `HELP`, and the code lives in `bin/packages.mjs`.
- **API** for the apps:
  - `GET /api/v2/packages` and `GET /api/v2/packages/:ecosystem/:name`
  - `GET /api/v2/packages/cache` and `POST /api/v2/packages/cache/warm`
  - `GET|POST|DELETE /api/v2/package-keys`
  - `POST /api/v2/packages/:ecosystem/:name/versions/:version/deprecate|yank`

### Safety

- Names never mix hosted and upstream versions. Claiming a public name needs an admin.
- Every upstream file is checked against its published hash before it is stored.
- Limits: 200 MB per tarball or crate, 10 MB per packument.
- Keys are hashed, scoped, revocable and show their last use. No key is ever written to a project file.
- Publishes, deprecations, yanks and key changes go to deploy.local's activity log with who, which credential and from where.

### Order of work

Private crates still ship, but last. The owner moved Cargo to the end because the goal is npm first: point deploy.local at its own registry, and publish a router change and see it right away.

Each slice gets a Codex worktree (`codex exec -m gpt-6-astra`, branch `codex/<slice>`), with Claude verifying: captures at board widths with `design/tools/capture.mjs` and `pair.py`, the iOS build, and real npm, pnpm and Cargo clients.

1. **Design approval** (this proposal).
2. **react-flight-router into the repository** (Part 1). This needs no registry.
3. **npm, hosted and the copy:**
   - package keys
   - `deploy packages login|use|publish`
   - the Packages list and the package page
   - Settings → Package keys
4. **Builds use it:**
   - computers, job containers and app Docker builds, for npm
   - the project switch
   - keeping what lockfiles need, and pins
   - removed versions
   - the Copies tab and the sidebar state
   - the blocked-network release test (see "What still comes from outside")
5. **Pipelines publish:**
   - a pipeline that doesn't make deploy.local deployment-configured (the open problem in Part 1)
   - `pipeline.publish` in `deploy.yaml` and `server/pipeline-spec.ts`
   - the publish step and pipeline tokens
   - packages on the pipeline run
   - the task status line and panel row
   - iPhone Packages
6. **Switch over:**
   - bring over every react-flight-router version on npmjs.org
   - publish 0.12.2 from deploy.local
   - point other projects that use it at Packages
7. **Cargo:**
   - the private registry and the crates.io copy
   - per-computer `CARGO_HOME`, job containers and app builds
   - `yank`, and Cargo on the Set up, Copies and iPhone screens

Each step adds its own part of a screen, so nothing claims what doesn't exist yet. The boards are the finished state, and the app matches them fully once step 7 lands.

### What still comes from outside

The owner's goal: "all the content should go through that and cache so we can have some insulation from upstream issues". The registry only covers what clients fetch from the registry, so these stay outside it. Checked on 2026-11-05 against this repository's dependencies and on SER.

| What                        | When it's fetched                                                                   | From                                                            | Where deploy.local is exposed                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3` 13         | Every install that builds it: `node-gyp` compiles it, with Node's headers           | nodejs.org, only if `~/.cache/node-gyp` lacks that Node version | SER has headers for its Node 26.5.0, so it only needs nodejs.org after a Node upgrade. It also needs a compiler.                                                                                                      |
| Electron                    | First use, not install: 44.x has no install script and `index.js` runs its download | github.com/electron/electron releases                           | Building the Mac app and anything else that runs Electron. A SER release's install doesn't fetch it. Whether SER's tests can trigger it isn't checked; `~/.cache/electron` on SER has an entry from some earlier run. |
| Docker base images          | App builds                                                                          | Docker Hub (`node:22-alpine`)                                   | Every app build that doesn't already have the image                                                                                                                                                                   |
| Node for `build:cli`        | Building the CLI                                                                    | nodejs.org                                                      | CLI releases                                                                                                                                                                                                          |
| Playwright browsers         | Only when asked (`@playwright/browser-chromium` is not allowed to build)            | Playwright's CDN                                                | Browser tests                                                                                                                                                                                                         |
| Git and GitHub dependencies | Install                                                                             | The git host                                                    | None for deploy.local: its lockfile has none. Other projects aren't checked.                                                                                                                                          |

`esbuild`'s install script gets its binary from a registry package, so the copy covers it. `ssh2`, `cpu-features`, `protobufjs` and `unix-dgram` are not allowed to run install scripts.

**A real test of the insulation.** Step 4 ends with a release run with npmjs.org and the other outside hosts blocked, and a report of what fails, because the table above comes from reading code, not from running with those hosts down. Rehearse on a computer other than SER first, and on SER use `deploy-update prepare` without activating. Ask the owner before blocking anything on SER.

**deploy.local's own installs keep their fallback.** As planned under "How builds use it", they use the registry only when `/npm/-/ping` answers and otherwise use npmjs.org, so a fresh machine or a recovery can still install.

### How it is tested

- **Protocol tests.** Server tests run against a fake upstream (a local HTTP server standing in for npmjs.org and crates.io). They cover: packuments, abbreviated documents, scoped names, publish, refusing a version that exists, dist-tags, deprecate, the Cargo publish binary format, index files and yank.
- **Real clients.** Tests run `npm install`, `pnpm install --frozen-lockfile`, `yarn` and `cargo build` against a test server. Cargo tests skip when `cargo` isn't installed.
- **Offline.** Stop the fake upstream, and every locked install still passes while a never-fetched version fails clearly.
- **Removed versions.** A version dropped from the fake upstream's packument stops installing and shows on the Copies tab.
- **Pipelines.** A run with a new version publishes it, a second run skips it, a failed job publishes nothing, a pull request run never publishes, and a job command can't read the token.
- **Auth matrix.** Each credential is tested against each action, including a task's 403 on publish.
- **Board parity.** Each screen is checked at 1440 and 700 (web) and 390 (iPhone).

### Questions for the owner

1. **npmjs.org.** Stop publishing react-flight-router there after 0.12.1 (proposed), or keep mirroring each release for outside users?
2. **Placement.** Packages in the sidebar (proposed), or as a tab under Computers to keep the sidebar shorter?
3. **Addresses.** Reserve `/npm/` and `/cargo/` (proposed), or use `/api/packages/npm/`? The latter is uglier, but no project names are reserved.
4. **Copy limits.** 20 GB and 90 days (proposed)?
5. **Anonymous installs** on the LAN: off (proposed)?
6. **"All the content".** The registry doesn't carry Docker images, Node downloads, Electron or git dependencies (see "What still comes from outside"). Is that enough insulation, or should some of them be kept too? Docker images matter most, since every app build needs one.
7. **Versions.** Keep setting the version in the pull request (proposed), or have the pipeline work out the next version from commit messages? The router's commits already follow the convention, but not every project's do.
8. **Other projects and new router versions.** `workspace:*` gives deploy.local a router change right away. Other projects only get it through a version bump, and nothing in this plan does that, so "see the changes right away" holds only for deploy.local today. Options:
   - Bump by hand in each project, as now.
   - A `deploy packages update <name>` command that updates a project's version and lockfile, run by a person or an agent.
   - When a new version publishes, deploy.local starts a task in each project using it, which opens a pull request. The owner still merges. This contradicts the approved `Package` board's "deploy.local does not open pull requests for new versions", so it needs a design change.
9. **Freshly published versions and pnpm's waiting period.** pnpm's `minimumReleaseAge` applies to private packages too, so a project with that setting can't install a new private version until the period passes. The real-client tests set it to 0 to get around this. deploy.local has this setting today, so it would affect other projects set up the same way. Should private names be excluded, per project or for all of them?
10. **Deprecating from the web, and search on Packages.** The plan offers deprecate on version rows, and the boards draw a search button, but no board draws either interaction. The CLI and API can deprecate. Draw them, or leave them out?
