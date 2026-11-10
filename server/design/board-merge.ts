/** A conservative, lossless merge of authored HTML. Unrecognised markup requires a screen choice. */
export type BoardChoice = 'main' | 'proposal';
type Part = { raw: string; key: string } | string;
type Element = {
  id: string;
  open: string;
  close: string;
  parts: Part[];
  signature: string;
  attributes: string;
  label: string;
};
const voids = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' '),
);
const structural = new Set(['html', 'head', 'body', 'br', 'wbr', 'template']);

function parse(html: string) {
  if (!html.trim()) throw new Error('Missing board');
  const nodes = new Map<string, Element>();
  const root: Element = {
    id: '$document',
    open: '',
    close: '',
    parts: [],
    signature: '',
    attributes: '',
    label: 'page structure',
  };
  nodes.set(root.id, root);
  const stack = [{ name: '', node: root, own: true }];
  let inBody = !/<body[\s>]/i.test(html);
  let svg = 0;
  const tokens =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-zA-Z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gi;
  let at = 0;
  for (let match = tokens.exec(html); match; match = tokens.exec(html)) {
    if (match.index !== at) throw new Error('Unparsed HTML');
    const raw = match[0];
    at = tokens.lastIndex;
    const parent = stack.at(-1)!;
    const tag = /^<(\/?)([\w:-]+)/.exec(raw);
    if (!tag) {
      parent.node.parts.push(raw);
      continue;
    }
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      if (parent.name !== name) throw new Error('Unbalanced HTML');
      stack.pop();
      if (parent.own) parent.node.close = raw;
      else parent.node.parts.push(raw);
      if (name === 'svg') svg--;
      if (name === 'body') inBody = false;
      continue;
    }
    const attrs = [
      ...raw.matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g),
    ].map((a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '']);
    if (new Set(attrs.map(([key]) => key)).size !== attrs.length)
      throw new Error('Duplicate attribute');
    const values = Object.fromEntries(attrs);
    const id = values['data-layer'];
    if (id && (nodes.has(id) || id.startsWith('$'))) throw new Error('Duplicate layer');
    if (inBody && !svg && !structural.has(name) && !id) throw new Error('Missing layer');
    let node = parent.node;
    if (id) {
      node = {
        id,
        open: raw,
        close: '',
        parts: [],
        signature: JSON.stringify([name, attrs.sort(([a], [b]) => a.localeCompare(b))]),
        attributes: JSON.stringify([name, attrs]),
        label: values['data-name'] || values['aria-label'] || id.replace(/-/g, ' '),
      };
      nodes.set(id, node);
      parent.node.parts.push({ raw, key: id });
    } else parent.node.parts.push(raw);
    if (name === 'body') inBody = true;
    const single = voids.has(name) || raw.endsWith('/>');
    if (name === 'svg' && !single) svg++;
    if (!single) {
      stack.push({ name, node, own: Boolean(id) });
      if (['style', 'script', 'textarea', 'title'].includes(name)) {
        const end = html.toLowerCase().indexOf(`</${name}`, at);
        if (end < 0) throw new Error('Unclosed text');
        node.parts.push(html.slice(at, end));
        tokens.lastIndex = at = end;
      }
    }
  }
  if (at !== html.length || stack.length !== 1 || nodes.size < 2)
    throw new Error('Incomplete board');
  for (const node of nodes.values())
    node.signature += JSON.stringify(
      node.parts.map((p) => (typeof p === 'string' ? p : { key: p.key })),
    );
  return nodes;
}
const same = (a?: Element, b?: Element) => a?.signature === b?.signature;
function render(nodes: Map<string, Element>, id = '$document', seen = new Set<string>()): string {
  if (seen.has(id)) throw new Error('Layer occurs twice');
  seen.add(id);
  const node = nodes.get(id);
  if (!node) throw new Error('Missing child');
  return (
    node.open +
    node.parts.map((p) => (typeof p === 'string' ? p : render(nodes, p.key, seen))).join('') +
    node.close
  );
}

/** Combine compatible child insertions, removals and ordering without treating their
 * shared container as an overlapping edit. Mixed text stays conservative. */
function mergeChildren(base: Element, main: Element, proposal: Element): Element | null {
  const sequence = (node: Element) =>
    node.parts
      .filter((part): part is Exclude<Part, string> => typeof part !== 'string')
      .map((part) => part.key);
  const shell = (node: Element) => {
    const first = node.parts.findIndex((part) => typeof part !== 'string');
    const last = node.parts.findLastIndex((part) => typeof part !== 'string');
    if (first < 0) return node.parts.join('').trim() ? null : { prefix: '', suffix: '' };
    if (node.parts.slice(first + 1, last).some((part) => typeof part === 'string' && part.trim()))
      return null;
    return {
      prefix: node.parts.slice(0, first).join(''),
      suffix: node.parts.slice(last + 1).join(''),
    };
  };
  const shells = [base, main, proposal].map(shell);
  if (
    shells.some((value) => !value) ||
    base.attributes !== main.attributes ||
    base.attributes !== proposal.attributes ||
    shells.some((value) => JSON.stringify(value) !== JSON.stringify(shells[0]))
  )
    return null;
  const [a, b, c] = [base, main, proposal].map(sequence);
  const keys = [...new Set([...b, ...c])].filter(
    (key) => !a.includes(key) || (b.includes(key) && c.includes(key)),
  );
  const relation = (order: string[], x: string, y: string) =>
    order.includes(x) && order.includes(y) ? order.indexOf(x) < order.indexOf(y) : undefined;
  // A removal against a move of that child is an incompatible edit.
  for (const key of a.filter((key) => b.includes(key) !== c.includes(key))) {
    const survivor = b.includes(key) ? b : c;
    if (
      a.some(
        (other) =>
          other !== key &&
          survivor.includes(other) &&
          relation(a, key, other) !== relation(survivor, key, other),
      )
    )
      return null;
  }
  const edges = new Map(keys.map((key) => [key, new Set<string>()]));
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const x = keys[i],
        y = keys[j];
      const old = relation(a, x, y),
        ours = relation(b, x, y),
        theirs = relation(c, x, y);
      if (old === undefined && ours !== undefined && theirs !== undefined && ours !== theirs)
        return null;
      const order = theirs === undefined || theirs === old ? ours : theirs;
      if (order !== undefined) edges.get(order ? x : y)!.add(order ? y : x);
    }
  const ordered: string[] = [];
  while (ordered.length < keys.length) {
    const next = keys.find(
      (key) =>
        !ordered.includes(key) &&
        !keys.some((other) => !ordered.includes(other) && edges.get(other)!.has(key)),
    );
    if (!next) return null;
    ordered.push(next);
  }
  return {
    ...main,
    parts: [shells[0]!.prefix, ...ordered.map((key) => ({ key, raw: '' })), shells[0]!.suffix],
  };
}

