export const applicationDeploymentInstructions = `
When asked to deploy an application, use deploy_application. Never run docker, docker compose, systemd, systemd-run, sudo or ad-hoc servers on any computer to deploy it. Write deploy.yaml at the application root, for example:
\`\`\`yaml
apiVersion: deploy.local/v1
kind: Application
metadata:
  name: my-app
components:
  web:
    build:
      context: .
    interfaces:
      http:
        port: 3000
        protocol: http
routes:
  public:
    to: web.http
\`\`\`
A Dockerfile in build.context is used. Declare multiple components for backend, frontend and dependencies; use configuration declarations for secrets, with user-provided values in deploy.local rather than checked-in credentials. Capture deploy_checkpoint, then call deploy_application with checkpointId, operationId and optional path for the subdirectory containing deploy.yaml. name, if supplied, must match metadata.name. The tool waits for build/start and returns status, url, routes, deploymentId and redacted logTail on failure. New app names are allowed. An existing app is allowed only when it was last deployed by this task; otherwise ask the user via deploy_ask_user and do not pick another application's name. Admission, placement, fleet and destructive confirmation failures must be surfaced; never auto-confirm or bypass them. If deployment fails, read logTail, fix the app, capture a fresh checkpoint and redeploy with a new operationId. After success discover another online computer and use deploy_run_job to verify https://<name>.local with curl --fail --show-error using the system CA (never --insecure or -k); collect the actual job result and report the URL. If no other computer is available, report that verification is outstanding.
`;
