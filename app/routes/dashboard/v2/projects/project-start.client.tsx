'use client';
import { useState } from 'react';
import { Banner, Composer, Glyph, Icon } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { CopyButton } from './code.client';
import { request, type Overview } from './data';
import { projectPath } from './routing';

/** A repository with no code yet: describe it for a task to write, or push code you have. */
export function ProjectStart({ project, overview }: { project: Project; overview: Overview }) {
  const [error, setError] = useState('');
  const clone = new URL(
    overview.repository?.clonePath || `${projectPath(project.id)}.git`,
    window.location.origin,
  ).href;
  const commands = `git remote add deploy ${clone}\ngit push deploy ${overview.repository?.defaultBranch || 'main'}`;
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
          <Composer
            project={project.name}
            onSend={async (text) => {
              try {
                const task = await request('/api/workspace/tasks', {
                  method: 'POST',
                  body: JSON.stringify({
                    operationId: crypto.randomUUID(),
                    projectId: project.id,
                    title: text.split('\n')[0].slice(0, 120),
                    prompt: text,
                  }),
                });
                window.location.assign(`/dashboard/tasks/${encodeURIComponent(task.id)}`);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Could not start a task.');
              }
            }}
          />
        </div>
        {error && <Banner kind="danger" title={error} />}
      </div>
      <section className="dl-section v2-project-start-push">
        <h2 className="dl-section-title">Or push code you have</h2>
        <p className="dl-section-sub">
          From the folder your code is in. Either way, {project.name} lives on deploy.local.
        </p>
        <div className="v2-project-start-term">
          <pre className="dl-term wrap">{commands}</pre>
          <CopyButton value={commands} label="Copy commands" />
        </div>
        {!overview.repository?.source?.location && (
          <p className="dl-meta">
            No remote. <a href={`${projectPath(project.id)}/settings`}>Add one in Settings</a> to
            keep a copy on GitHub in sync.
          </p>
        )}
      </section>
    </>
  );
}
