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
  hex,
  isWrapper,
  layerFacts,
  layerName,
  layerPath,
  textStyle,
  type Canvas,
  type Design,
  type LayerChange,
  type Section,
  type Tokens,
} from './model';

type LayerNode = { id: string; label: string; kind: IconName; children: LayerNode[] };

const components =
  /\bdl-(composer|btn|chip|seg|item|group|side|head|dock|panel|phone|tag|send|avatar|nav)\b/;
// What the drawing tools make, by the name they give it.
const drawnKinds: Record<string, IconName> = {
  Rectangle: 'shape',
  Ellipse: 'ellipse',
  Line: 'line',
  Vector: 'vector',
  Frame: 'frame',
  Text: 'text',
};
function kindOf(element: Element): IconName {
  const drawn = drawnKinds[element.getAttribute('data-name') ?? ''];
  if (drawn) return drawn;
  // An instance of a design-system component, placed from Assets.
  if (element.hasAttribute('data-component')) return 'component';
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
// Drawn layers float above the board's flow, so like Figma's they list first, newest on top.
const floating = (element: Element) =>
  /position:\s*absolute/.test(element.getAttribute('style') ?? '');
function tree(parent: Element): LayerNode[] {
  const all = [...parent.children];
  const ordered = [...all.filter(floating).reverse(), ...all.filter((e) => !floating(e))];
  return ordered.flatMap((element) => {
    const id = element.getAttribute('data-layer');
    if (!id) return tree(element);
    const facts = layerFacts(element);
    const children = element.tagName.toLowerCase() === 'svg' ? [] : tree(element);
    // Like Figma's, Layers shows what people name, not every wrapper around it.
    if (isWrapper(facts)) return children;
    return [{ id, label: layerName(facts), kind: kindOf(element), children }];
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

function AgentMark() {
  return (
    <span className="dz-agent-mark" aria-label="An agent is working here">
      <Icon name="spark" size={9} />
    </span>
  );
}

function BoardLayers({
  file,
  url,
  selection,
  select,
  changed,
  inReview,
  agentAt,
}: {
  file: string;
  url: string;
  selection: Selection;
  select: (selection: Selection) => void;
  changed: boolean;
  inReview: boolean;
  /** Layers an agent is working on in this board; null means the board itself. */
  agentAt: Set<string | null>;
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
        meta={agentAt.has(node.id) ? <AgentMark /> : undefined}
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
      meta={
        <>
          {inReview && <span className="dz-review">In review</span>}
          {agentAt.size > 0 && <AgentMark />}
          {changed && <span className="dz-dot" aria-label="Changed on this branch" />}
        </>
      }
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

/** How long ago, the way the sidebar says it: now, 4m, 2h, 3d. */
function since(at: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
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
  const [switching, setSwitching] = useState(false);
  const [keys, setKeys] = useState(false);
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
          <span className="dz-menu-end">{since(item.createdAt)}</span>
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
      <button
        type="button"
        className="dl-menu-item"
        role="menuitem"
        aria-expanded={switching}
        onClick={() => setSwitching(!switching)}
      >
        <Icon name="branch" size={14} />
        Switch branch…
        <span className="dz-menu-end">{branches.length} open</span>
      </button>
      {switching &&
        branches.map((branch) => (
          <button
            key={branch.name}
            type="button"
            className={`dl-menu-item${current === branch.name ? ' on' : ''}`}
            role="menuitemradio"
            aria-checked={current === branch.name}
            onClick={() => onRef(branch.name)}
          >
            <span className="dz-menu-indent" />
            <span className="dz-t">{branch.name}</span>
          </button>
        ))}
      <hr />
      <button
        type="button"
        className="dl-menu-item"
        role="menuitem"
        aria-expanded={keys}
        onClick={() => setKeys(!keys)}
      >
        <Icon name="keyboard" size={14} />
        Keyboard shortcuts
        <span className="dz-menu-end">?</span>
      </button>
      {keys && (
        <dl className="dz-keys">
          {[
            ['V', 'Move'],
            ['H or Space', 'Hand'],
            ['C', 'Comment'],
            ['⌘K', 'Ask an agent'],
            ['⌘ scroll or pinch', 'Zoom'],
            ['Shift 1', 'Zoom to the page'],
            ['⌘\\', 'Hide panels'],
            ['Esc', 'Clear the selection'],
          ].map(([key, what]) => (
            <div key={key}>
              <dt>{what}</dt>
              <dd>{key}</dd>
            </div>
          ))}
        </dl>
      )}
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
  boardSrc,
  changed,
  inReview,
  agentAt,
  waiting,
  menu,
  setMenu,
  onRef,
  onNewBranch,
  onHide,
  assets,
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
  /** Boards you edited, loaded from their latest commit. */
  boardSrc?: Map<string, { base: string }>;
  changed: Set<string>;
  /** Boards a waiting design review would change. */
  inReview: Set<string>;
  /** Where agents are working: board → layers (null for the board itself). */
  agentAt: Map<string, Set<string | null>>;
  waiting: InboxItem[];
  menu: boolean;
  setMenu: (open: boolean) => void;
  onRef: (ref: string) => void;
  onNewBranch: () => void;
  onHide: () => void;
  /** The Assets tab's contents. */
  assets: ReactNode;
}) {
  const [tab, setTab] = useState<'file' | 'assets'>('file');
  const [allPages, setAllPages] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const match = (text: string) =>
    !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase());
  const pages = sections.filter(
    (item) => match(item.title) || item.boards.some((file) => match(boardName(file))),
  );
  const shown = allPages || query ? pages : pages.slice(0, 6);
  const boards = (section?.boards ?? []).filter((file) => match(boardName(file)));
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
          <span className="dl-grow" />
          <button
            type="button"
            className="dl-icon-btn dz-hide"
            aria-label="Hide panels  ⌘\\"
            title="Hide panels  ⌘\\"
            onClick={onHide}
          >
            <Icon name="panel" size={15} />
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'file'}
          className={tab === 'file' ? 'on' : ''}
          onClick={() => setTab('file')}
        >
          File
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'assets'}
          className={tab === 'assets' ? 'on' : ''}
          onClick={() => setTab('assets')}
        >
          Assets
        </button>
        <span className="dl-grow" />
        <button
          type="button"
          className={`dl-icon-btn dz-find${finding ? ' on' : ''}`}
          aria-label="Find a page or board"
          aria-pressed={finding}
          disabled={tab === 'assets'}
          onClick={() => {
            setFinding(!finding);
            setQuery('');
          }}
        >
          <Icon name="search" size={14} />
        </button>
      </div>
      {tab === 'assets' ? (
        assets
      ) : (
        <>
          {finding && (
            <input
              className="dz-find-input"
              autoFocus
              value={query}
              placeholder="Find a page or board"
              aria-label="Find a page or board"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && (setFinding(false), setQuery(''))}
            />
          )}
          <div className="dz-group-h">
            <Icon name="down" size={10} />
            Pages
            <span className="dl-grow" />
            <button
              type="button"
              className="dl-icon-btn dz-add"
              aria-label="Add a page (comes with direct editing)"
              title="Adding pages comes with direct editing"
              disabled
            >
              <Icon name="plus" size={14} />
            </button>
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
            {!query && pages.length > 6 && (
              <button type="button" className="dz-more" onClick={() => setAllPages(!allPages)}>
                {allPages ? 'Fewer' : `${pages.length - 6} more`}
              </button>
            )}
          </div>
          <div className="dz-group-h">
            <Icon name="down" size={10} />
            Layers
          </div>
          <div className="dz-layers" role="tree" aria-label="Layers">
            {base &&
              boards.map((file) => (
                <BoardLayers
                  key={`${base}/${file}`}
                  file={file}
                  url={`${boardSrc?.get(file)?.base ?? base}/boards/${encodeURIComponent(file)}`}
                  selection={selection}
                  select={select}
                  changed={changed.has(file)}
                  inReview={inReview.has(file)}
                  agentAt={agentAt.get(file) ?? new Set()}
                />
              ))}
          </div>
        </>
      )}
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
        {actions && <span className="dz-prop-actions">{actions}</span>}
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

const alignPaths = {
  al: 'M4 4v16M8 8h12M8 16h8',
  ac: 'M12 4v16M6 8h12M8 16h8',
  ar: 'M20 4v16M4 8h12M8 16h8',
  at: 'M4 4h16M8 8v12M16 8v8',
  am: 'M4 12h16M8 6v12M16 8v8',
  ab: 'M4 20h16M8 4v12M16 8v8',
  tl: 'M4 6h16M4 12h10M4 18h14',
  tc: 'M4 6h16M7 12h10M5 18h14',
  tr: 'M4 6h16M10 12h10M6 18h14',
};
function AlignIcon({ name }: { name: keyof typeof alignPaths }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={alignPaths[name]} />
    </svg>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="dz-swatch" style={{ background: color }} />;
}

/** One edit to the selected layer, before the page adds the layer's ID. */
export type LayerEdit =
  | { op: 'style'; prop: string; value: string | null }
  | { op: 'text'; text: string }
  | { op: 'revert'; props?: string[]; text?: boolean };

/** A value you can type over; it commits on Enter or when it loses focus, Escape puts it back. */
function Input({
  value,
  onCommit,
  label,
  hint,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  hint?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="dz-input"
      aria-label={label}
      title={hint}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft.trim() !== value && onCommit(draft.trim())}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(value);
          requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

/** A chip that opens a list: the field looks as it does read-only, with the list over it. */
function Pick({
  value,
  options,
  onChange,
  label,
  children,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <select
        className="dz-pick"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}

const number = (value: string) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const weightNames: Record<number, string> = {
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
};

type SectionName = 'layout' | 'appearance' | 'typography' | 'fill' | 'stroke' | 'effects';
const propNames: Record<string, string> = {
  width: 'Width',
  height: 'Height',
  gap: 'Gap',
  padding: 'Padding',
  opacity: 'Opacity',
  'border-radius': 'Radius',
  'font-size': 'Size',
  'line-height': 'Line height',
  'font-weight': 'Weight',
  'text-align': 'Align',
  color: 'Fill',
  'background-color': 'Fill',
  background: 'Fill',
  border: 'Stroke',
  'border-color': 'Stroke colour',
  'border-width': 'Stroke width',
  'box-shadow': 'Shadow',
};
const sectionOf = (prop: string): SectionName | null => {
  if (/^(width|height|gap|padding)/.test(prop)) return 'layout';
  if (prop === 'opacity' || prop.endsWith('radius')) return 'appearance';
  if (/^(font|line-height|text-align|letter-spacing)/.test(prop)) return 'typography';
  if (['color', 'background-color', 'background'].includes(prop)) return 'fill';
  if (prop.startsWith('border')) return 'stroke';
  if (prop === 'box-shadow') return 'effects';
  return null;
};

function LayerProps({
  element,
  tokens,
  onEdit,
  change,
}: {
  element: HTMLElement;
  tokens: Tokens;
  /** Present when this design can be edited; absent shows the properties read-only. */
  onEdit?: (edits: LayerEdit[]) => void;
  /** What this branch changed on the layer, noted under each section with its reset. */
  change?: LayerChange | null;
}) {
  const view = element.ownerDocument.defaultView!;
  const style = view.getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const kind = kindOf(element);
  const text = kind === 'text';
  const fill = text ? style.color : style.backgroundColor;
  const fillProp = text ? 'color' : 'background-color';
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
  const shadow = style.boxShadow !== 'none';
  // Sizes in a designer's terms: Fill when it spans its parent's content, Hug when its content sets it.
  const parent = element.parentElement;
  const parentStyle = parent ? view.getComputedStyle(parent) : null;
  const inner = (along: 'width' | 'height') => {
    if (!parent || !parentStyle) return 0;
    const rect = parent.getBoundingClientRect();
    return along === 'width'
      ? rect.width - px(parentStyle.paddingLeft) - px(parentStyle.paddingRight)
      : rect.height - px(parentStyle.paddingTop) - px(parentStyle.paddingBottom);
  };
  const inFlow = ['static', 'relative', 'sticky'].includes(style.position);
  const sizing = (along: 'width' | 'height') => {
    const own = element.style[along];
    // A drawn layer sits where it was drawn, at its own size.
    if (!inFlow) return String(Math.round(box[along]));
    if (own === '100%') return 'Fill';
    if (/px$/.test(own)) return String(Math.round(box[along]));
    return Math.abs(box[along] - inner(along)) < 1.5 ? 'Fill' : 'Hug';
  };
  const align =
    style.textAlign === 'start' ? 'left' : style.textAlign === 'end' ? 'right' : style.textAlign;
  const padding = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    .map(px)
    .join(' ');
  const set = (prop: string, value: string | null) => onEdit?.([{ op: 'style', prop, value }]);
  const colorOptions = tokens.colors.map((token) => ({ value: token.name, label: token.name }));

  // What this branch changed, by section: "Align changed on this branch, was Left".
  const changed = new Map<SectionName, string[]>();
  let retyped = false;
  for (const detail of change?.change === 'changed' ? change.details : []) {
    if (detail.startsWith('Text ')) retyped = true;
    const prop = /^([a-z-]+)\s/.exec(detail)?.[1];
    const section = prop ? sectionOf(prop) : null;
    if (prop && section) changed.set(section, [...(changed.get(section) ?? []), prop]);
  }
  if (retyped) changed.set('typography', changed.get('typography') ?? []);
  // The value before this branch: its inline value on main, or what the board's styles give.
  const was = (prop: string) => {
    const detail = change?.details.find((line) => line.startsWith(`${prop} `));
    const before =
      detail && / → /.test(detail) ? detail.slice(prop.length + 1).split(' → ')[0] : null;
    if (before) return before;
    const own = element.style.getPropertyValue(prop);
    element.style.removeProperty(prop);
    const value = view.getComputedStyle(element).getPropertyValue(prop);
    if (own) element.style.setProperty(prop, own);
    return value;
  };
  const shown = (prop: string, value: string) => {
    const token = /color|background/.test(prop) ? colorToken(value, tokens) : null;
    if (token) return token;
    if (/^[a-z]+$/.test(value)) return value[0].toUpperCase() + value.slice(1);
    return value;
  };
  const note = (section: SectionName) => {
    const props = changed.get(section);
    if (!props) return null;
    const typeProps = ['font-size', 'line-height', 'font-weight'];
    let line: string;
    if (section === 'typography' && typeProps.every((prop) => props.includes(prop))) {
      const others = [
        ...new Set(
          props.filter((prop) => !typeProps.includes(prop)).map((prop) => propNames[prop] ?? prop),
        ),
      ];
      const before = textStyle(
        px(was('font-size')),
        px(was('line-height')),
        Number(was('font-weight')),
        tokens,
      );
      line = others.length
        ? `Text style, ${others.join(', ')} changed on this branch`
        : `Text style changed on this branch${before ? `, was ${before}` : ''}`;
    } else if (!props.length) line = 'Text changed on this branch';
    else {
      const names = [...new Set(props.map((prop) => propNames[prop] ?? prop))];
      line =
        names.length === 1 && props.length === 1
          ? `${names[0]} changed on this branch, was ${shown(props[0], was(props[0]))}`
          : `${names.join(', ')} changed on this branch`;
    }
    return (
      <div className="dz-was">
        <span className="dz-dot" />
        {line}
        {section !== 'typography' && reset(section, true)}
      </div>
    );
  };
  // Typography's reset sits beside its align row, as the board draws it; the others end the note,
  // since their side column holds the section's own control.
  const reset = (section: SectionName, inNote = false) =>
    onEdit && changed.has(section) ? (
      <button
        type="button"
        className={`dl-icon-btn ${inNote ? 'dz-reset-inline' : 'dz-reset'}`}
        aria-label={`Reset ${section} to main`}
        title="Reset to main"
        onClick={() =>
          onEdit([
            {
              op: 'revert',
              props: changed.get(section),
              text: section === 'typography' && retyped,
            },
          ])
        }
      >
        <Icon name="undo" size={13} />
      </button>
    ) : null;
  // The control in a row's side column: an icon button, shown read-only without editing.
  const side = (icon: IconName, label: string, run: () => void, pressed?: boolean) => (
    <button
      type="button"
      className={`dl-icon-btn dz-side${pressed ? ' on' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={!onEdit}
      onClick={run}
    >
      <Icon name={icon} size={13} />
    </button>
  );
  const openPicker = (label: string) =>
    (
      document.querySelector(`select[aria-label="${label}"]`) as
        | (HTMLSelectElement & { showPicker?: () => void })
        | null
    )?.showPicker?.();
  const hiddenFill = element.style.getPropertyValue('--hidden-fill');
  const hidden = style.visibility === 'hidden';
  const sizeField = (along: 'width' | 'height', label: 'W' | 'H') => (
    <Field label={label}>
      {onEdit ? (
        <Input
          label={along === 'width' ? 'Width' : 'Height'}
          hint="A number of pixels, Hug or Fill"
          value={sizing(along)}
          onCommit={(value) => {
            const word = value.toLowerCase();
            if (word === 'hug') set(along, null);
            else if (word === 'fill') set(along, '100%');
            else if (number(value) !== null) set(along, `${number(value)}px`);
          }}
        />
      ) : (
        <span title={`${Math.round(box[along])} px`}>{sizing(along)}</span>
      )}
    </Field>
  );
  const pxField = (label: ReactNode, name: string, prop: string, value: number) => (
    <Field label={label}>
      {onEdit ? (
        <Input
          label={name}
          value={String(value)}
          onCommit={(next) => number(next) !== null && set(prop, `${number(next)}px`)}
        />
      ) : (
        value
      )}
    </Field>
  );
  return (
    <>
      <Prop title="Position">
        <div className="dz-align" role="group" aria-label="Align">
          {(['al', 'ac', 'ar', 'at', 'am', 'ab'] as const).map((name) => (
            <span key={name} aria-hidden="true">
              <AlignIcon name={name} />
            </span>
          ))}
        </div>
        <div className="dz-grid">
          <Field label="X">{inFlow ? 'Auto' : Math.round(box.left)}</Field>
          <Field label="Y">{inFlow ? 'Auto' : Math.round(box.top)}</Field>
          <Field label="↻">{style.rotate === 'none' ? '0°' : style.rotate}</Field>
        </div>
      </Prop>
      <Prop
        title={
          flex
            ? `Layout · ${style.flexDirection.startsWith('column') ? 'vertical' : 'horizontal'} stack`
            : 'Layout'
        }
        actions={side(
          'autolayout',
          flex ? 'Remove the stack' : 'Stack its layers vertically',
          () =>
            onEdit?.(
              flex
                ? [{ op: 'style', prop: 'display', value: 'block' }]
                : [
                    { op: 'style', prop: 'display', value: 'flex' },
                    { op: 'style', prop: 'flex-direction', value: 'column' },
                    { op: 'style', prop: 'gap', value: '8px' },
                  ],
            ),
          flex,
        )}
      >
        <div className="dz-grid dz-resettable">
          {sizeField('width', 'W')}
          {sizeField('height', 'H')}
          {side('fit', 'Resize to fit its content', () =>
            onEdit?.([
              { op: 'style', prop: 'width', value: null },
              { op: 'style', prop: 'height', value: null },
            ]),
          )}
          {flex && pxField('Gap', 'Gap', 'gap', px(style.rowGap) || px(style.columnGap))}
          {flex && (
            <Field label="Pad">
              {onEdit ? (
                <Input
                  label="Padding"
                  hint="One to four numbers: top, right, bottom, left"
                  value={padding}
                  onCommit={(value) =>
                    /^(\d+(\.\d+)?\s*){1,4}$/.test(value) &&
                    set(
                      'padding',
                      value
                        .split(/\s+/)
                        .map((part) => `${part}px`)
                        .join(' '),
                    )
                  }
                />
              ) : (
                padding
              )}
            </Field>
          )}
        </div>
        {note('layout')}
      </Prop>
      <Prop title="Appearance">
        <div className="dz-grid dz-resettable">
          <Field label={<Icon name="opacity" size={12} />}>
            {onEdit ? (
              <Input
                label="Opacity"
                hint="Percent"
                value={`${Math.round(Number(style.opacity) * 100)}%`}
                onCommit={(value) => {
                  const next = number(value);
                  if (next !== null) set('opacity', next >= 100 ? null : String(next / 100));
                }}
              />
            ) : (
              `${Math.round(Number(style.opacity) * 100)}%`
            )}
          </Field>
          {pxField(
            <Icon name="radius" size={12} />,
            'Radius',
            'border-radius',
            px(style.borderTopLeftRadius),
          )}
          {side(
            hidden ? 'eyeOff' : 'eye',
            hidden ? 'Show the layer' : 'Hide the layer',
            () => set('visibility', hidden ? null : 'hidden'),
            hidden,
          )}
        </div>
        {note('appearance')}
      </Prop>
      {text && (
        <Prop
          title="Typography"
          actions={side('tokens', 'Text styles', () => openPicker('Text style'))}
        >
          <div className="dz-resettable">
            <Field wide>
              {onEdit ? (
                <Pick
                  label="Text style"
                  value={typeStyle ?? ''}
                  options={[
                    ...(typeStyle ? [] : [{ value: '', label: 'Custom' }]),
                    ...tokens.textStyles.map((token) => ({
                      value: token.name,
                      label: `${token.name} · ${token.size}/${token.lineHeight} · ${token.weight}`,
                    })),
                  ]}
                  onChange={(name) => {
                    const token = tokens.textStyles.find((item) => item.name === name);
                    if (token)
                      onEdit([
                        { op: 'style', prop: 'font-size', value: `${token.size}px` },
                        { op: 'style', prop: 'line-height', value: `${token.lineHeight}px` },
                        { op: 'style', prop: 'font-weight', value: String(token.weight) },
                      ]);
                  }}
                >
                  {typeStyle ? <span className="dz-chip">Aa {typeStyle}</span> : null}
                </Pick>
              ) : typeStyle ? (
                <span className="dz-chip">Aa {typeStyle}</span>
              ) : null}
              <span className="dz-meta">
                {style.fontFamily.split(',')[0].replace(/"/g, '').split(' ')[0]} ·{' '}
                {weightNames[Number(style.fontWeight)] ?? style.fontWeight} · {px(style.fontSize)}/
                {px(style.lineHeight)}
              </span>
            </Field>
            {side('link', 'Detach the text style', () =>
              onEdit?.([
                { op: 'style', prop: 'font-size', value: `${px(style.fontSize)}px` },
                { op: 'style', prop: 'line-height', value: `${px(style.lineHeight)}px` },
                { op: 'style', prop: 'font-weight', value: style.fontWeight },
              ]),
            )}
          </div>
          <div className="dz-resettable">
            <div className="dz-seg3 dz-text-align" role="group" aria-label={`Text align: ${align}`}>
              {(['left', 'center', 'right'] as const).map((edge) =>
                onEdit ? (
                  <button
                    key={edge}
                    type="button"
                    className={align === edge ? 'on' : ''}
                    aria-label={`Align ${edge}`}
                    aria-pressed={align === edge}
                    onClick={() => set('text-align', edge)}
                  >
                    <AlignIcon name={edge === 'left' ? 'tl' : edge === 'center' ? 'tc' : 'tr'} />
                  </button>
                ) : (
                  <span key={edge} className={align === edge ? 'on' : ''} aria-hidden="true">
                    <AlignIcon name={edge === 'left' ? 'tl' : edge === 'center' ? 'tc' : 'tr'} />
                  </span>
                ),
              )}
            </div>
            {reset('typography')}
          </div>
          {note('typography')}
        </Prop>
      )}
      <Prop
        title="Fill"
        actions={
          <>
            {side('tokens', 'Colour tokens', () => openPicker('Fill colour'))}
            {onEdit && !visibleFill && !hiddenFill ? (
              <button
                type="button"
                className="dl-icon-btn dz-add"
                aria-label="Add a fill"
                onClick={() => set(fillProp, 'var(--surface)')}
              >
                <Icon name="plus" size={14} />
              </button>
            ) : (
              later
            )}
          </>
        }
      >
        {hiddenFill && (
          <div className="dz-resettable dz-hidden-fill">
            <Field wide>
              <FillChip
                color={
                  tokens.colors.find((token) => `var(--${token.name})` === hiddenFill)?.light ??
                  hiddenFill
                }
                token={/^var\(--([a-z-]+)\)$/.exec(hiddenFill)?.[1] ?? null}
              />
              <span className="dz-meta">Hidden</span>
            </Field>
            {side(
              'eyeOff',
              'Show the fill',
              () =>
                onEdit?.([
                  { op: 'style', prop: fillProp, value: hiddenFill },
                  { op: 'style', prop: '--hidden-fill', value: null },
                ]),
              true,
            )}
          </div>
        )}
        {visibleFill && !hiddenFill && (
          <div className="dz-resettable">
            <Field wide>
              {onEdit ? (
                <Pick
                  label="Fill colour"
                  value={fillToken ?? ''}
                  options={[
                    ...(fillToken ? [] : [{ value: '', label: fill }]),
                    ...colorOptions,
                    { value: '-', label: 'Remove the fill' },
                  ]}
                  onChange={(name) => set(fillProp, name === '-' ? null : `var(--${name})`)}
                >
                  <FillChip color={fill} token={fillToken} />
                </Pick>
              ) : (
                <FillChip color={fill} token={fillToken} />
              )}
              <span className="dz-meta">100%</span>
            </Field>
            {side('eye', 'Hide the fill', () =>
              onEdit?.([
                {
                  op: 'style',
                  prop: '--hidden-fill',
                  value:
                    element.style.getPropertyValue(fillProp) ||
                    (fillToken ? `var(--${fillToken})` : fill),
                },
                { op: 'style', prop: fillProp, value: 'transparent' },
              ]),
            )}
          </div>
        )}
        {note('fill')}
      </Prop>
      <Prop
        title="Stroke"
        actions={
          onEdit ? (
            <button
              type="button"
              className="dl-icon-btn dz-add"
              aria-label="Add a stroke"
              disabled={border}
              onClick={() => set('border', '1px solid var(--line)')}
            >
              <Icon name="plus" size={14} />
            </button>
          ) : (
            later
          )
        }
      >
        {border && (
          <div className="dz-resettable">
            <Field wide>
              {onEdit ? (
                <Pick
                  label="Stroke colour"
                  value={colorToken(style.borderTopColor, tokens) ?? ''}
                  options={[
                    ...(colorToken(style.borderTopColor, tokens)
                      ? []
                      : [{ value: '', label: style.borderTopColor }]),
                    ...colorOptions,
                  ]}
                  onChange={(name) => name && set('border-color', `var(--${name})`)}
                >
                  <FillChip
                    color={style.borderTopColor}
                    token={colorToken(style.borderTopColor, tokens)}
                  />
                </Pick>
              ) : (
                <FillChip
                  color={style.borderTopColor}
                  token={colorToken(style.borderTopColor, tokens)}
                />
              )}
              {onEdit ? (
                <Input
                  label="Stroke width"
                  hint="0 removes the stroke"
                  value={String(px(style.borderTopWidth))}
                  onCommit={(value) => {
                    const next = number(value);
                    if (next !== null)
                      set(next ? 'border-width' : 'border', next ? `${next}px` : 'none');
                  }}
                />
              ) : (
                px(style.borderTopWidth)
              )}
            </Field>
            {reset('stroke')}
          </div>
        )}
        {note('stroke')}
      </Prop>
      <Prop
        title="Effects"
        actions={
          onEdit ? (
            <button
              type="button"
              className="dl-icon-btn dz-add"
              aria-label={shadow ? 'Remove the shadow' : 'Add a shadow'}
              onClick={() => set('box-shadow', shadow ? 'none' : 'var(--shadow-sm)')}
            >
              <Icon name={shadow ? 'minus' : 'plus'} size={14} />
            </button>
          ) : (
            later
          )
        }
      >
        {shadow && (
          <div className="dz-resettable">
            <Field wide>
              {onEdit ? (
                <Pick
                  label="Shadow"
                  value={/var\(--(shadow-[a-z]+)\)/.exec(element.style.boxShadow)?.[1] ?? ''}
                  options={[
                    ...(/var\(--shadow-/.test(element.style.boxShadow)
                      ? []
                      : [{ value: '', label: 'Shadow' }]),
                    ...['shadow-sm', 'shadow-lg', 'shadow-xl'].map((name) => ({
                      value: name,
                      label: name,
                    })),
                  ]}
                  onChange={(name) => name && set('box-shadow', `var(--${name})`)}
                >
                  {/var\(--(shadow-[a-z]+)\)/.exec(element.style.boxShadow)?.[1] ?? 'Shadow'}
                </Pick>
              ) : (
                'Shadow'
              )}
            </Field>
            {reset('effects')}
          </div>
        )}
        {note('effects')}
      </Prop>
      <Prop title="Export" actions={later} />
    </>
  );
}

/** A colour that is not a token, as a designer reads it: hex, with its opacity when see-through. */
function shownColor(color: string, code: string | null) {
  if (code) return `#${code.toUpperCase()}`;
  const parts =
    /^(?:color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)|rgba\(\s*(\d+),\s*(\d+),\s*(\d+)),?\s*\/?\s*([\d.]+)\)$/.exec(
      color.trim(),
    );
  if (!parts) return color;
  const channels = parts[1]
    ? parts.slice(1, 4).map((part) => Number(part) * 255)
    : parts.slice(4, 7).map(Number);
  const value = channels.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('');
  return `#${value.toUpperCase()} ${Math.round(Number(parts[7]) * 100)}%`;
}

function FillChip({ color, token }: { color: string; token: string | null }) {
  const code = hex(color);
  return token ? (
    <span className="dz-chip">
      <Swatch color={color} />
      {token}
    </span>
  ) : (
    <>
      <Swatch color={color} />
      {shownColor(color, code)}
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
  propose,
  agents,
  onComment,
  htmlHref,
  onEdit,
  component,
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
  changes: { status: string; path: string; layers?: LayerChange[] }[];
  select: (selection: Selection) => void;
  owner: string;
  tab: 'edit' | 'comments';
  setTab: (tab: 'edit' | 'comments') => void;
  commentCount: number;
  comments: ReactNode;
  /** While an agent's branch is open, its panel replaces Edit. */
  agent: ReactNode;
  onAsk: () => void;
  /** Propose the current design branch for review; null when there is nothing to propose. */
  propose: { state: 'ready' | 'busy' | 'in-review'; run: () => void; note: string } | null;
  /** Agents working on this design now, shown beside you like Figma's other viewers. */
  agents: { taskId: string; title: string }[];
  onComment: () => void;
  /** The selected board's HTML, for View HTML. */
  htmlHref: string | null;
  /** Present when this design can be edited. */
  onEdit?: (board: string, layer: string, edits: LayerEdit[]) => void;
  /** A design-system component picked or being placed from Assets, shown instead of a layer. */
  component?: ReactNode;
}) {
  const [zoomMenu, setZoomMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
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
    shape: 'Rectangle',
    ellipse: 'Ellipse',
    line: 'Line',
  } as Record<string, string>;
  // Welcome › Greeting › Title: the board, then the named layers down to the selection.
  const crumb = element ? [boardName(selection!.board), ...layerPath(element).slice(-2)] : [];
  return (
    <aside className="dz-right" aria-label="Edit">
      <span className="dz-grab" aria-hidden="true" />
      <div className="dz-right-top">
        <span className="dz-avatars">
          <span className="dl-avatar" title={owner}>
            {owner.slice(0, 1).toUpperCase()}
          </span>
          {agents.slice(0, 3).map((present) => (
            <span
              key={present.taskId}
              className="dl-avatar dz-agent-avatar"
              title={`${present.title} is working here`}
            >
              <Icon name="spark" size={11} />
            </span>
          ))}
        </span>
        <span className="dl-grow" />
        <button type="button" className="dl-icon-btn" aria-label="Play (coming soon)" disabled>
          <Icon name="play" size={14} />
        </button>
        <button
          type="button"
          className="dz-tool-more"
          aria-label="Play options (coming soon)"
          disabled
        >
          <Icon name="down" size={10} />
        </button>
        <Action
          variant="primary"
          disabled={!propose || propose.state === 'in-review'}
          loading={propose?.state === 'busy'}
          title={propose?.note ?? 'Switch to a design branch with changes to propose it for review'}
          onClick={propose?.run}
        >
          {propose?.state === 'in-review' ? 'In review' : 'Propose'}
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
        ) : component ? (
          component
        ) : selection && element ? (
          <>
            <div className="dz-sel">
              <b className="dz-sel-kind">
                <span className="dz-sel-name">
                  {kindName[kind!]}
                  <Icon name="down" size={11} />
                </span>
                <button
                  type="button"
                  className="dl-icon-btn"
                  aria-label="Ask an agent  ⌘K"
                  title="Ask an agent  ⌘K"
                  onClick={onAsk}
                >
                  <Icon name="spark" size={14} />
                </button>
                <button
                  type="button"
                  className="dl-icon-btn"
                  aria-label="Comment  C"
                  title="Comment  C"
                  onClick={onComment}
                >
                  <Icon name="comment" size={14} />
                </button>
                <span className="dz-more-wrap">
                  <button
                    type="button"
                    className="dl-icon-btn"
                    aria-label="More"
                    aria-haspopup="menu"
                    aria-expanded={moreMenu}
                    onClick={() => setMoreMenu(!moreMenu)}
                  >
                    <Icon name="dots" size={14} />
                  </button>
                  {moreMenu && (
                    <div
                      className="dl-menu dz-zoom-menu"
                      role="menu"
                      onClick={() => setMoreMenu(false)}
                    >
                      <button
                        type="button"
                        className="dl-menu-item"
                        role="menuitem"
                        onClick={() => void navigator.clipboard?.writeText(window.location.href)}
                      >
                        Copy link to layer
                      </button>
                      {htmlHref && (
                        <a
                          className="dl-menu-item"
                          role="menuitem"
                          href={htmlHref}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View the board’s HTML
                        </a>
                      )}
                    </div>
                  )}
                </span>
              </b>
              <span className="dz-crumb">{crumb.join(' › ')}</span>
            </div>
            <LayerProps
              key={`${selection!.board}:${selection!.layer}`}
              element={element}
              tokens={tokens}
              onEdit={onEdit && ((edits) => onEdit(selection!.board, selection!.layer!, edits))}
              change={
                changes
                  .find((file) => file.path === `design/boards/${selection!.board}`)
                  ?.layers?.find((layer) => layer.layer === selection!.layer) ?? null
              }
            />
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
            <Prop title="Page">
              <Field wide>
                <Swatch color="var(--ds-canvas)" />
                canvas
                <span className="dz-meta">100%</span>
              </Field>
            </Prop>
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
  const { data } = useData<{
    files: { status: string; path: string; layers?: LayerChange[] }[];
  }>(
    projectId && commit
      ? `/api/v2/projects/${encodeURIComponent(projectId)}/design/changes?ref=${encodeURIComponent(ref)}&v=${commit}`
      : undefined,
  );
  return data?.files ?? [];
}
