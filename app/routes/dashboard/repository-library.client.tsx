'use client';
import { Button, TextField, WorkspaceIcon } from '@/components/ui';
import { Link } from 'react-flight-router/client';
import { useLayoutEffect, useRef, useState } from 'react';
import { repositoryURL } from './repository-navigation';
import './repository-management.css';

type Row = Record<string, any>;
const memory = { query: '', filter: 'all', top: 0 };
export function RepositoryLibrary({
  projects,
  loaded,
  error,
  retry,
  create,
  unavailable = false,
}: {
  projects: Row[];
  loaded: boolean;
  error: string;
  retry: () => void;
  create: () => void;
  unavailable?: boolean;
}) {
  const [query, setQuery] = useState(memory.query);
  const [filter, setFilter] = useState(memory.filter);
  const scroll = useRef<HTMLDivElement>(null);
  const rows = projects
    .filter(
      (project) =>
        (filter === 'all' || (filter === 'imported') === !!project.sourcePath) &&
        `${project.name} ${project.description || ''} ${project.sourcePath || ''}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  useLayoutEffect(() => {
    if (loaded && scroll.current) scroll.current.scrollTop = memory.top;
  }, [loaded]);
  function resetReading() {
    memory.top = 0;
    if (scroll.current) scroll.current.scrollTop = 0;
  }
  return (
    <section
      className="pw-project-hub repository-workspace repository-library"
      aria-label="Repositories"
    >
      <aside className="ph-navigation ds-context-sidebar">
        <header className="ds-context-heading">
          <strong>Repositories</strong>
        </header>
        <nav className="ph-tabs ds-context-links" aria-label="Repository filters">
          {(
            [
              ['all', 'All repositories'],
              ['hosted', 'Hosted here'],
              ['imported', 'Imported'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              aria-current={filter === key ? 'page' : undefined}
              onClick={() => {
                setFilter(key);
                memory.filter = key;
                resetReading();
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <section className="ph-work ds-work-pane rm-pane" aria-label="Repository list">
        <header className="rm-toolbar">
          <div className="rm-search">
            <WorkspaceIcon name="search" />
            <TextField
              label="Search repositories"
              type="search"
              appearance="plain"
              placeholder="Search repositories…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                memory.query = event.target.value;
                resetReading();
              }}
            />
          </div>
          <Button variant="primary" onClick={create}>
            <WorkspaceIcon name="plus" />
            New repository
          </Button>
        </header>
        <div
          ref={scroll}
          className="rm-scroll"
          tabIndex={0}
          aria-label="Repositories"
          aria-busy={!loaded && !error}
          onScroll={(event) => {
            memory.top = event.currentTarget.scrollTop;
          }}
        >
          {unavailable ? (
            <div className="rm-feedback" role="alert">
              <strong>Repository unavailable</strong>
              <p>This repository was not found or you do not have access.</p>
              <Link to="/dashboard/repositories" className="ui-button">
                All repositories
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <div className="rm-feedback" role="alert">
                  <p>{error}</p>
                  <Button onClick={retry}>Retry</Button>
                </div>
              )}
              {!loaded && !error ? (
                <p className="ds-feedback" role="status">
                  Loading repositories…
                </p>
              ) : rows.length ? (
                <div className="rm-repository-list">
                  {rows.map((project) => (
                    <Link
                      key={project.id}
                      to={repositoryURL(project.id)}
                      className="rm-repository-row"
                    >
                      <WorkspaceIcon name="folder" />
                      <div>
                        <strong>{project.name}</strong>
                        {project.description && <p>{project.description}</p>}
                        <small>{project.sourcePath || 'Hosted on deploy.local'}</small>
                      </div>
                      <span className="rm-repository-state">
                        {project.repositoryStatus === 'ready' || !project.repositoryStatus
                          ? 'Ready'
                          : project.repositoryStatus === 'preparing'
                            ? 'Setting up'
                            : 'Needs attention'}
                      </span>
                      <WorkspaceIcon name="chevron-right" />
                    </Link>
                  ))}
                </div>
              ) : (
                loaded && (
                  <div className="rm-feedback" role="status">
                    <strong>
                      {projects.length ? 'No matching repositories' : 'No repositories yet'}
                    </strong>
                    <p>
                      {projects.length
                        ? 'Try a different search or filter.'
                        : 'Create a hosted repository or import an existing Git repository.'}
                    </p>
                    {projects.length ? (
                      <Button
                        onClick={() => {
                          setQuery('');
                          setFilter('all');
                          memory.query = '';
                          memory.filter = 'all';
                          resetReading();
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : (
                      <Button onClick={create}>New repository</Button>
                    )}
                  </div>
                )
              )}
            </>
          )}
        </div>
        {loaded && !unavailable && (
          <footer className="rm-status">
            {rows.length} {rows.length === 1 ? 'repository' : 'repositories'}
            {rows.length !== projects.length ? ` of ${projects.length}` : ''}
          </footer>
        )}
      </section>
    </section>
  );
}
