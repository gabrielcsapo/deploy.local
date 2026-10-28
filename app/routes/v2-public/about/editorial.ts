// Plain-language edits for the historical notes. Keys are the source bullet text
// (without its commit link); new releases still render directly from CHANGELOG.md.
export const editorial: Record<string, string> = {
  'durable `deploy.yaml` application graphs with canonical digests compilation;':
    'Describe an app and its services in deploy.yaml, and keep a versioned copy of that configuration.',
  'immutable desired/active revisions, semantic change planning, and YAML export;':
    'Compare planned changes with what is running, and export the configuration as YAML.',
  'declared typed configuration with encrypted, release- and site-scoped secrets;':
    'Define configuration values and keep secrets encrypted for each release and site.',
  'multi-node runtime targeting and active-release reconstruction after restart;':
    'Choose which computer runs an app, and recover its release state after a restart.',
  'local CLI validation/planning and an application-graph admin surface;':
    'Check an app’s configuration and planned changes from the CLI or dashboard.',
  'bounded, inspected deployment archives and encrypted remote-agent job payloads;':
    'Check uploaded app archives and encrypt work sent to agents on other computers.',
  'transactional multi-component graph execution with fixed instance slots, private services, health-gated endpoint generations, lifecycle jobs, durable volumes, and PostgreSQL profile operations;':
    'Run an app’s services together, keep internal services private, preserve their data, and check health before sending traffic.',
  'a signed, immutable application Catalog with capability preflight, declared security grants, supported customization paths, and validation-stage Home Assistant and service-graph fixtures;':
    'Check app requirements and permissions before installation. Home Assistant and service examples are included for validation.',
  'Home/Suitcase site identities, pairing, revocation, docked/away/rejoining modes, offline administrator projection, and resumable authenticated event/artifact exchange;':
    'Pair sites, revoke access, and resume authenticated transfers after a connection is lost.',
  'per-application Suitcase placement and explicit no-sync/manual/automatic data policies;':
    'Choose where each app runs and whether its data syncs manually, automatically, or not at all.',
  'portability analysis for stateless, files, ordinary SQLite, adapter-managed, follows-one-site, and incompatible applications, with fail-closed schema and target findings;':
    'Check whether an app and its data can move to another site before starting the move.',
  'SQLite row and uploaded-file reconciliation with retained conflicts and multi-Suitcase ancestry;':
    'Reconcile SQLite data and uploaded files across sites while keeping conflicts for review.',
  'workload-derived Suitcase RAM/storage capacity plans with confidence and unknown-input reporting;':
    'Estimate the memory and storage an app needs, and show when information is missing.',
  'target-local offline builds and explicit release candidates that Home must promote or discard;':
    'Build on the target computer while offline, then review the release before making it live.',
  'encrypted Home recovery bundles, independent verification, clean replacement restore, rehearsal records, and a machine-readable v1 release-readiness gate.':
    'Create encrypted recovery bundles, verify them, and rehearse restoring to a replacement computer.',
  'support schema copied to directory': 'App folders now include the configuration schema.',
  'fix styling in docs site': 'The docs display correctly.',
  'fixes tests': 'Corrected the automated checks.',
  'adds deploy list and json schema':
    'List apps from the CLI and check configuration against a JSON schema.',
  'improve xterm integration - adds gpu_enabled flags':
    'Improved the terminal and added a setting for apps that use a GPU.',
  'moves to react-flight-router - improved performance - single deployable for api and serving application - improves mdns caching and tests (7s -> 100ms) local dns resolution':
    'Pages and local app addresses load faster, and the dashboard and API ship together.',
  'deployment overview - fixes issue with proxyAgent keep alive not proxying requests through and showing 502 page - enables auto backups and manual backs up deploy data to new location':
    'See a release overview, create backups automatically or on demand, and avoid failed requests caused by reused connections.',
  'adds memory limit setting in the admin portal': 'Set an app’s memory limit from the dashboard.',
  'improve analytics dashboard': 'Improved the traffic dashboard.',
  'allows environment variables via dashboard portal': 'Edit app variables from the dashboard.',
  'optimize docker build with buildkit': 'App builds use BuildKit to finish faster.',
  'stops bundling gitignored files - adds ignores array to deploy config - consolidates theme - improves discover experience':
    'App uploads respect .gitignore and configured exclusions. Discover and the shared page styles are improved.',
  'improves deploy pipeline - fixes build logging and generation to be stored while it happens - adds terminal integration for apps':
    'Build logs are saved as work happens, and apps have an integrated terminal.',
  'optimize mdns path': 'Local app addresses resolve faster.',
  'adds deploy.json config, adds extra port mapping, adds discover portal and configuration':
    'Configure apps with deploy.json, expose extra ports, and find apps in Discover.',
  'handles resources with better graph support - adds maintenance in settings':
    'Improved resource charts and added maintenance controls in Settings.',
  'split up server and vite server to improve performance - sets default port to 5050':
    'The development server runs separately for better performance and uses port 5050 by default.',
  'improves routing performance - adds a screen to show up when trying to proxy if the app is starting or down - updates docker run to have 4gb allotment for services - adds compression automatically':
    'App requests are faster and compressed. Apps get a starting or unavailable page, and services default to a 4 GB memory allowance.',
  'use websockets to get realtime deployments and logs':
    'Releases and logs update as work happens.',
  'toggle auto backups and just in time backups':
    'Turn automatic backups on or off, or create one when needed.',
  'build log and tab': 'Read build logs in their own tab.',
  'handles persistence for data folders - adds auto backups - adds migration via drizzle':
    'App data survives restarts, with automatic backups and database migration support.',
  'handles deploy to show docker build status': 'Follow build progress while shipping an app.',
  'handles upload progress': 'See progress while uploading an app.',
  'handles mdns registration - handles sessions for multiple devices - handles password reset':
    'Open apps by their local address, sign in on multiple devices, and reset a password.',
  '3.0.0 - major rewrite to utilize rsc': 'The dashboard now renders pages on the server.',
  'fix headers sent': 'Fixed requests that tried to send a response twice.',
  'improve the build logs to stream correctly - fix pagination - fix styling for selected list in build history':
    'Build logs stream correctly, and build history handles paging and selection correctly.',
  'remove oneline': 'Build logs preserve multiple lines.',
  'fix all app names to be lowercase': 'App names consistently use lowercase letters.',
};
