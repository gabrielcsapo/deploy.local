'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon, IconButton } from '../../components/ui/v2/shared';
import { docs, docPath, groups, searchDocs, type Doc } from './content';
import './style.css';

function Contents({ doc }: { doc: Doc }) {
  return (
    <nav aria-label="On this page">
      {doc.sections.map((entry) => (
        <a key={entry.id} href={`#${entry.id}`}>
          {entry.toc || entry.title}
        </a>
      ))}
    </nav>
  );
}

export function DocsScreen({ slug }: { slug: string }) {
  const doc = docs.find((entry) => entry.slug === slug)!;
  const index = docs.indexOf(doc);
  const previous = docs[index - 1];
  const next = docs[index + 1];
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const results = searchDocs(query);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMenuOpen(true);
        requestAnimationFrame(() => input.current?.focus());
      }
      if (event.key === 'Escape') {
        setQuery('');
        setMenuOpen(false);
        if (window.matchMedia('(max-width: 899px)').matches) menu.current?.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  return (
    <div className="dl-sheet docs-v2">
      <title>{`${doc.title} · deploy.local docs`}</title>
      <a className="docs-v2-skip" href="#docs-article">
        Skip to article
      </a>
      <header className="docs-v2-header">
        <div className="docs-v2-topbar">
          <a className="docs-v2-brand" href="/">
            <span className="dl-mark">d</span>
            <span>deploy.local</span>
          </a>
          <nav className="docs-v2-public" aria-label="Site">
            <a href="/docs" aria-current="true">
              Docs
            </a>
            <a href="/changelog">Changelog</a>
            <a href="https://github.com/gabrielcsapo/deploy.local">Source</a>
          </nav>
          <a className="dl-btn secondary docs-v2-signin" href="/dashboard">
            Sign in
          </a>
          <button
            ref={menu}
            type="button"
            className="dl-icon-btn docs-v2-menu"
            aria-label={menuOpen ? 'Close docs menu' : 'Open docs menu'}
            aria-expanded={menuOpen}
            aria-controls="docs-navigation"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name={menuOpen ? 'close' : 'menu'} />
          </button>
        </div>
      </header>
      <div className="docs-v2-breadcrumb">
        <a href="/docs">{doc.group}</a>
        <span aria-hidden="true">›</span>
        <span>{doc.title}</span>
      </div>
      <div className="docs-v2-layout">
        <aside id="docs-navigation" className={`docs-v2-sidebar ${menuOpen ? 'is-open' : ''}`}>
          <form role="search" onSubmit={(event) => event.preventDefault()}>
            <div className="docs-v2-search dl-field">
              <Icon name="search" size={14} />
              <input
                ref={input}
                aria-label="Search docs"
                type="search"
                placeholder="Search docs"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-controls="docs-search-results"
              />
              {!query && <kbd>⌘K</kbd>}
            </div>
          </form>
          {query.trim() ? (
            <div id="docs-search-results" className="docs-v2-results">
              <p className="dl-meta" role="status">
                {results.length ? `${results.length} results` : 'No matching titles or headings.'}
              </p>
              {results.map((result) => (
                <a
                  key={result.href}
                  href={result.href}
                  onClick={() => {
                    setMenuOpen(false);
                    setQuery('');
                  }}
                >
                  <span>{result.title}</span>
                  <small>{result.detail}</small>
                </a>
              ))}
              <IconButton
                icon="close"
                label="Clear search"
                onClick={() => {
                  setQuery('');
                  input.current?.focus();
                }}
              />
            </div>
          ) : (
            <nav aria-label="Docs">
              {groups.map((group) => (
                <section key={group}>
                  <h2>{group}</h2>
                  {docs
                    .filter((entry) => entry.group === group)
                    .map((entry) => (
                      <a
                        key={entry.slug}
                        href={docPath(entry.slug)}
                        aria-current={entry.slug === slug ? 'page' : undefined}
                      >
                        {entry.title}
                      </a>
                    ))}
                </section>
              ))}
            </nav>
          )}
          <nav className="docs-v2-mobile-links" aria-label="Site menu">
            <a href="/changelog">Changelog</a>
            <a href="https://github.com/gabrielcsapo/deploy.local">Source</a>
            <a href="/dashboard">Sign in</a>
          </nav>
        </aside>
        <main
          id="docs-article"
          className={`docs-v2-article ${slug === '' ? 'docs-v2-home' : ''}`}
          tabIndex={-1}
        >
          <span className="dl-meta docs-v2-category">{doc.group}</span>
          <h1>{doc.title}</h1>
          <p className="docs-v2-intro">{doc.intro}</p>
          <details className="docs-v2-mobile-contents">
            <summary>
              On this page
              <Icon name="down" size={14} />
            </summary>
            <Contents doc={doc} />
          </details>
          {doc.sections.map((entry, position) => (
            <section
              key={entry.id}
              id={entry.id}
              className={slug === '' && position < 4 ? 'docs-v2-start-step' : undefined}
            >
              {slug === '' && position < 4 && (
                <span className="docs-v2-number" aria-hidden="true">
                  {position + 1}
                </span>
              )}
              <div>
                <h2>{entry.title}</h2>
                {entry.body}
              </div>
            </section>
          ))}
          <nav className="docs-v2-pagination" aria-label="Previous and next pages">
            {previous && (
              <a rel="prev" href={docPath(previous.slug)}>
                ← {previous.title}
              </a>
            )}
            {next && (
              <a rel="next" href={docPath(next.slug)}>
                {next.title} →
              </a>
            )}
          </nav>
          <a
            className="docs-v2-edit"
            href="https://github.com/gabrielcsapo/deploy.local/edit/main/app/routes/docs/content.tsx"
          >
            Edit this page on GitHub
          </a>
        </main>
        <aside className="docs-v2-contents">
          <div className="dl-meta">On this page</div>
          <Contents doc={doc} />
        </aside>
      </div>
    </div>
  );
}
