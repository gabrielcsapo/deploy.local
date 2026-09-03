import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Application configuration</h1>
      <p>
        <code>deploy.yaml</code> is the durable description of every application. It is a versioned
        graph of the components, routes, resources, jobs, and configuration the application needs.
        Keep it in the repository so the definition can be reviewed, reproduced, and moved between
        deploy.local installations.
      </p>

      <h2>A simple application</h2>
      <pre>
        <code>{`apiVersion: deploy.local/v1
kind: Application

metadata:
  name: example

components:
  web:
    build:
      context: .
    role: web
    interfaces:
      http:
        port: 3000
        protocol: http

routes:
  public:
    to: web.http
    path: /
    discoverable: true`}</code>
      </pre>
      <p>
        Components expose named interfaces. Routes, environment bindings, resources, and jobs refer
        to those stable names, giving deploy.local enough intent to build and visualize the
        application graph.
      </p>

      <h2>Durable data</h2>
      <p>
        Data requirements belong in the graph. Runtime placement and the physical location of the
        volume remain deployment settings.
      </p>
      <pre>
        <code>{`components:
  web:
    build:
      context: .
    role: web
    interfaces:
      http:
        port: 3000
        protocol: http
    mounts:
      /app/data:
        resource: data

resources:
  data:
    type: volume
    durability: durable
    dataRole: files
    access: singleWriter
    backup:
      policy: required
      retentionCopies: 2

routes:
  public:
    to: web.http`}</code>
      </pre>

      <h2>Configuration and secrets</h2>
      <p>
        Declare administrator-supplied values in the manifest, then bind them into components. The
        values themselves are stored separately and never written into the manifest or its exports.
      </p>
      <pre>
        <code>{`configuration:
  apiToken:
    type: secret
    required: true
    description: API token used by the service
  logLevel:
    type: string
    default: info
    allowedValues: [debug, info, warn, error]

components:
  web:
    build:
      context: .
    role: web
    interfaces:
      http:
        port: 3000
        protocol: http
    environment:
      API_TOKEN:
        from: configuration.apiToken
      LOG_LEVEL:
        from: configuration.logLevel`}</code>
      </pre>

      <h2>Validation and tooling</h2>
      <p>
        deploy.local validates the manifest before materializing it. Duplicate keys, aliases,
        anchors, custom tags, unknown fields, and invalid graph references fail with a path to the
        declaration that needs attention.
      </p>
      <pre>
        <code>{`deploy validate
deploy plan --app example
deploy schema`}</code>
      </pre>
      <p>
        The schema command copies <code>deploy.v1.schema.json</code> for editor completion. Use{' '}
        <Link to="/docs/cli">
          <code>deploy files</code>
        </Link>{' '}
        to inspect exactly what the CLI will upload.
      </p>

      <h2>Revisions</h2>
      <p>
        Formatting, comments, and key order do not change application identity. Runtime state,
        resolved secrets, and placement remain separate from the normalized specification. The
        dashboard can export the desired revision as repository-ready <code>deploy.yaml</code>.
      </p>
    </article>
  );
}
