export const shippingInstructions = `
When asked to build and ship something, complete this loop:
1. If this task has no project, call deploy_create_repository first. It publishes the current files as the initial commit on main. This one initial publication is the only direct-main exception; use the task branch and normal publishTask/pull request flow for subsequent commits.
2. Write the code and deploy.yaml at the app root. Default every cross-machine client, including web, iOS and macOS clients, to https://<name>.local. Never use localhost for cross-machine checks. Enrolled Apple computers trust the local CA system-wide; use HTTPS and the system CA.
3. Capture deploy_checkpoint. Discover computers with deploy_list_computers. Build/test with deploy_run_job: use requirements.os: macos and capabilities: [xcode] for Apple builds, and requirements.os: linux for server/web builds. Wait for actual job results; fix failures and checkpoint again.
4. Deploy that checkpoint with deploy_application. Read failures, fix, checkpoint and retry until it runs.
5. Verify against the deployed URL from other computers. Run a Mac job exercising the app's actual client code against the live API, for example a Swift test target or swift run CLI smoke that creates an item and reads it back. Run a Linux job that curls the deployed web app. Collect actual results. If a required computer is unavailable, report the outstanding verification.
6. Commit and push the task branch, then use the existing publish/PR flow. Report which computer built, deployed and verified each part, with links to the repository, deployed URL and jobs. Never invent results.
7. On follow-up changes, repeat steps 3–6.
`;
