'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import { Empty, Icon, type IconName } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { getAuth } from '../../detail/shared';
import { useInbox } from '../data/hooks';
import { request, useData } from '../projects/data';
import { DesignCanvas, type Selection, type Tool, type View } from './Canvas';
import {
  bounds,
  fit,
  readTokens,
  sections as readSections,
  type Design,
  type Tokens,
} from './model';
import { LeftPanel, RightPanel, useChanges } from './Panels';
import './style.css';

const noTokens: Tokens = { colors: [], textStyles: [] };

/** Keep the page's place in the URL without a navigation, so a link opens the same board. */
function remember(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values))
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  window.history.replaceState(window.history.state, '', url);
}

export default function DesignPage() {
  const [params] = useSearchParams();
  const inbox = useInbox();
  const waiting = inbox.items.filter((item) => item.state === 'waiting');
  // Read after hydration: the server has no browser storage.
  const [owner, setOwner] = useState('');
  useEffect(() => setOwner(getAuth()?.username ?? ''), []);
  const projects = useData<{ projects: Project[] }>('/api/v2/projects');
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const project =
    projects.data?.projects.find((item) => item.id === projectId) ?? projects.data?.projects[0];
  const [ref, setRef] = useState(params.get('ref') ?? 'HEAD');
  const designPath = project
    ? `/api/v2/projects/${encodeURIComponent(project.id)}/design?ref=${encodeURIComponent(ref)}`
    : undefined;
  const design = useData<Design>(designPath);
  const canvas = design.data?.canvas ?? null;
  const base =
    project && design.data
      ? `/api/v2/projects/${encodeURIComponent(project.id)}/design/files/${design.data.commit}`
      : null;
  const tokensData = useData<unknown>(base ? `${base}/ds/deploy-local/tokens.json` : undefined);
  const tokens = useMemo(
    () => (tokensData.data ? readTokens(tokensData.data) : noTokens),
    [tokensData.data],
  );
  const changes = useChanges(project?.id, ref, design.data?.commit);
  const changed = useMemo(
    () =>
      new Set(
        changes
          .filter((change) => change.path.startsWith('design/boards/'))
          .map((change) => change.path.slice('design/boards/'.length)),
      ),
    [changes],
  );
  const sections = useMemo(() => (canvas ? readSections(canvas) : []), [canvas]);
  const [sectionId, setSectionId] = useState(params.get('page') ?? '');
  const section = sections.find((item) => item.id === sectionId) ?? sections[0] ?? null;
  const [selection, setSelection] = useState<Selection>(
    params.get('board') ? { board: params.get('board')!, layer: params.get('layer') } : null,
  );
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 0.25 });
  const [tool, setTool] = useState<Tool>('move');
  const [menu, setMenu] = useState(false);
  const [revision, setRevision] = useState(0);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const stage = useRef<HTMLDivElement>(null);

  const fitTo = useCallback(
    (files: string[]) => {
      const host = stage.current?.querySelector('.dz-canvas');
      if (!canvas || !host) return;
      setView(fit(bounds(canvas, files), host.clientWidth, host.clientHeight));
    },
    [canvas],
  );
  // Open on the page's boards, or the board a link named.
  const fitted = useRef('');
  useEffect(() => {
    if (!canvas || !section) return;
    const key = `${design.data?.commit}:${section.id}`;
    if (fitted.current === key) return;
    fitted.current = key;
    const named = selection && canvas.boards[selection.board] ? [selection.board] : section.boards;
    requestAnimationFrame(() => fitTo(named));
  }, [canvas, section, design.data?.commit, selection, fitTo]);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    remember({ board: next?.board ?? null, layer: next?.layer ?? null });
  }, []);
  const chooseSection = (id: string) => {
    setSectionId(id);
    remember({ page: id, board: null, layer: null });
    setSelection(null);
    const next = sections.find((item) => item.id === id);
    if (next) requestAnimationFrame(() => fitTo(next.boards));
  };
  const chooseRef = (next: string) => {
    setRef(next);
    setMenu(false);
    remember({ ref: next === 'HEAD' ? null : next });
  };
  const newBranch = async () => {
    setMenu(false);
    const name = window.prompt('Name the design branch', '');
    if (!name || !project) return;
    try {
      const { branch } = await request<{ branch: { name: string } }>(
        `/api/v2/projects/${encodeURIComponent(project.id)}/design/branches`,
        { method: 'POST', body: JSON.stringify({ name, from: design.data?.commit ?? 'HEAD' }) },
      );
      chooseRef(branch.name);
      design.refresh();
    } catch (error) {
      window.alert((error as Error).message);
    }
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (event.key === 'v' || event.key === 'V') setTool('move');
      if (event.key === 'h' || event.key === 'H') setTool('hand');
      if (event.key === 'Escape') select(null);
      if (event.shiftKey && event.key === '!' && section) fitTo(section.boards);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [section, fitTo, select]);

  const tools: { id: string; icon: IconName; label: string; menu?: boolean; ready?: boolean }[] = [
    { id: 'move', icon: 'move', label: 'Move  V', menu: true, ready: true },
    { id: 'frame', icon: 'frame', label: 'Board  F', menu: true },
    { id: 'shape', icon: 'shape', label: 'Shape  R', menu: true },
    { id: 'pen', icon: 'pen', label: 'Pen  P', menu: true },
    { id: 'text', icon: 'text', label: 'Text  T' },
    { id: 'sticky', icon: 'sticky', label: 'Sticky note  N' },
    { id: 'comment', icon: 'comment', label: 'Comment  C' },
    { id: 'ask', icon: 'spark', label: 'Ask an agent' },
  ];

  const empty = projects.data && !projects.data.projects.length;
  return (
    <div className={`dz${selection ? ' has-selection' : ''}`} ref={stage}>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
      />
      <div className="dz-narrow-bar">
        <a className="dl-icon-btn" href="/dashboard" aria-label="Back to deploy.local">
          <Icon name="back" />
        </a>
        <span className="dz-narrow-title">Designs</span>
        <label className="dz-narrow-page">
          <Icon name="layers" size={13} />
          <select
            value={section?.id ?? ''}
            onChange={(event) => chooseSection(event.target.value)}
            aria-label="Page"
          >
            {sections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <Icon name="down" size={12} />
        </label>
      </div>
      <LeftPanel
        projects={projects.data?.projects ?? []}
        project={project}
        onProject={(id) => {
          setProjectId(id);
          setRef('HEAD');
          setSelection(null);
          remember({ project: id, ref: null, board: null, layer: null, page: null });
        }}
        design={design.data}
        current={ref}
        sections={sections}
        section={section}
        onSection={chooseSection}
        selection={selection}
        select={select}
        base={base}
        changed={changed}
        waiting={waiting}
        menu={menu}
        setMenu={setMenu}
        onRef={chooseRef}
        onNewBranch={newBranch}
      />
      <div className="dz-stage">
        {empty ? (
          <Empty title="No projects yet">
            Add a project with a design/ folder to see its boards here.
          </Empty>
        ) : design.error ? (
          <Empty title="Couldn’t open the design">{design.error}</Empty>
        ) : design.data && !canvas ? (
          <Empty title="This project has no design yet">
            Add design/canvas.json and boards in design/boards to see them here.
          </Empty>
        ) : canvas && base ? (
          <DesignCanvas
            canvas={canvas}
            section={section}
            base={base}
            view={view}
            setView={setView}
            tool={tool}
            selection={selection}
            select={select}
            frames={frames}
            revision={revision}
            onFrameLoad={() => setRevision((n) => n + 1)}
          />
        ) : (
          <div className="dz-loading">Loading the design…</div>
        )}
        <div className="dz-toolbar" role="toolbar" aria-label="Tools">
          {tools.map((item, index) => (
            <span key={item.id} className="dz-tool-wrap">
              {index === 6 && <i className="dz-sep" />}
              <button
                type="button"
                className={`dz-tool${tool === item.id ? ' on' : ''}`}
                aria-label={item.ready ? item.label : `${item.label} (coming soon)`}
                aria-pressed={tool === item.id}
                title={item.ready ? item.label : `${item.label}: coming soon`}
                disabled={!item.ready}
                onClick={() => item.ready && setTool(item.id as Tool)}
              >
                <Icon name={item.icon} size={18} />
              </button>
              {item.menu && (
                <button
                  type="button"
                  className="dz-tool-more"
                  aria-label={
                    item.id === 'move' ? 'Hand  H' : `${item.label} options (coming soon)`
                  }
                  title={item.id === 'move' ? 'Hand  H' : undefined}
                  disabled={item.id !== 'move'}
                  onClick={() => setTool(tool === 'hand' ? 'move' : 'hand')}
                >
                  <Icon name={item.id === 'move' && tool === 'hand' ? 'hand' : 'down'} size={10} />
                </button>
              )}
            </span>
          ))}
          <i className="dz-sep" />
          <a
            className={`dz-tool${selection ? '' : ' disabled'}`}
            aria-label="View the board’s HTML"
            title="View the board’s HTML"
            href={
              selection && base
                ? `${base}/boards/${encodeURIComponent(selection.board)}`
                : undefined
            }
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="code" size={18} />
          </a>
        </div>
      </div>
      <RightPanel
        project={project}
        design={design.data}
        canvas={canvas}
        section={section}
        selection={selection}
        frames={frames}
        tokens={tokens}
        revision={revision}
        view={view}
        onZoom={(zoom) => {
          const host = stage.current?.querySelector('.dz-canvas');
          if (zoom === 'fit') return section && fitTo(section.boards);
          if (!host) return;
          const cx = host.clientWidth / 2;
          const cy = host.clientHeight / 2;
          setView((current) => ({
            z: zoom,
            x: cx - ((cx - current.x) * zoom) / current.z,
            y: cy - ((cy - current.y) * zoom) / current.z,
          }));
        }}
        changes={changes}
        select={select}
        owner={owner}
      />
      <div className={`dz-sheet-scrim${selection ? ' on' : ''}`} onClick={() => select(null)} />
    </div>
  );
}
