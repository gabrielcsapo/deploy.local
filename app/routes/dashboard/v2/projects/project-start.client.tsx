'use client';
import { Composer, Glyph, Icon } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { CloneTabs, SshKeyHint, useCloneProtocol } from './clone.client';
import { cloneAddresses } from './clone.ts';
import { CopyButton } from './code.client';
import { useBrowserOrigin, type Overview } from './data';
import { projectPath } from './routing';

/** A repository with no code yet: describe it for a task to write, or push code you have. */
export function ProjectStart({
  project,
  overview,
  addApp,
}: {
  project: Project;
  overview: Overview;
  addApp?: () => void;
}) {
  return (
    <>
      <div className="dl-empty v2-project-start">
        <Glyph>
          <Icon name="folder" size={20} />
        </Glyph>
        <h3>What should {project.name} be?</h3>
        <p>
          Describe it and a task writes the first version, then opens a pull request for you to
          review.
        </p>
        <div className="v2-project-start-composer">
          <Composer start projects={[project.id]} project={project.name} />
        </div>
      </div>
      <ProjectPushCode project={project} overview={overview} addApp={addApp} />
    </>
  );
}

export function ProjectPushCode({
  project,
  overview,
  addApp,
}: {
  project: Project;
  overview: Overview;
  addApp?: () => void;
}) {
  const origin = useBrowserOrigin();
  const { https, ssh } = cloneAddresses(
    {
      ...overview.repository,
      clonePath: overview.repository?.clonePath || `${projectPath(project.id)}.git`,
    },
    project.id,
    origin || 'https://deploy.local',
  );
  const { shown, choose } = useCloneProtocol(ssh);
  const clone = shown === 'ssh' && ssh ? ssh : https;
  const commands = `git remote add origin ${clone}\ngit push -u origin ${overview.repository?.defaultBranch || 'main'}`;
  return (
    <section className="dl-section v2-project-start-push">
      <h2 className="dl-section-title">Or push code you have</h2>
      <p className="dl-section-sub">
        From the folder your code is in. Either way, {project.name} lives on deploy.local.
      </p>
      {ssh && <CloneTabs shown={shown} choose={choose} label="Push with" />}
      <div className="v2-project-start-term">
        <pre className="dl-term wrap">{commands}</pre>
        <CopyButton value={commands} label="Copy commands" />
      </div>
      {shown === 'ssh' && (
        <p className="dl-meta">
          <SshKeyHint />
        </p>
      )}
      {!overview.repository?.source?.location && (
        <p className="dl-meta">
          No remote. <a href={`${projectPath(project.id)}/settings`}>Add one in Settings</a> to keep
          a copy on GitHub in sync.
        </p>
      )}
      {addApp && (
        <p className="dl-meta">
          Already running it?{' '}
          <a
            className="dl-link"
            href={`${projectPath(project.id)}?addApp=1`}
            onClick={(event) => {
              event.preventDefault();
              addApp();
            }}
          >
            Add an app you shipped
          </a>{' '}
          to this project.
        </p>
      )}
    </section>
  );
}
