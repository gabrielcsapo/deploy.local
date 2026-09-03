'use client';

import { useLocation } from 'react-flight-router/client';

const JOURNEY = [
  { key: 'orient', label: 'Orient', detail: 'Understand Home, graphs, places, and authority.' },
  { key: 'define', label: 'Define', detail: 'Describe the complete application boundary.' },
  { key: 'deploy', label: 'Deploy', detail: 'Build a revision and make its routes healthy.' },
  { key: 'place', label: 'Place', detail: 'Choose the machines and sites that materialize it.' },
  { key: 'carry', label: 'Carry', detail: 'Prepare an admitted graph for disconnected work.' },
  { key: 'recover', label: 'Recover', detail: 'Reconcile, restore, and explain every decision.' },
] as const;

function activeStage(pathname: string) {
  if (pathname.includes('configuration')) return 'define';
  if (pathname.includes('deploying')) return 'deploy';
  if (pathname.includes('nodes') || pathname.includes('managing')) return 'place';
  if (pathname.includes('roadmap')) return 'carry';
  if (pathname.includes('troubleshooting')) return 'recover';
  return 'orient';
}

export function DocsJourneyRail() {
  const { pathname } = useLocation();
  const active = activeStage(pathname);

  return (
    <aside className="docs-journey" data-audit-docs-journey aria-label="Operator journey">
      <header>
        <span>Operator journey</span>
        <strong>The graph keeps your place.</strong>
      </header>
      <ol>
        {JOURNEY.map((stage) => (
          <li key={stage.key} className={stage.key === active ? 'is-active' : ''}>
            <i aria-hidden="true" />
            <div>
              <span>{stage.label}</span>
              <p>{stage.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="docs-mini-topology" aria-label="Topology legend">
        <span className="docs-mini-origin">Home</span>
        <span className="docs-mini-app">app graph</span>
        <span className="docs-mini-place">place</span>
        <span className="docs-mini-suitcase">suitcase</span>
      </div>
    </aside>
  );
}
