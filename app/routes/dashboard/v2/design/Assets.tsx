'use client';
import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui';
import { useData } from '../projects/data';
import { boardName, layerFacts, layerName, type Section } from './model';

/** The design system's components, as design/ds/<system>/components/library.json holds them. */
export type Component = {
  id: string;
  name: string;
  group: string;
  description: string;
  props: { id: string; label: string; default: string; options?: Record<string, string> }[];
  html: string;
};
export type Library = { name?: string; components: Component[] };
/** Where a dragged component would land: into a stack at an index, or at a spot on a board. */
export type DropTarget = {
  board: string;
  parent: string | null;
  index?: number;
  x?: number;
  y?: number;
  /** In canvas coordinates: the insertion line, or the spot. */
  line: { x: number; y: number; w: number; vertical: boolean };
  into: string;
  place: string;
};
/** A component being placed: what it is, its values, and where the pointer is. */
export type Placing = { component: Component; props: Record<string, string>; x: number; y: number };

const groupOrder = ['Input', 'Lists and feedback', 'Navigation', 'Icons and art'];

export function useLibrary(projectApi: string, ref: string, commit: string | undefined) {
  const { data } = useData<{ library: Library | null; usage: Record<string, string[]> }>(
    projectApi && commit
      ? `${projectApi}/components?ref=${encodeURIComponent(ref)}&v=${commit}`
      : undefined,
  );
  return data ?? null;
}

/** A component's markup with its values filled in, as the server writes an instance. */
export function filled(component: Component, props: Record<string, string>) {
  return component.html.replace(/\{\{([a-z0-9-]+)\}\}/g, (_, key: string) => {
    const prop = component.props.find((item) => item.id === key);
    const value = props[key] ?? prop?.default ?? '';
    const shown = prop?.options ? (prop.options[value] ?? '') : value;
    return shown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  });
}

/**
 * A component drawn the way boards draw it: its markup on a page with the design system's styles,
 * no scripts. `fit` scales it into the frame; otherwise it shows at `scale`.
 */
