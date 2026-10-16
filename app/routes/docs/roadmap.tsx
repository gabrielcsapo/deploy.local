import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Projects and workflows</h1>
      <p>
        One home coordinator keeps your repositories, conversations, and work history together. Use
        the browser, macOS app, or iOS app to work with the same projects and tasks.
      </p>
      <h2>Start with a repository</h2>
      <p>
        Create or import a repository without adding configuration. Projects include source
        browsing, issues, pull requests, and linked coding tasks. Independent tasks can also exist
        outside a project.
      </p>
      <h2>Run work where the tools are</h2>
      <p>
        Enroll Linux and macOS computers as workers. A task has an assigned worker; jobs can select
        an operating system and required capabilities. The coordinator records progress and results,
        so changing your client does not move or interrupt the process.
      </p>
      <h2>Checks and deployment</h2>
      <p>
        Add an optional <code>pipeline</code> to <code>deploy.yaml</code> for manual, push, or
        pull-request checks. Each run pins one commit, and dependent jobs wait for their
        prerequisites. Linux container jobs and macOS host builds can participate in the same
        pipeline.
      </p>
      <p>
        Automatic pull-request checks require containers. An owner can start host checks manually.
        Pull-request runs cannot publish releases. Branch pipelines can publish through the existing
        CI release engine after all checks succeed.
      </p>
      <p>
        The current pipeline release bridge supports an existing healthy application with one
        non-privileged built web component on the coordinator and an unchanged application graph.
        Broader external deployment targets remain planned.
      </p>
      <h2>Applications are optional</h2>
      <p>
        Games, native applications, and repositories without a server deployment remain ordinary
        projects. Deployment configuration is only needed when you use deployment or pipeline
        features.
      </p>
      <h2>Current boundaries</h2>
      <p>
        Windows execution is deferred. Portable coordinators and cross-site reconciliation are
        retired. Computers remain execution nodes with one authoritative coordinator. Existing
        installations with portable-site data require an export and migration before upgrading.
      </p>
      <p>
        Physical iPhone acceptance, browser/computer automation, broader recovery testing, and the
        daily-use pilot remain work in progress. Builds and protocol tests do not establish those
        acceptance results.
      </p>
      <p>
        See <Link to="/docs/nodes">Machines and placement</Link> for execution-node setup and{' '}
        <Link to="/docs/deploying">Deploying</Link> for application delivery.
      </p>
    </article>
  );
}