export function mergeBoard(base: string, main: string, proposal: string, choice?: BoardChoice) {
  const fallback = () => ({
    content: choice === 'main' ? main : proposal,
    kind: 'same-part' as const,
    mainChanged: 'Screen changed',
    proposalChanged: 'Screen changed',
    detail: 'Both changed this screen.',
    fallback: true,
  });
  try {
    const [a, b, c] = [base, main, proposal].map(parse);
    const into = new Map<string, Element>();
    const conflicts: string[] = [],
      mainChanges: string[] = [],
      proposalChanges: string[] = [];
    for (const id of new Set([...a.keys(), ...b.keys(), ...c.keys()])) {
      const old = a.get(id),
        ours = b.get(id),
        theirs = c.get(id);
      const label = (theirs ?? ours ?? old)!.label;
      if (!same(old, ours)) mainChanges.push(label);
      if (!same(old, theirs)) proposalChanges.push(label);
      // Deleting an ancestor against an edit inside it is a structural conflict too.
      const deletionConflict =
        old && (!ours || !theirs) && ours !== theirs && render(a, id) !== render(ours ? b : c, id);
      const removedChildEdited = (node: Element | undefined, other: Map<string, Element>) =>
        old?.parts.some((part) => {
          if (typeof part === 'string' || !a.has(part.key) || !other.has(part.key)) return false;
          return (
            !node?.parts.some((p) => typeof p !== 'string' && p.key === part.key) &&
            render(a, part.key) !== render(other, part.key)
          );
        });
      let conflict =
        deletionConflict ||
        removedChildEdited(ours, c) ||
        removedChildEdited(theirs, b) ||
        (!same(old, ours) && !same(old, theirs) && !same(ours, theirs));
      const children =
        old &&
        ours &&
        theirs &&
        conflict &&
        !deletionConflict &&
        !removedChildEdited(ours, c) &&
        !removedChildEdited(theirs, b)
          ? mergeChildren(old, ours, theirs)
          : null;
      if (children) conflict = false;
      if (conflict) conflicts.push(label);
      const selected =
        children ??
        (conflict ? (choice === 'main' ? ours : theirs) : same(old, theirs) ? ours : theirs);
      if (selected) into.set(id, selected);
    }
    // A removed subtree cannot be assembled from half of each side. Keep the chosen
    // subtree for this conflict while merging all surviving, unrelated elements normally.
    for (const [id, old] of a) {
      const ours = b.get(id),
        theirs = c.get(id);
      if (!ours === !theirs || !old) continue;
      const surviving = ours ? b : c;
      if (render(a, id) === render(surviving, id)) continue;
      const selected = choice === 'main' ? b : c;
      const copy = (key: string) => {
        const node = selected.get(key);
        if (!node) {
          into.delete(key);
          return;
        }
        into.set(key, node);
        for (const part of node.parts) if (typeof part !== 'string') copy(part.key);
      };
      copy(id);
    }
    const content = render(into);
    // Refuse dangling/moved children and invalid output; a whole-screen choice remains possible.
    parse(content);
    const phrase = (labels: string[]) =>
      [...new Set(labels)].slice(0, 3).join(', ') || 'No element changed';
    const describe = (nodes: Map<string, Element>, labels: string[]) =>
      [...nodes.values()]
        .filter((node) => labels.includes(node.label))
        .slice(0, 3)
        .map((node) => {
          const text = node.parts
            .filter((p) => typeof p === 'string')
            .join('')
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          return text ? `${node.label}: ${text.slice(0, 120)}` : node.label;
        })
        .join(', ') || 'Removed';
    return {
      content,
      kind: conflicts.length ? ('same-part' as const) : ('kept-both' as const),
      mainChanged: conflicts.length ? describe(b, mainChanges) : phrase(mainChanges),
      proposalChanged: conflicts.length ? describe(c, proposalChanges) : phrase(proposalChanges),
      detail: conflicts.length
        ? `Both changed the ${phrase(conflicts)}.`
        : `Different parts changed: the ${phrase(proposalChanges)} here, the ${phrase(mainChanges)} on main. Nothing to choose.`,
      fallback: false,
    };
  } catch {
    return fallback();
  }
}
