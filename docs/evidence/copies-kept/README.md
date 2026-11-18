# Copies: what's kept

The real pages compared with the approved boards PackagesCache, PackagesKept, PackagesKeptIdle, PackageKept and PackagesSetup at 1440 and 700 px.

## How the captures were made

```sh
DEPLOY_DATA_DIR=<empty folder> node docs/evidence/copies-kept/fixture-seed.ts
DEPLOY_MDNS_ADDRESS=127.0.0.1 DEPLOY_DATA_DIR=<that folder> PORT=5180 HTTPS_PORT=5182 CONTROL_PORT=5183 node dist/server.js
```

The seed is synthetic: 65 npm packages and 8 Cargo crates with the boards' names and sizes at the top (typescript, @swc/core-darwin-arm64, next, windows-sys, esbuild, puppeteer, tokio) and filler below so the pager has a second page. The pages were captured from the built server over its own HTTPS port, signed in as the seeded admin.

`captures/` holds each page at both widths, plus the open kind menu, the idle footer and the remove dialog.

## Differences from the boards

- **Every Cargo crate reads "Needed by projects".** The boards draw crates no project needs (windows-sys has no tag, and crates appear in the 30-day list). deploy.local does not read `Cargo.lock` yet, so it cannot tell which crates are safe to remove; every kept crate counts as needed, is never listed for removal and is skipped by the automatic clean-up. Reading `Cargo.lock` removes this difference.
- **Sizes under 1 GB stay in MB**, so a total just under the line reads "1003.5 MB" where the board's numbers happen to be in GB.
- **Singular counts** read "1 version" and "1 package". The boards only show plurals.
- The space between sections on Copies and Set up is the Packages page's existing spacing, which is tighter than the boards draw. Not changed here.

The fixture's own data shows through where the boards use SER's: the computer's name, no private packages, both sources reachable and no projects.
