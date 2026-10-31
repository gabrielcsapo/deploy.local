'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Action, Icon, type IconName } from '@/components/ui';
import type { InboxItem, Project } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
import { useData } from '../projects/data';
import { layerElement, type Frames, type Selection, type View } from './Canvas';
import {
  boardName,
  colorToken,
  layerLabel,
  textStyle,
  type Canvas,
  type Design,
  type Section,
  type Tokens,
} from './model';

type LayerNode = { id: string; label: string; kind: IconName; children: LayerNode[] };

const components =
  /\bdl-(composer|btn|chip|seg|item|group|side|head|dock|panel|phone|tag|send|avatar|nav)\b/;
function kindOf(element: Element): IconName {
  const name = element.tagName.toLowerCase();
  if (name === 'svg') return 'vector';
  if (name === 'img') return 'image';
  if (components.test(element.getAttribute('class') ?? '')) return 'component';
  const ownText = [...element.childNodes].some(
    (node) => node.nodeType === 3 && node.textContent?.trim(),
  );
  if (ownText && !element.querySelector('[data-layer]')) return 'text';
  return element.children.length > 1 ? 'stack' : 'frame';
}
function tree(parent: Element): LayerNode[] {
  return [...parent.children].flatMap((element) => {
    const id = element.getAttribute('data-layer');
    if (!id) return tree(element);
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join(' ');
    return [
      {
        id,
        label: layerLabel(id, element.children.length ? own : (element.textContent ?? '')),
        kind: kindOf(element),
        children: element.tagName.toLowerCase() === 'svg' ? [] : tree(element),
      },
    ];
  });
}
const trees = new Map<string, LayerNode[]>();
function useLayerTree(url: string | null) {
  const [nodes, setNodes] = useState<LayerNode[] | null>(url ? (trees.get(url) ?? null) : null);
  useEffect(() => {
    if (!url) return setNodes(null);
    if (trees.has(url)) return setNodes(trees.get(url)!);
    let live = true;
    authenticatedFetch(url)
      .then((response) => (response.ok ? response.text() : ''))
      .then((html) => {
        const body = new DOMParser().parseFromString(html, 'text/html').body;
        const parsed = tree(body);
        trees.set(url, parsed);
        if (live) setNodes(parsed);
      })
      .catch(() => live && setNodes([]));
    return () => {
      live = false;
    };
  }, [url]);
  return nodes;
}
/** The chain of layers from the board down to one layer. */
function pathTo(nodes: LayerNode[], id: string): LayerNode[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const below = pathTo(node.children, id);
    if (below) return [node, ...below];
  }
  return null;
}

function Row({
  depth,
  icon,
  label,
  meta,
  on,
  inside,
  open,
  onToggle,
  onClick,
  children,
}: {
  depth: number;
  icon: IconName;
  label: string;
  meta?: ReactNode;
  on?: boolean;
  inside?: boolean;
  open?: boolean;
  onToggle?: () => void;
  onClick: () => void;
  children?: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) row.current?.scrollIntoView({ block: 'nearest' });
  }, [on]);
  return (
    <>
      <div
        ref={row}
        className={`dz-row${on ? ' on' : ''}${inside ? ' inside' : ''}${icon === 'component' ? ' component' : ''}`}
        style={{ paddingLeft: `calc(var(--ds-space-2) + ${depth} * var(--ds-space-4))` }}
        role="treeitem"
        aria-selected={on}
        aria-expanded={onToggle ? open : undefined}
        tabIndex={on ? 0 : -1}
        onClick={onClick}
      >
        <span
          className="dz-twisty"
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
        >
          {onToggle && <Icon name={open ? 'down' : 'chevron'} size={10} />}
        </span>
        <Icon name={icon} size={13} />
        <span className="dz-t">{label}</span>
        {meta}
      </div>
      {open && children}
    </>
  );
}

