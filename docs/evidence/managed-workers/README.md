# Live SER task worker and repository verification

Verified against the running HTTPS application, not a seeded preview. Implementation is on `codex/design-system-ser`; the final application release is `2d80fcd`.

## Cause and repair

The production supervisor declared the repository service twice. One child held the repository lease while its duplicate repeatedly exited. The remaining ordinary-user processes belonged to an isolated candidate checkout and candidate database; they were not live workers. The root control service could not see the operator's signed-in coding runtime.

The supervisor now starts one repository child. Settings → Providers starts and supervises a dedicated ordinary-user task worker through the authenticated coordinator API. It does not open or change ownership of the root workspace database. Saved provider keys use the existing encrypted application secret store and owner/worker/provider scope. Only the chosen adapter receives its provider environment. Codex uses an isolated worker authentication directory and can adopt the existing CLI authentication cache without importing desktop configuration. Device authentication and API-key configuration are available from the app; provider authentication still requires the user's provider account.

## Actual live exercises

- Created **SER worker verification** through the live Create project dialog. Repository setup reached `ready` with a real initial commit.
- Submitted a real Codex task to the managed SER worker. It created `README.md`, `sum.js` and `sum.test.js`; the live review displayed the actual uncommitted diff.
- The agent created a checkpoint and ran `node --test` using `deploy_run_job` on SER: **3 passed, 0 failed, exit 0**. Durable job ID: `a9f81f55-ec69-4648-8644-935e6539d407`.
- Used the operator's authenticated hosted Git transport to clone the dedicated verification repository, copy only those three verification files, commit them on **verification/managed-worker**, and push that branch. The task checkout remained uncommitted. A fresh test run in the clone also passed all three tests. No other repository or application was modified by this exercise.
- Selected that branch in the live repository view. Verified the Name / Last commit / Updated / Size columns and opened the actual `sum.test.js` source with line numbers.
- Saved the existing Codex account connection through the app API. Confirmed the worker applied exactly that revision.
- Activated the prepared release using `deploy-update`, without sudo. A new managed worker process registered automatically; the connection revision, task, diff and successful checkpoint job survived.
- Submitted a follow-up through the live conversation after the restart. Codex ran `node --test` successfully in the existing checkout without modifying its files.
- Confirmed exactly one live repository supervisor child, running with zero restarts. Candidate processes use a different data directory and were left alone.
- Verified Computers → Task computers → Manage task worker and providers leads to the actual Providers settings.

## UI issues found during verification

Review previously displayed “No checks recorded” despite the successful remote checkpoint job. It now displays real job status, digest, exit code and output. Remote tasks no longer show an unusable local-only Run check form. File counts and file rows use actual diff entries rather than parsing a placeholder status sentence. Provider checkboxes use the shared action color. User-message bubbles now use the theme's raised surface instead of a pale hard-coded background that made dark-theme messages unreadable.

Verified the provider settings and review at 1280×800 and 390×844, including inner-pane scrolling and keyboard disclosure focus/Enter behavior. Before/after review evidence is in `code-review-live.png` and `review-results-desktop.png`; compact evidence is in `providers-compact.png` and `review-results-compact.png`.

## Validation and limits

The clean SER release preparation passed typecheck, production build and **566 tests, 14 skipped, 0 failures** (580 total). Focused provider isolation, worker launch, lease, model and supervisor tests passed locally (9/9). Local typecheck/build passed. The full dirty macOS checkout had four unrelated failures: two LibreSSL certificate verifier differences, an existing dirty catalog/preflight change, and a Linux `/proc/self/fd` assumption. Existing unrelated files were not changed or included. The follow-up commit's repository-wide formatting hook also found existing unrelated formatting issues; scoped formatting and lint passed, so those unrelated files were preserved.

Codex account inference was exercised live. Claude is honestly reported as requiring sign-in; compatible API is disabled. API-key encryption/isolation and device-flow handling have regression coverage, but no invented credentials or unnecessary new account authorization was used to claim those providers were tested live. The verification fixture is intentionally retained for review.
