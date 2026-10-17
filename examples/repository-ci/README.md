# Repository CI

A small dependency-free Node application for testing deploy.local's hosted Git → CI → deployment flow. Its `main` branch runs `node --test` on a Linux worker and publishes the exact tested commit only after all checks pass.

## Local development

```sh
node --test
node server.mjs
```

Open http://localhost:3000. `/health` reports readiness; `/version` returns the committed `version.json`, so a deployment can be verified against source.

## Connect a hosted repository

Copy this directory into its own Git repository, create a project in deploy.local, and push the initial `main` branch. Bootstrap the `repo-ci-smoke` application from this source once; the CI bridge requires an existing healthy application with the same graph. Then push a new commit to `main`. Inspect its check output and deployment receipt in **Repositories → Pipelines** and **Applications → repo-ci-smoke → Deployments**.

## Verify the failure gate

1. Change the release in `version.json` to `0`, commit, and push. The test must fail and the running application's `/version` must remain unchanged.
2. Restore a positive release, commit, and push. The check must pass and the running application must report that exact new release.

This fixture changes only its own application. Keep it separate from the deploy.local server repository and from production applications. Jobs receive no application release credentials; publication is performed by the coordinator using the pinned commit.