function BoardLayers({
  file,
  url,
  selection,
  select,
  changed,
}: {
  file: string;
  url: string;
  selection: Selection;
  select: (selection: Selection) => void;
  changed: boolean;
}) {
  const here = selection?.board === file;
  const [open, setOpen] = useState(here);
  const nodes = useLayerTree(open || here ? url : null);
  const path = useMemo(
    () => (here && selection?.layer && nodes ? (pathTo(nodes, selection.layer) ?? []) : []),
    [here, selection?.layer, nodes],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!here) return;
    setOpen(true);
    if (path.length)
      setExpanded((current) => new Set([...current, ...path.slice(0, -1).map((node) => node.id)]));
  }, [here, path]);
  const render = (list: LayerNode[], depth: number): ReactNode =>
    list.map((node) => (
      <Row
        key={node.id}
        depth={depth}
        icon={node.kind}
        label={node.label}
        on={here && selection?.layer === node.id}
        inside={here}
        open={expanded.has(node.id)}
        onToggle={
          node.children.length
            ? () =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
            : undefined
        }
        onClick={() => select({ board: file, layer: node.id })}
      >
        {render(node.children, depth + 1)}
      </Row>
    ));
  return (
    <Row
      depth={0}
      icon="frame"
      label={boardName(file)}
      meta={changed ? <span className="dz-dot" aria-label="Changed on this branch" /> : undefined}
      on={here && !selection?.layer}
      inside={here}
      open={open}
      onToggle={() => setOpen(!open)}
      onClick={() => select({ board: file, layer: null })}
    >
      {nodes ? render(nodes, 1) : <div className="dz-row muted">Loading layers…</div>}
    </Row>
  );
}

export function DesignMenu({
  open,
  onClose,
  waiting,
  branches,
  current,
  onRef,
  onNewBranch,
}: {
  open: boolean;
  onClose: () => void;
  waiting: InboxItem[];
  branches: Design['branches'];
  current: string;
  onRef: (ref: string) => void;
  onNewBranch: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={menu} className="dl-menu dz-menu" role="menu">
      <a className="dl-menu-item" role="menuitem" href="/dashboard">
        <Icon name="back" size={14} />
        Back to deploy.local
      </a>
      <div className="dz-menu-label">Waiting on you · {waiting.length}</div>
      {waiting.slice(0, 5).map((item) => (
        <a
          key={item.id}
          className="dl-menu-item"
          role="menuitem"
          href={`/dashboard/inbox?item=${encodeURIComponent(item.id)}`}
        >
          <span className="dz-attn" />
          <span className="dz-t">{item.title}</span>
        </a>
      ))}
      {!waiting.length && <div className="dz-menu-empty">Nothing needs you.</div>}
      <hr />
      <button type="button" className="dl-menu-item" role="menuitem" onClick={onNewBranch}>
        <Icon name="branch" size={14} />
        New design branch
      </button>
      <button
        type="button"
        className={`dl-menu-item${current === 'HEAD' ? ' on' : ''}`}
        role="menuitemradio"
        aria-checked={current === 'HEAD'}
        onClick={() => onRef('HEAD')}
      >
        <Icon name="layers" size={14} />
        View main
      </button>
      {branches.map((branch) => (
        <button
          key={branch.name}
          type="button"
          className={`dl-menu-item${current === branch.name ? ' on' : ''}`}
          role="menuitemradio"
          aria-checked={current === branch.name}
          onClick={() => onRef(branch.name)}
        >
          <Icon name="branch" size={14} />
          <span className="dz-t">{branch.name}</span>
        </button>
      ))}
      <hr />
      <a className="dl-menu-item" role="menuitem" href="/dashboard/settings">
        <Icon name="settings" size={14} />
        Preferences
      </a>
    </div>
  );
}

