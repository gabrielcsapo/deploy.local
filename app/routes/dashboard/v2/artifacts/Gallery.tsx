'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import { Banner, Group, Icon, ListTemplate, Skeleton, Tabs } from '@/components/ui';
import type { ArtifactKind, ArtifactSummary } from '../../../../../shared/v2/artifacts';
import type { Interaction } from '../../../../../packages/trace/interaction';
import { startScreenOpen } from '../projects/interaction';
import { useData } from '../projects/data';
import { NewArtifact } from './NewArtifact';
import { artifactHref, artifactMeta, galleryPath, galleryTab, shown, stateLabel } from './model';

export type Gallery = {
  artifacts: ArtifactSummary[];
  projects: { id: string; name: string }[];
};

const kinds: { kind: ArtifactKind; label: string; icon: 'layers' | 'file' }[] = [
  { kind: 'design', label: 'Design', icon: 'layers' },
  { kind: 'document', label: 'Document', icon: 'file' },
];

/** A document's mark: a page with lines, as the board draws it. */
export function DocumentIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  );
}

export function Gallery() {
  const [params, setParams] = useSearchParams();
  const tab = galleryTab(params.get('kind'));
  const making = params.get('new');
  const open = useRef<Interaction | undefined>(undefined);
  useEffect(() => {
    const trace = startScreenOpen(galleryPath, 'screen.artifacts.open');
    if (!trace) return;
    open.current = trace.open;
    window.addEventListener('pagehide', trace.pageLeft);
    return () => {
      window.removeEventListener('pagehide', trace.pageLeft);
      trace.open.finish('navigation.left', 'cancelled');
      open.current = undefined;
    };
  }, []);
  const gallery = useData<Gallery>('/api/artifacts', { open, traceFirstResult: true });
  useEffect(() => {
    const interaction = open.current;
    if (!interaction || (!gallery.data && !gallery.error)) return;
    const frame = requestAnimationFrame(() => {
      if (gallery.data) interaction.finish('gallery.visible');
      else interaction.finish('gallery.failed', 'error');
      open.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [gallery.data, gallery.error]);
  const [kind, setKind] = useState<ArtifactKind | null>(null);
  useEffect(() => {
    if (making === 'design' || making === 'document') setKind(making);
  }, [making]);
  const close = () => {
    setKind(null);
    if (making) {
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next);
    }
  };
  const artifacts = gallery.data?.artifacts ?? [];
  const list = shown(artifacts, tab);
  const href = (value: string) => (value === 'all' ? galleryPath : `${galleryPath}?kind=${value}`);
  return (
    <ListTemplate
      title="Artifacts"
      description="Designs and documents kept in your projects. You approve what reaches main."
      headerActions={
        <a className="dl-link" href="/dashboard/inbox">
          Waiting on you
        </a>
      }
      className="af-page"
    >
      <section>
        <p className="af-label">Make something new</p>
        <div className="af-new">
          {kinds.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className={`af-kind${kind === entry.kind ? ' on' : ''}`}
              aria-haspopup="dialog"
              onClick={() => setKind(entry.kind)}
            >
              <i>{entry.icon === 'file' ? <DocumentIcon /> : <Icon name="layers" size={24} />}</i>
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
      </section>
      {gallery.error && !gallery.data && <Banner kind="danger" title={gallery.error} />}
      {!gallery.data && !gallery.error ? (
        <Skeleton rows={3} label="Loading artifacts" />
      ) : gallery.data && !artifacts.length ? (
        <Group>
          <div className="dl-empty">
            <span className="dl-glyph">
              <Icon name="layers" size={20} />
            </span>
            <h3>No artifacts yet</h3>
            <p>
              An artifact is a design or a document kept in a project’s repository. Pick a kind
              above to make the first one.
            </p>
          </div>
        </Group>
      ) : gallery.data ? (
        <section>
          <Tabs
            label="Kinds"
            value={href(tab)}
            items={[
              { label: 'All', href: href('all') },
              { label: 'Designs', href: href('designs') },
              { label: 'Documents', href: href('documents') },
            ]}
          />
          <div className="af-grid">
            {list.map((entry) => (
              <a
                key={`${entry.projectId}:${entry.artifact ?? ''}`}
                href={artifactHref(entry)}
                className="af-card"
              >
                <span className="af-thumb">
                  {entry.state && <span className="dl-tag">{stateLabel[entry.state]}</span>}
                  {entry.kind === 'design' ? (
                    <span className="af-canvas" aria-hidden="true">
                      {[0, 1, 2].map((index) => (
                        <b key={index} className={index === 2 ? 'phone' : undefined}>
                          <u className="h" />
                          <u />
                          <u className="s" />
                          {index < 2 && <u className="xs" />}
                        </b>
                      ))}
                    </span>
                  ) : (
                    <span className="af-sheet" aria-hidden="true">
                      <u className="h" />
                      <u />
                      <u />
                      <u className="s" />
                      <u />
                      <u className="xs" />
                    </span>
                  )}
                </span>
                <span className="af-foot">
                  <span className="af-t">
                    <span>{entry.name}</span>
                    <span className="dl-meta">{artifactMeta(entry)}</span>
                  </span>
                </span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
      <NewArtifact kind={kind} projects={gallery.data?.projects ?? []} onClose={close} />
    </ListTemplate>
  );
}
