import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Architecture</h1>
      <p>
        One home coordinator owns projects, repository access, task history, assignments, and
        releases. Browser and native clients share that state. Execution workers own their local
        processes, toolchains, and workspaces.
      </p>
      <h2>Projects, tasks, and runs</h2>
      <p>
        A project can contain a Git repository, issues, pull requests, and tasks. A task records the
        conversation and successive runs. Each writing run has one assigned workspace and worker;
        changing the client does not move the running process. Separate tasks use separate
        worktrees.
      </p>
      <p>
        Agent coordination tools can inspect computers and dispatch scoped jobs. Pipeline jobs pin a
        commit and select Linux or macOS workers by capability. The scheduler records dependencies,
        logs, cancellation, and terminal results. Uncertain execution is not silently replayed.
      </p>
      <h2>Application intent and runtime state</h2>
      <p>
        A repository <code>deploy.yaml</code>, verified Catalog release, or supported Compose input
        compiles into an immutable application specification. Its digest identifies the desired
        revision. Health admission records the active revision; observed containers describe actual
        state.
      </p>
      <p>
        The graph contains components, fixed instance groups, private interfaces, public routes,
        resources, jobs, and configuration references. Secret values stay outside the graph. Scaling
        changes desired state. Restart and replacement target individual runtime instances.
      </p>
      <h2>Machines and routing</h2>
      <p>
        Execution nodes enroll with short-lived codes and communicate outward to the coordinator.
        Application graphs run on one node, while the coordinator retains the primary application
        address. Its edge process terminates TLS, advertises local names, and routes requests to
        local containers or an agent relay.
      </p>
      <p>
        Computers do not become independent coordinators when disconnected. Existing applications
        can continue running; new assignments and release promotion require the coordinator. Local
        Git work remains ordinary Git work.
      </p>
      <h2>Release provenance</h2>
      <p>
        Pipeline checks use one immutable commit. Publication retains the original intent and
        predecessor, then records the activated container and image in a receipt. Lost responses
        reconcile against that receipt rather than publishing the same release again.
      </p>
      <h2>Durability and recovery</h2>
      <p>
        SQLite metadata, hosted Git repositories, LFS objects, retained source, and application
        volumes have different durability needs. Existing encrypted home-recovery tools verify
        bundles and rehearse restoration into an empty directory. Production restore is an offline
        maintenance operation. Full project and worker recovery acceptance remains in progress.
      </p>
      <p>
        Historical site tables remain for existing home application identities and recovery records.
        Portable-site APIs, CLI commands, and synchronization startup loops have been removed. An
        upgrade refuses portable-site records that still need migration.
      </p>
      <p>
        See <Link to="/docs/roadmap">Projects and workflows</Link> for the current scope and{' '}
        <Link to="/docs/nodes">Machines and placement</Link> for node setup.
      </p>
    </article>
  );
}