export function LeftPanel({
  projects,
  project,
  onProject,
  design,
  current,
  sections,
  section,
  onSection,
  selection,
  select,
  base,
  changed,
  waiting,
  menu,
  setMenu,
  onRef,
  onNewBranch,
}: {
  projects: Project[];
  project: Project | undefined;
  onProject: (id: string) => void;
  design: Design | undefined;
  current: string;
  sections: Section[];
  section: Section | null;
  onSection: (id: string) => void;
  selection: Selection;
  select: (selection: Selection) => void;
  base: string | null;
  changed: Set<string>;
  waiting: InboxItem[];
  menu: boolean;
  setMenu: (open: boolean) => void;
  onRef: (ref: string) => void;
  onNewBranch: () => void;
}) {
  const [allPages, setAllPages] = useState(false);
  const shown = allPages ? sections : sections.slice(0, 6);
  return (
    <aside className="dz-left" aria-label="Design navigation">
      <div className="dz-left-top">
        <div className="dz-menu-row">
          <button
            type="button"
            className={`dz-mark${menu ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <span className="dl-mark">d</span>
            <Icon name="down" size={12} />
            {waiting.length > 0 && <span className="dz-badge">{waiting.length}</span>}
          </button>
        </div>
        <DesignMenu
          open={menu}
          onClose={() => setMenu(false)}
          waiting={waiting}
          branches={design?.branches ?? []}
          current={current}
          onRef={onRef}
          onNewBranch={onNewBranch}
        />
        <label className="dz-file">
          <select
            value={project?.id ?? ''}
            onChange={(event) => onProject(event.target.value)}
            aria-label="Project"
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <Icon name="down" size={12} />
        </label>
        <span className="dz-branch">
          <Icon name="branch" size={11} />
          {current === 'HEAD' ? 'main' : current}
          {changed.size > 0 && ` · ${changed.size} changed`}
        </span>
      </div>
      <div className="dz-tabs" role="tablist">
        <button type="button" role="tab" aria-selected className="on">
          File
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          title="Assets arrive with building from components"
        >
          Assets
        </button>
      </div>
      <div className="dz-group-h">
        <Icon name="down" size={10} />
        Pages
      </div>
      <div className="dz-pages" role="listbox" aria-label="Pages">
        {shown.map((item) => (
          <Row
            key={item.id}
            depth={0}
            icon="frame"
            label={item.title}
            meta={<span className="dz-meta">{item.boards.length}</span>}
            on={item.id === section?.id}
            onClick={() => onSection(item.id)}
          />
        ))}
        {sections.length > 6 && (
          <button type="button" className="dz-more" onClick={() => setAllPages(!allPages)}>
            {allPages ? 'Fewer' : `${sections.length - 6} more`}
          </button>
        )}
      </div>
      <div className="dz-group-h">
        <Icon name="down" size={10} />
        Layers
      </div>
      <div className="dz-layers" role="tree" aria-label="Layers">
        {base &&
          section?.boards.map((file) => (
            <BoardLayers
              key={`${base}/${file}`}
              file={file}
              url={`${base}/boards/${encodeURIComponent(file)}`}
              selection={selection}
              select={select}
              changed={changed.has(file)}
            />
          ))}
      </div>
    </aside>
  );
}

function Prop({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`dz-prop${children ? '' : ' empty'}`}>
      <div className="dz-prop-h">
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}
function Field({
  label,
  children,
  wide,
}: {
  label?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`dz-field${wide ? ' wide' : ''}`}>
      {label !== undefined && <span className="dz-l">{label}</span>}
      <span className="dz-v">{children}</span>
    </div>
  );
}
const px = (value: string) => Math.round(parseFloat(value) * 10) / 10;
const later = <Icon name="plus" size={14} />;

function Swatch({ color }: { color: string }) {
  return <span className="dz-swatch" style={{ background: color }} />;
}

function LayerProps({ element, tokens }: { element: HTMLElement; tokens: Tokens }) {
  const view = element.ownerDocument.defaultView!;
  const style = view.getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const kind = kindOf(element);
  const text = kind === 'text';
  const fill = text ? style.color : style.backgroundColor;
  const fillToken = colorToken(fill, tokens);
  const visibleFill = !/rgba\(0, 0, 0, 0\)|transparent/.test(fill);
  const typeStyle = textStyle(
    px(style.fontSize),
    px(style.lineHeight),
    Number(style.fontWeight),
    tokens,
  );
  const flex = style.display.includes('flex');
  const border = px(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none';
  return (
    <>
      <Prop title="Position">
        <div className="dz-grid">
          <Field label="X">{Math.round(box.left)}</Field>
          <Field label="Y">{Math.round(box.top)}</Field>
          <Field label="↻">{style.rotate === 'none' ? '0°' : style.rotate}</Field>
        </div>
      </Prop>
      <Prop
        title={
          flex
            ? `Layout · ${style.flexDirection.startsWith('column') ? 'vertical' : 'horizontal'} stack`
            : 'Layout'
        }
      >
        <div className="dz-grid">
          <Field label="W">{Math.round(box.width)}</Field>
          <Field label="H">{Math.round(box.height)}</Field>
          {flex && <Field label="Gap">{px(style.rowGap) || px(style.columnGap)}</Field>}
          {flex && (
            <Field label="Pad">
              {[style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
                .map(px)
                .join(' ')}
            </Field>
          )}
        </div>
      </Prop>
      <Prop title="Appearance">
        <div className="dz-grid">
          <Field label="Opacity">{Math.round(Number(style.opacity) * 100)}%</Field>
          <Field label="Radius">{px(style.borderTopLeftRadius)}</Field>
        </div>
      </Prop>
      {text && (
        <Prop title="Typography">
          <Field wide>
            {typeStyle ? <span className="dz-chip">Aa {typeStyle}</span> : null}
            <span className="dz-meta">
              {style.fontFamily.split(',')[0].replace(/"/g, '')} · {style.fontWeight} ·{' '}
              {px(style.fontSize)}/{px(style.lineHeight)}
            </span>
          </Field>
          <Field label="Align" wide>
            {style.textAlign === 'start' ? 'left' : style.textAlign}
          </Field>
        </Prop>
      )}
      <Prop title="Fill" actions={later}>
        {visibleFill && (
          <Field wide>
            {fillToken ? (
              <span className="dz-chip">
                <Swatch color={fill} />
                {fillToken}
              </span>
            ) : (
              <>
                <Swatch color={fill} />
                {fill}
              </>
            )}
          </Field>
        )}
      </Prop>
      <Prop title="Stroke" actions={later}>
        {border && (
          <Field wide>
            <Swatch color={style.borderTopColor} />
            {colorToken(style.borderTopColor, tokens) ?? style.borderTopColor} ·{' '}
            {px(style.borderTopWidth)}
          </Field>
        )}
      </Prop>
      <Prop title="Effects" actions={later}>
        {style.boxShadow !== 'none' && <Field wide>Shadow</Field>}
      </Prop>
      <Prop title="Export" actions={later} />
    </>
  );
}

export function RightPanel({
  project,
  design,
  canvas,
  section,
  selection,
  frames,
  tokens,
  revision,
  view,
  onZoom,
  changes,
  select,
  owner,
  tab,
  setTab,
  commentCount,
  comments,
  agent,
  onAsk,
}: {
  project: Project | undefined;
  design: Design | undefined;
  canvas: Canvas | null;
  section: Section | null;
  selection: Selection;
  frames: Frames;
  tokens: Tokens;
  revision: number;
  view: View;
  onZoom: (zoom: 'fit' | number) => void;
  changes: { status: string; path: string }[];
  select: (selection: Selection) => void;
  owner: string;
  tab: 'edit' | 'comments';
  setTab: (tab: 'edit' | 'comments') => void;
  commentCount: number;
  comments: ReactNode;
  /** While an agent's branch is open, its panel replaces Edit. */
  agent: ReactNode;
  onAsk: () => void;
}) {
  const [zoomMenu, setZoomMenu] = useState(false);
  void revision;
  const element = selection?.layer ? layerElement(frames, selection.board, selection.layer) : null;
  const board = selection ? canvas?.boards[selection.board] : undefined;
  const kind = element ? kindOf(element) : null;
  const kindName = {
    text: 'Text',
    vector: 'Vector',
    image: 'Image',
    component: 'Component',
    stack: 'Stack',
    frame: 'Frame',
  } as Record<string, string>;
  let crumb: string[] = [];
  if (element) {
    let at: Element | null = element.parentElement;
    while (at && at.tagName !== 'BODY') {
      const id = at.getAttribute('data-layer');
      if (id) crumb.unshift(layerLabel(id, ''));
      at = at.parentElement;
    }
    crumb = [boardName(selection!.board), ...crumb.slice(-2)];
  }
  return (
    <aside className="dz-right" aria-label="Edit">
      <span className="dz-grab" aria-hidden="true" />
      <div className="dz-right-top">
        <span className="dl-avatar" title={owner}>
          {owner.slice(0, 1).toUpperCase()}
        </span>
        <span className="dl-grow" />
        <button type="button" className="dl-icon-btn" aria-label="Play (coming soon)" disabled>
          <Icon name="play" size={14} />
        </button>
        <Action variant="primary" disabled title="Proposing for review arrives with design review">
          Propose
        </Action>
      </div>
      <div className="dz-right-tabs">
        <div className="dz-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'edit'}
            className={tab === 'edit' ? 'on' : ''}
            onClick={() => setTab('edit')}
          >
            {agent ? 'Agent' : 'Edit'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'comments'}
            className={tab === 'comments' ? 'on' : ''}
            onClick={() => setTab('comments')}
          >
            Comments
            {commentCount > 0 && <span className="dz-count">{commentCount}</span>}
          </button>
        </div>
        <span className="dl-grow" />
        <div className="dz-zoom">
          <button
            type="button"
            className="dz-zoom-btn"
            aria-haspopup="menu"
            aria-expanded={zoomMenu}
            onClick={() => setZoomMenu(!zoomMenu)}
          >
            {Math.round(view.z * 100)}% <Icon name="down" size={11} />
          </button>
          {zoomMenu && (
            <div className="dl-menu dz-zoom-menu" role="menu" onClick={() => setZoomMenu(false)}>
              <button type="button" className="dl-menu-item" onClick={() => onZoom('fit')}>
                Zoom to fit
              </button>
              {[0.5, 1, 2].map((zoom) => (
                <button
                  key={zoom}
                  type="button"
                  className="dl-menu-item"
                  onClick={() => onZoom(zoom)}
                >
                  {zoom * 100}%
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="dz-right-body">
        {tab === 'comments' ? (
          comments
        ) : agent ? (
          agent
        ) : selection && element ? (
          <>
            <div className="dz-sel">
              <b className="dz-sel-kind">
                {kindName[kind!]}
                <button
                  type="button"
                  className="dl-icon-btn"
                  aria-label="Ask an agent  ⌘K"
                  title="Ask an agent  ⌘K"
                  onClick={onAsk}
                >
                  <Icon name="spark" size={14} />
                </button>
              </b>
              <span className="dz-crumb">{crumb.join(' › ')}</span>
            </div>
            <LayerProps element={element} tokens={tokens} />
          </>
        ) : selection && board ? (
          <>
            <div className="dz-sel">
              <b>Board</b>
              <span className="dz-crumb">
                {section?.title} › {boardName(selection.board)}
              </span>
            </div>
            <Prop title="Layout">
              <div className="dz-grid">
                <Field label="W">{board.w}</Field>
                <Field label="H">{board.h}</Field>
              </div>
            </Prop>
            <Prop title="Widths">
              <span className="dz-meta">
                {board.w <= 500 ? `Phone at ${board.w}` : 'Web at 1440 and 700'}
              </span>
            </Prop>
            <Prop title="Export" actions={later}>
              {project && design && (
                <div className="dz-links">
                  {(board.w <= 500 ? [board.w] : [1440, 700]).map((width) => (
                    <a
                      key={width}
                      href={`/api/v2/projects/${encodeURIComponent(project.id)}/design/render?ref=${design.commit}&board=${encodeURIComponent(selection.board)}&width=${width}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PNG at {width}
                    </a>
                  ))}
                </div>
              )}
            </Prop>
          </>
        ) : (
          <>
            <Prop
              title="Changes on this branch"
              actions={<span className="dz-meta">{changes.length}</span>}
            >
              {changes.length ? (
                <div className="dz-list">
                  {changes.map((change) => {
                    const file = change.path.replace(/^design\/boards\//, '');
                    const isBoard = change.path.startsWith('design/boards/');
                    return (
                      <button
                        key={change.path}
                        type="button"
                        className="dz-list-item"
                        disabled={!isBoard || !canvas?.boards[file]}
                        onClick={() => select({ board: file, layer: null })}
                      >
                        <span className="dz-dot" />
                        <span className="dz-t">
                          {isBoard ? boardName(file) : change.path.replace(/^design\//, '')}
                        </span>
                        <span className="dz-meta">{change.status}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <span className="dz-meta">
                  Nothing yet. This is the design on {design?.ref === 'HEAD' ? 'main' : design?.ref}
                  .
                </span>
              )}
            </Prop>
            <Prop title="Local tokens">
              <div className="dz-tokens">
                {tokens.colors.slice(0, 12).map((token) => (
                  <span key={token.name} className="dz-token" title={token.usage}>
                    <Swatch color={token.light} />
                    {token.name}
                  </span>
                ))}
              </div>
            </Prop>
            <Prop title="Text styles">
              <div className="dz-list">
                {tokens.textStyles.map((style) => (
                  <div key={style.name} className="dz-list-item static">
                    <span className="dz-t">{style.name}</span>
                    <span className="dz-meta">
                      {style.size}/{style.lineHeight} · {style.weight}
                    </span>
                  </div>
                ))}
              </div>
            </Prop>
          </>
        )}
      </div>
    </aside>
  );
}

export function useChanges(projectId: string | undefined, ref: string, commit: string | undefined) {
  const { data } = useData<{ files: { status: string; path: string }[] }>(
    projectId && commit
      ? `/api/v2/projects/${encodeURIComponent(projectId)}/design/changes?ref=${encodeURIComponent(ref)}`
      : undefined,
  );
  return data?.files ?? [];
}