export function ComponentFrame({
  component,
  props = {},
  files,
  width,
  height,
  fit,
  hug,
  scale = 1,
  className,
}: {
  component: Component;
  props?: Record<string, string>;
  /** The design files at the commit on screen, so ../ds/ resolves as it does for boards. */
  files: string;
  width: number;
  height: number;
  fit?: boolean;
  /** Grow the frame to the component's height, for the ghost while dragging. */
  hug?: boolean;
  scale?: number;
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const icon = component.group === 'Icons and art';
  const page = `<!doctype html><html><head><meta charset="utf-8"><base href="${new URL(`${files}/boards/`, window.location.href).href}"><link rel="stylesheet" href="../ds/deploy-local/tokens.css"><link rel="stylesheet" href="../ds/deploy-local/components/bundle.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:var(--font-sans);color:var(--ink)}#c{position:absolute;left:0;top:0;width:${fit ? 'max-content' : `${width}px`};transform-origin:0 0}#c>*{margin:0}</style></head><body><div id="c">${filled(component, props)}</div></body></html>`;
  // Fitting reads the component's size once it has its styles, then centres it in the frame.
  const place = () => {
    const doc = frame.current?.contentDocument;
    const content = doc?.getElementById('c');
    if (hug && content && frame.current)
      frame.current.style.height = `${Math.max(16, content.scrollHeight)}px`;
    if (!fit || !content) return;
    const w = content.scrollWidth || 1;
    const h = content.scrollHeight || 1;
    const z = Math.min(icon ? 3 : 1, (width * 0.86) / w, (height * 0.8) / h);
    content.style.transform = `translate(${(width - w * z) / 2}px, ${(height - h * z) / 2}px) scale(${z})`;
  };
  return (
    <iframe
      ref={frame}
      className={className}
      title={component.name}
      sandbox="allow-same-origin"
      srcDoc={page}
      width={width}
      height={height}
      // Zoom, unlike a transform, also sizes the frame's box, so what holds it fits it.
      style={scale !== 1 ? { zoom: scale } : undefined}
      onLoad={() => {
        place();
        // Web fonts can change the size after load.
        frame.current?.contentDocument?.fonts?.ready.then(place);
      }}
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}

/** The Assets tab: the design system's components by group, to pick or drag onto a board. */
export function AssetsPanel({
  library,
  files,
  picked,
  onPick,
  onDrag,
}: {
  library: Library | null | undefined;
  files: string | null;
  picked: string | null;
  onPick: (component: Component) => void;
  onDrag: (component: Component, event: React.PointerEvent) => void;
}) {
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set(['Icons and art']));
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    const found = (library?.components ?? []).filter(
      (item) =>
        !words || `${item.name} ${item.group} ${item.description}`.toLowerCase().includes(words),
    );
    const names = [...new Set(found.map((item) => item.group))].sort(
      (a, b) =>
        (groupOrder.indexOf(a) + 1 || 99) - (groupOrder.indexOf(b) + 1 || 99) || a.localeCompare(b),
    );
    return names.map((name) => ({ name, items: found.filter((item) => item.group === name) }));
  }, [library, query]);
  if (library === undefined) return <div className="dz-row muted">Loading the design system…</div>;
  if (!library)
    return (
      <div className="dz-as-empty">
        This design has no component library. Add design/ds/deploy-local/components/library.json to
        place components.
      </div>
    );
  return (
    <div className="dz-assets">
      <label className="dz-as-search">
        <Icon name="search" size={13} />
        <input
          value={query}
          placeholder="Find a component"
          aria-label="Find a component"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="dz-as-lib">
        <Icon name="component" size={13} />
        {library.name ?? 'Design system'}
        <span>{library.components.length}</span>
      </div>
      {groups.map((group) => {
        const open = !closed.has(group.name) || Boolean(query.trim());
        return (
          <section key={group.name}>
            <button
              type="button"
              className="dz-as-g"
              aria-expanded={open}
              onClick={() =>
                setClosed((current) => {
                  const next = new Set(current);
                  if (next.has(group.name)) next.delete(group.name);
                  else next.add(group.name);
                  return next;
                })
              }
            >
              <Icon name={open ? 'down' : 'chevron'} size={11} />
              {group.name}
              {group.name === 'Icons and art' && ` · ${group.items.length}`}
            </button>
            {open && (
              <div className="dz-as-grid">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`dz-as-it${picked === item.id ? ' on' : ''}`}
                    aria-pressed={picked === item.id}
                    title={`${item.name}: drag onto a board`}
                    onClick={() => onPick(item)}
                    onPointerDown={(event) => {
                      if (event.button === 0) onDrag(item, event);
                    }}
                  >
                    <span className="dz-as-th">
                      {files && (
                        <ComponentFrame
                          component={item}
                          files={files}
                          width={104}
                          height={52}
                          fit
                        />
                      )}
                    </span>
                    <span className="dz-as-name">{item.name}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Where a component dropped at a point on a board would go. */
export function dropTarget(
  board: string,
  placed: { x: number; y: number },
  doc: Document,
  local: { x: number; y: number },
): DropTarget {
  const name = boardName(board);
  let element = doc.elementFromPoint(local.x, local.y) as HTMLElement | null;
  // The nearest stack with a layer ID: not a component's own insides, not a vector.
  while (element && element !== doc.body) {
    const style = doc.defaultView!.getComputedStyle(element);
    // A stack of blocks (rows, cards, instances), not a column of text like a row's title.
    const blocks = [...element.children].filter(
      (child) => doc.defaultView!.getComputedStyle(child).position !== 'absolute',
    );
    const stack =
      element.hasAttribute('data-layer') &&
      !element.closest('svg') &&
      !element.closest('[data-component]') &&
      blocks.length > 0 &&
      !style.display.startsWith('inline') &&
      blocks.every(
        (child) =>
          child.hasAttribute('data-component') ||
          [...child.children].some((inner) => inner.tagName.toLowerCase() !== 'svg'),
      );
    if (stack) break;
    element = element.parentElement;
  }
  if (!element || element === doc.body)
    return {
      board,
      parent: null,
      x: Math.round(local.x),
      y: Math.round(local.y),
      line: { x: placed.x + local.x, y: placed.y + local.y, w: 0, vertical: false },
      into: name,
      place: 'here',
    };
  const style = doc.defaultView!.getComputedStyle(element);
  const across = style.display.includes('flex') && style.flexDirection.startsWith('row');
  const children = [...element.children].filter(
    (child) => doc.defaultView!.getComputedStyle(child).display !== 'none',
  ) as HTMLElement[];
  const all = [...element.children];
  let index = children.findIndex((child) => {
    const rect = child.getBoundingClientRect();
    return across ? local.x < rect.left + rect.width / 2 : local.y < rect.top + rect.height / 2;
  });
  if (index < 0) index = children.length;
  const box = element.getBoundingClientRect();
  const before = children[index - 1]?.getBoundingClientRect();
  const after = children[index]?.getBoundingClientRect();
  const at = across
    ? after
      ? before
        ? (before.right + after.left) / 2
        : after.left
      : (before?.right ?? box.left)
    : after
      ? before
        ? (before.bottom + after.top) / 2
        : after.top
      : (before?.bottom ?? box.top);
  const facts = layerFacts(element);
  const into = layerName(facts);
  const neighbour = children[index - 1];
  const place =
    index === 0
      ? 'first'
      : index === children.length
        ? 'last'
        : `after ${neighbour.hasAttribute('data-layer') ? layerName(layerFacts(neighbour)) : 'the row above'}`;
  return {
    board,
    parent: element.getAttribute('data-layer'),
    // The server counts every element child, shown or not.
    index: index < children.length ? all.indexOf(children[index]) : all.length,
    line: across
      ? { x: placed.x + at, y: placed.y + box.top, w: box.height, vertical: true }
      : { x: placed.x + box.left, y: placed.y + at, w: box.width, vertical: false },
    into: `${name} › ${into}`,
    place,
  };
}

/** The component's panel: what it is, its values, where it would drop, and where it is used. */
export function ComponentPanel({
  component,
  library,
  props,
  setProps,
  target,
  usage,
  sections,
  onAsk,
}: {
  component: Component;
  library: Library;
  props: Record<string, string>;
  setProps: (props: Record<string, string>) => void;
  target: DropTarget | null;
  usage: string[];
  sections: Section[];
  onAsk: () => void;
}) {
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState(false);
  // Used in, by page: "Computers  2 boards".
  const pages = sections
    .map((section) => ({
      title: section.title,
      count: section.boards.filter((file) => usage.includes(file)).length,
    }))
    .filter((page) => page.count > 0);
  return (
    <>
      <div className="dz-sel">
        <b className="dz-sel-kind dz-component-name">
          <Icon name="component" size={13} />
          <span className="dz-sel-name">
            {component.name}
            <Icon name="down" size={11} />
          </span>
          <button
            type="button"
            className="dl-icon-btn"
            aria-label="Ask an agent to change this component  ⌘K"
            title="Ask an agent to change this component  ⌘K"
            onClick={onAsk}
          >
            <Icon name="spark" size={14} />
          </button>
          <span className="dz-more-wrap">
            <button
              type="button"
              className="dl-icon-btn"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={more}
              onClick={() => setMore(!more)}
            >
              <Icon name="dots" size={14} />
            </button>
            {more && (
              <div className="dl-menu dz-zoom-menu" role="menu">
                <button
                  type="button"
                  className="dl-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(filled(component, props))
                      .then(() => setCopied(true));
                    setMore(false);
                  }}
                >
                  Copy its markup
                </button>
              </div>
            )}
          </span>
        </b>
        {copied && <span className="dz-crumb">Copied its markup</span>}
        <span className="dz-crumb">
          {library.name ?? 'Design system'} · {component.group}
        </span>
      </div>
      <section className="dz-prop">
        <div className="dz-prop-h">
          <span>Component</span>
        </div>
        <p className="dz-as-about">{component.description}</p>
      </section>
      {component.props.length > 0 && (
        <section className="dz-prop">
          <div className="dz-prop-h">
            <span>Properties</span>
          </div>
          {component.props.map((prop) => {
            const value = props[prop.id] ?? prop.default;
            return (
              <div key={prop.id} className="dz-field wide">
                <span className="dz-l">{prop.label}</span>
                <span className="dz-v">
                  {prop.options ? (
                    <>
                      {value}
                      <select
                        className="dz-pick"
                        aria-label={prop.label}
                        value={value}
                        onChange={(event) => setProps({ ...props, [prop.id]: event.target.value })}
                      >
                        {Object.keys(prop.options).map((option) => (
                          <option key={option}>{option}</option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <input
                      className="dz-input"
                      aria-label={prop.label}
                      value={value}
                      onChange={(event) => setProps({ ...props, [prop.id]: event.target.value })}
                    />
                  )}
                </span>
              </div>
            );
          })}
        </section>
      )}
      <section className="dz-prop">
        <div className="dz-prop-h">
          <span>Dropping into</span>
        </div>
        {target ? (
          <div className="dz-as-row">
            <span>{target.into}</span>
            <span className="dz-meta">{target.place}</span>
          </div>
        ) : (
          <div className="dz-as-row muted">Drag it onto a board</div>
        )}
        <p className="dz-as-about">
          Drops as an instance. Edits to the component on main update every instance.
        </p>
      </section>
      <section className="dz-prop">
        <div className="dz-prop-h">
          <span>Used in</span>
        </div>
        {pages.length ? (
          pages.map((page) => (
            <div key={page.title} className="dz-as-row">
              <span>{page.title}</span>
              <span className="dz-meta">
                {page.count} {page.count === 1 ? 'board' : 'boards'}
              </span>
            </div>
          ))
        ) : (
          <div className="dz-as-row muted">Not on any board yet</div>
        )}
      </section>
    </>
  );
}
