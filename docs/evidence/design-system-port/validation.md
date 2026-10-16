# Application port verification

The design-system study is now implemented in the web application. Screenshots in this directory use an isolated local database and a disposable account. They are UI verification, not evidence of a live agent run or a production deployment.

Verified desktop and 390 px layouts, the rail/context/work split, a full-height task editor, retained unsent draft across management navigation, right-pane task table, real repository metadata/source, computer filtering/clear, compact navigation, and Escape focus restoration. The command palette is available in both tasks and management and includes only registered application destinations.

Local typecheck, production build, scoped lint and scoped formatting pass. Repository/capability tests and the missing/stale/zero metric availability regression pass. The generator produces formatted CSS using the repository formatter configuration. The repository-wide formatting hook also covers pre-existing out-of-scope files with formatting failures; those files were left intact and the commit used the completed scoped checks.

SER uses Node 26.5.0, matching the running controller. Initial SER build/typecheck passed; its broad suite identified the existing unique-value-swap assertion's SQLite-version dependency. The included compatibility test accepts either exact lossless replay or explicit rejection and verifies both input databases remain intact. No reconciliation runtime behavior was changed.

The feature branch is published to Groffee. SER cannot authenticate directly to that Git host, so it fetches a verified bundle of the published ref into a separate checkout. The live checkout and original service override remain intact. A consistent SQLite backup and isolated migration rehearsal are prepared before switching the root-owned service. Final service activation requires sudo authentication on SER.
