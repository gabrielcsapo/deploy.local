# Repository library and settings acceptance

The Repositories rail destination now opens `/dashboard/repositories`: a searchable repository library with contextual All repositories, Hosted here and Imported filters. Names, descriptions, import sources and readiness come from the authenticated inventory. Rows are full-row keyboard-accessible links, and no repository is opened automatically.

Repository workspaces have durable routes at `/dashboard/repositories/:projectId`, with local section suffixes including `/settings`. The context sidebar has a return link to the library and section links; the repository dropdown is removed. Settings saves display name and description, shows the actual hosted clone URL/default branch/import source, and exposes existing fetch/setup recovery operations. Metadata edits preserve repository identity, Git storage and ongoing operations.

## Live verification

Deployed revision: `eb6b38227e0e2e3ef30fad4feeb43283fb2c4410`, branch `codex/repository-workbench-ci`. The ordinary-user release helper activated the checked build on SER without sudo.

The full SER prepare passed typecheck, production build and **582 tests: 568 passed, 14 skipped, 0 failed**. Three targeted repository route/settings/browsing tests passed locally. Scoped lint and formatting checks passed. The settings integration test covers owned reads, rejected foreign/worker access, validation, stale revisions, idempotent replay, a single update event, and preservation of Git/setup fields.

Manual live browser checks covered:

- Name and description search; clear-filter recovery from no matches; hosted/imported filters.
- Keyboard entry into a repository, context Settings navigation, and New repository dialog opening/Escape.
- Settings drafts retained through Files → Settings; actual save and full reload; temporary test-repository rename restored to Repository CI.
- Browser Back restoring library search and the selected `version.json` file after visiting Settings.
- Two open clients: a saved change notified the other client, preserved its unsaved draft, disabled stale saving and showed exactly one conflict alert. Reload saved values returned the newer description. The original meaningful description was restored afterward.
- A missing repository showed a single recovery state and a working return to the library.
- Direct Settings reload and durable Pipelines URLs, with the existing passing run still reporting Deployed.
- Desktop 1280×720 and compact 430×900; compact content stayed within its 382px work pane. The horizontal compact section bar brings the active section into view after capabilities load. Viewport overrides were reset.

The reusable test repository remains named **Repository CI** with the description “Tests hosted Git pushes, CI checks and healthy deployments.” Its Git HEAD and clone URL are unchanged, and the running application still reports release 4. The exact revision, saved metadata and assertions are in [verification.json](verification.json). No new LLM run or CI deployment was started by this settings verification.

## Screenshots

- [Library — desktop](library-desktop.png)
- [Library — compact](library-compact.png)
- [Settings — desktop](settings-desktop.png)
- [Settings — compact](settings-compact.png)
- [Concurrent edit recovery](conflict-recovery.png)
