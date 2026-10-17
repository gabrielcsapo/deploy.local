# Native clients against deployed SER

Authenticated UI verification completed on October 16, 2026 against trusted `https://deploy.local`, using the normal connection forms in the signed Mac client and iPhone 18 Pro Max simulator (iOS 27). No certificate checks were bypassed. Credentials are excluded from this evidence.

## Verified flows

- Created **Native client verification on SER** from the Mac app in the dedicated **SER worker verification** project. The available managed SER computer was selected; Codex was available and disconnected providers were disabled.
- The task created `greet.js` and `greet.test.js`, ran the tests, created an immutable checkpoint and ran a real checkpoint job on SER. Job `b657fce3-a58b-47ce-a21c-1fd75a785993` succeeded with exit 0: **2 passed, 0 failed**.
- Opened the generated diff. Navigation to Computers and project overview retained the task and unsent draft. Quit, updated and relaunched the Mac app: the signed-in session, selected task and draft survived. The verification draft was then cleared without sending it.
- Opened the repository file list and `sum.test.js` source in the native Mac viewer. The dedicated test repository's main branch was fast-forwarded to its existing verification commit solely to provide a default-branch browsing fixture; see `repository-fixture.json`. The coding task's uncommitted files were preserved.
- Signed in from iOS Simulator, opened the same Mac-created task, inspected its changed files and expanded the checkpoint test output.
- Sent a follow-up from iOS to rerun tests without changing files. Run `16857b33-2920-4ef5-9d74-c70203f974a4` and job `b26e917a-b651-4f56-a8a3-03c77f0fbe43` succeeded: **2 passed, 0 failed**, exit 0. The result appeared in the Mac app as well.

## Fix discovered through UI testing

Before this pass, native Changes offered a local-only Run check control for a managed remote task, and omitted its actual checkpoint job. Changes now renders recorded checkpoint jobs with command, digest, status, exit code and expandable output. The local command control is shown only for local tasks. `mac-review-before.png`, `mac-review-after.png` and `ios-review-checkpoint.png` show the correction and real test output.

Both macOS and iOS Simulator builds succeeded, both bundles passed strict signature verification, and all **13 Swift tests** passed. The updated Mac app is installed at `/Users/gabrielcsapo/Applications/Deploy.app`; the simulator build is installed on the test iPhone. Native builds include the user's existing native working-tree edits, which were preserved and excluded from this commit. The running server remains revision `cafe048`; this native-only fix needs no server restart.

## Limits

This verifies macOS and an iOS simulator, not a physical iPhone or every native destination. Returning to a transcript can reset its reading position even though task selection and drafts survive. The native repository currently displays branches but has no interactive branch chooser; this pass verified default-branch file browsing. No commits, pushes or deployments were performed by the coding verification tasks.

The subsequent [native polish pass](../native-polish/README.md) adds and verifies branch selection, repository context retention and transcript reading-position retention. The limits above describe the original pass.
