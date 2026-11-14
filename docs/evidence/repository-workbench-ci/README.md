# Repository workbench and hosted CI acceptance

Verified on SER on 2026-10-17. Web code deployed from `codex/repository-workbench-ci`, revision `00d19401952f1ad273af804d60034845d476c224`.

## Repository experience

The right pane now has a single location header, branch selector, actual branch/tag counts, History, a keyboard file finder, a commit strip and a grouped file table with Name, Last commit, Updated and Size. Desktop rows have 56px height and the work pane has 24px insets. Compact layouts retain comfortable touch controls and hide secondary columns before they become cramped. The second sidebar remains contextual navigation.

Directories render their actual README below the file listing. Source uses monospace line numbers and syntax colors from the shared palette; Markdown can switch between preview and source. PNG, JPEG, GIF and WebP files can be inspected directly. Copy, Raw and Download use the selected commit's bytes. New task carries the selected commit and repository path into the composer. The shared design-system contract documents this composition.

### Browser checks

- Desktop at 1280×720; compact at 430×900, with no horizontal page overflow.
- Branch selection, directory navigation and breadcrumb return.
- `T` opens Go to file with the search input focused; Enter opens the matching source. Escape returns focus to the trigger.
- Source syntax uses JetBrains Mono with semantic palette colors; actual file copy and download succeeded (downloaded source matched the committed file byte for byte).
- Clone copies the hosted deploy.local URL without credentials; Escape restores Clone focus.
- File History opens the actual commit diff with independently numbered old/new lines.
- Root README renders; its relative LICENSE link opens the repository file. Markdown source/preview toggle works.
- `public/favicon-96x96.png` loaded with natural dimensions 96×96.
- Switching Files → Issues → Files restored the root reading position (11690.5px) and the selected branch. Repository and route switches preserved the selected file.
- New task opened the composer with `c2046a7ef8c9` and `examples/repository-ci/server.mjs`, without sending an LLM request.
- Pipeline rows and details expose check output and the publication receipt separately. A failed check shows “Not deployed · checks failed”.

Source previews remain bounded to 256KiB. The file finder indexes up to 10,000 paths and shows up to 100 matches; History shows the latest 30 commits. README images are represented by descriptive text, while their files can be opened in the image viewer. This pass changes the web repository experience; native clients were not rebuilt.

## Real push → check → deployment acceptance

Project: **Repository CI** (`4a695762-b4aa-45cd-8556-797bbca37d2f`).

Application: [repo-ci-smoke](https://repo-ci-smoke.local/).

Hosted remote: `https://deploy.local/api/git/4a695762-b4aa-45cd-8556-797bbca37d2f`.

Permanent checkout: `/Users/gabrielcsapo/Documents/coding/repository-ci` (clean `main`, tracking `origin/main`). Reusable source: `examples/repository-ci/` in this repository.

Every push to the fixture's `main` branch runs `node --test` on SER. Both tests must pass before the coordinator publishes the exact tested commit. Check jobs receive no application publication credential. The application was bootstrapped once because the current CI bridge requires an existing healthy application with an unchanged graph.

| Push           | Result                                        | Running application                              |
| -------------- | --------------------------------------------- | ------------------------------------------------ |
| `195f8959e2b7` | 2 tests passed; deployment healthy            | Release 3                                        |
| `e11c48941f16` | Deliberately invalid release 0; 1 test failed | Release 3, identical container and source digest |
| `14d5a56963df` | 2 tests passed; deployment healthy            | Release 4                                        |

The final healthy receipt `e3342792-6f19-49f7-bea9-0381d13aaeaa` pins source commit `14d5a56963dfea74d3f50dc9f4fb3da202f0e661`. The public `/version` reports release 4. Exact run IDs, output, source digests, receipts and before/after container identities are recorded in [ci-verification.json](ci-verification.json).

The first post-bootstrap push (`1f520b0d0e60`) passed its checks but encountered HTTP 409 during publication; it did not replace the running app. That historical unknown publication is retained in the evidence. Two subsequent passing pushes published successfully around the deliberate failing push. A diagnostic reservation was cancelled and its temporary CI credential revoked; no release gate was bypassed. The precise first-conflict cause remains unconfirmed.

## Release integrity and checks

The release checkouts are self-contained Git clones from completed bundles. Earlier release metadata had an alternate object path through the mutable `current` symlink; that path was repaired to its immutable parent release, and new release checkouts avoid that dependency. Application files in the previous live release were not edited.

The final SER prepare completed typecheck, production build and 581 server tests: **567 passed, 14 skipped, 0 failed**. Locally, the seven repository/diff tests and two fixture tests passed; the production build and typecheck passed. Scoped lint has no errors and four inline Markdown-renderer component warnings. Future updates use the ordinary-user release command, without sudo.

## Screenshots

- [Before](before.png)
- [After — desktop](after-desktop.png)
- [After — compact](after-compact.png)
- [Rendered README](readme.png)
- [Source inspection](source.png)
- [Passing CI and deployed receipt](ci-passed.png)
- [Failed CI with no deployment](ci-failed.png)
- [Application running release 4](application-release-four.png)
