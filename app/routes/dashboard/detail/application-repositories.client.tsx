'use client';
import { useCallback, useEffect, useState } from 'react';
import { workspaceRequest } from '../command-journal';
import { WorkspaceIcon } from '../workspace-icon';
import { getAuth } from './shared';

type Project = { id: string; name: string };
export function ApplicationRepositoryTabs({ application }: { application: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState('Checking linked repositories…');
  const [choose, setChoose] = useState('');
  const api = useCallback(
    (path: string, body?: Record<string, any>) =>
      workspaceRequest(path, body, getAuth(), localStorage),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    setProjects([]);
    setChoose('');
    setStatus('Checking linked repositories…');
    const refresh = async () => {
      try {
        const data = await api(
          '/application-repositories?application=' + encodeURIComponent(application),
        );
        if (!cancelled) {
          setProjects(data.projects);
          setStatus(data.projects.length ? '' : 'No linked repository');
        }
      } catch {
        if (!cancelled) {
          setProjects([]);
          setStatus('Could not check linked repositories');
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, application]);
  return (
    <>
      {(
        [
          ['repository', 'Files', 'file'],
          ['issues', 'Issues', 'circle'],
          ['pulls', 'Pull requests', 'pull-request'],
        ] as const
      ).map(([tab, label, icon]) => (
        <button
          key={tab}
          type="button"
          className="application-repository-tab"
          aria-disabled={!projects.length}
          aria-label={status ? `${label}: ${status}` : label}
          title={status || label}
          onClick={() => {
            if (projects.length === 1) openRepository(projects[0], tab);
            else if (projects.length > 1) setChoose(tab);
          }}
        >
          <WorkspaceIcon name={icon} />
          <span>{label}</span>
        </button>
      ))}
      {choose && (
        <div className="application-repository-chooser" role="group" aria-label="Choose repository">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => {
                openRepository(project, choose);
                setChoose('');
              }}
            >
              {project.name}
            </button>
          ))}
          <button onClick={() => setChoose('')}>Cancel</button>
        </div>
      )}
    </>
  );
}

function openRepository(project: Project, initialTab: string) {
  window.dispatchEvent(
    new CustomEvent('deploy:open-project', { detail: { ...project, initialTab } }),
  );
}
