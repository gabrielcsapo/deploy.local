import {
  emptySource,
  lineCount,
  locations,
  oneLine,
  type Binding,
  type ExtractedFile,
} from './model.ts';

type Token = { value: string; at: number; end: number };
const items = new Set([
  'fn',
  'struct',
  'enum',
  'trait',
  'type',
  'const',
  'static',
  'mod',
  'macro_rules',
]);
const identifier = /^(?:[\p{ID_Start}_][\p{ID_Continue}]*|r#[\p{ID_Start}_][\p{ID_Continue}]*)$/u;
const word = (token?: Token) =>
  token && identifier.test(token.value) ? token.value.replace(/^r#/, '') : undefined;
const lexical =
  /\s+|\/\/[^\r\n]*|\/\*|(?:br|cr|r)(#*)"|(?:b|c)?"(?:\\[\s\S]|[^"\\])*"|(?:b)?'(?:\\[^']+|[^'\\\r\n])'|(?:r#)?[\p{ID_Start}_][\p{ID_Continue}]*|::|->|\S/uy;
const pair: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

class RustSyntax extends Error {
  readonly offset: number;
  constructor(offset: number, message: string) {
    super(message);
    this.offset = offset;
  }
}

function tokenize(text: string) {
  const tokens: Token[] = [];
  const closing = new Map<number, number>();
  const stack: number[] = [];
  const docs: Token[] = [];
  for (let offset = 0; offset < text.length;) {
    lexical.lastIndex = offset;
    const match = lexical.exec(text)!;
    let end = lexical.lastIndex;
    let value = match[0];
    if (value === '/*') {
      let depth = 1;
      const comments = /\/\*|\*\//g;
      comments.lastIndex = end;
      while (depth) {
        const comment = comments.exec(text);
        if (!comment) throw new RustSyntax(offset, 'Unclosed block comment');
        depth += comment[0] === '/*' ? 1 : -1;
        end = comments.lastIndex;
      }
      if (text.startsWith('/**', offset))
        docs.push({ at: offset, end, value: text.slice(offset + 3, end - 2) });
    } else if (value.startsWith('//')) {
      if (value.startsWith('///') && !value.startsWith('////'))
        docs.push({ at: offset, end, value: value.slice(3) });
    } else if (value.trim()) {
      if (match[1] !== undefined) {
        const suffix = '"' + match[1];
        const stop = text.indexOf(suffix, end);
        if (stop < 0) throw new RustSyntax(offset, 'Unclosed raw string');
        end = stop + suffix.length;
        value = '""';
      }
      if (value === '"') throw new RustSyntax(offset, 'Unclosed string');
      if (Object.hasOwn(pair, value)) stack.push(tokens.length);
      if (value === '}' || value === ')' || value === ']') {
        const opening = stack.pop();
        if (opening === undefined || pair[tokens[opening].value] !== value)
          throw new RustSyntax(offset, `Unexpected ${value}`);
        closing.set(opening, tokens.length);
      }
      tokens.push({ at: offset, end, value });
    }
    offset = end;
  }
  if (stack.length) throw new RustSyntax(tokens[stack.pop()!].at, 'Unclosed delimiter');
  return { tokens, closing, docs };
}

type Use = { path: Token[]; alias: string; position: Token };
function readUse(tokens: Token[], start: number, end: number, closing: Map<number, number>) {
  const result: Use[] = [];
  function group(from: number, to: number, parent: Token[], depth: number) {
    if (depth > 64) throw new RustSyntax(tokens[from]?.at ?? 0, 'Use tree nesting exceeds limit');
    for (let i = from; i < to;) {
      const path = [...parent];
      let alias: string | undefined;
      let nested = false;
      while (i < to && tokens[i].value !== ',') {
        const token = tokens[i++];
        if (token.value === '::') continue;
        if (token.value === 'as') {
          alias = word(tokens[i++]);
          break;
        }
        if (token.value === '{') {
          const stop = closing.get(i - 1)!;
          group(i, stop, path, depth + 1);
          i = stop + 1;
          nested = true;
          break;
        }
        path.push(token);
      }
      const position = path.at(-1);
      if (!nested && position) {
        if (position.value === 'self' && path.length > 1) path.pop();
        result.push({ path, alias: alias ?? path.at(-1)!.value.replace(/^r#/, ''), position });
      }
      if (tokens[i]?.value === ',') i++;
    }
  }
  group(start, end, [], 0);
  return result;
}

function binding(path: string[]): Binding {
  return { module: path.slice(0, -1).join('::'), name: path.at(-1) ?? '' };
}

/** Resolve module-level items and use trees without running Cargo, macros or a build script. */
export function extractRust(text: string): ExtractedFile {
  const base = { kind: 'Rust', lines: lineCount(text), text };
  const locate = locations(text);
  const source = emptySource();
  try {
    const { tokens, closing, docs } = tokenize(text);
    const ignored = new Set<number>();
    const modules = new Map<number, string>();
    const imports: { scope: string[]; alias: string; path: string[] }[] = [];
    const scope: string[] = [];
    const scopeEnds: number[] = [];
    let lastDoc = 0;
    let visibility: 'public' | 'private' | undefined;
    let macroExport = false;
    for (let i = 0; i < tokens.length; i++) {
      if (scopeEnds.at(-1) === i) {
        scopeEnds.pop();
        scope.pop();
      }
      const token = tokens[i];
      if (token.value === '#' && tokens[i + 1]?.value === '[') {
        const end = closing.get(i + 1)!;
        macroExport ||= tokens[i + 2]?.value === 'macro_export';
        i = end;
        continue;
      }
      if (token.value === 'pub') {
        visibility = tokens[i + 1]?.value === '(' ? 'private' : 'public';
        if (visibility === 'private') i = closing.get(i + 1)!;
        continue;
      }
      if (token.value === 'use') {
        let end = i + 1;
        while (end < tokens.length && tokens[end].value !== ';')
          end = (closing.get(end) ?? end) + 1;
        if (end === tokens.length) throw new RustSyntax(token.at, 'Expected semicolon after use');
        for (const entry of readUse(tokens, i + 1, end, closing)) {
          const path = entry.path.map(({ value }) => value.replace(/^r#/, ''));
          imports.push({ scope: [...scope], alias: entry.alias, path });
          const link = binding(path);
          source.occurrences.push({
            ...locate(entry.position.at),
            binding: link,
            scope: [...scope],
          });
          if (visibility === 'public')
            source.exports.push({ name: entry.alias, binding: link, scope: [...scope] });
        }
        for (let j = i; j <= end; j++) ignored.add(j);
        i = end;
        visibility = undefined;
        continue;
      }
      if (
        !items.has(token.value) ||
        (token.value === 'const' && ['fn', 'unsafe', 'async'].includes(tokens[i + 1]?.value))
      ) {
        if (
          !['async', 'unsafe', 'const', 'extern', 'default'].includes(token.value) &&
          !token.value.startsWith('"')
        ) {
          visibility = undefined;
          macroExport = false;
        }
        continue;
      }
      const nameIndex = i + (token.value === 'macro_rules' ? 2 : 1);
      const nameToken = tokens[nameIndex];
      const name = word(nameToken);
      if (!name) {
        if (
          visibility === 'public' ||
          (token.value === 'fn' && ['{', '='].includes(nameToken?.value))
        )
          throw new RustSyntax(nameToken?.at ?? token.at, `Expected name after ${token.value}`);
        visibility = undefined;
        continue;
      }
      if (name !== '_') {
        let end = nameIndex + 1;
        while (end < tokens.length && !['{', ';', '=', '}'].includes(tokens[end].value))
          end = (closing.get(end) ?? end) + 1;
        const offset = nameToken.at;
        const publicItem =
          visibility === 'public' || (token.value === 'macro_rules' && macroExport);
        const itemScope = token.value === 'macro_rules' && macroExport ? [] : [...scope];
        while (docs[lastDoc + 1]?.end < token.at) lastDoc++;
        const doc = docs[lastDoc];
        source.definitions.push({
          ...locate(offset),
          name,
          kind: token.value === 'macro_rules' ? 'macro' : token.value,
          signature: oneLine(
            text.slice(token.at, Math.min(token.at + 350, tokens[end]?.at ?? text.length)),
          ),
          scope: itemScope,
          ...(doc && doc.end < token.at && !/[;}]/.test(text.slice(doc.end, token.at))
            ? { doc: oneLine(doc.value) }
            : {}),
        });
        if (publicItem) source.exports.push({ name, target: offset, scope: itemScope });
        ignored.add(nameIndex);
        if (token.value === 'mod' && tokens[nameIndex + 1]?.value === '{') {
          modules.set(nameIndex + 1, name);
          scope.push(name);
          scopeEnds.push(closing.get(nameIndex + 1)!);
        }
      }
      i = nameIndex;
      visibility = undefined;
      macroExport = false;
    }
    scope.length = 0;
    scopeEnds.length = 0;
    const importMap = new Map(
      imports.map(({ scope: parent, alias, path }) => [[...parent, alias].join('::'), path]),
    );
    const starts = new Set(['crate', 'super', 'self']);
    const locals = new Map(
      source.definitions.map((item) => [
        [...(item.scope ?? []), item.name].join('::'),
        item.offset,
      ]),
    );
    for (let i = 0; i < tokens.length; i++) {
      if (scopeEnds.at(-1) === i) {
        scopeEnds.pop();
        scope.pop();
      }
      const child = modules.get(i);
      if (child) {
        scope.push(child);
        scopeEnds.push(closing.get(i)!);
      }
      if (ignored.has(i) || tokens[i - 1]?.value === '.') continue;
      const name = word(tokens[i]);
      if (!name) continue;
      const parts = [name];
      let end = i;
      while (tokens[end + 1]?.value === '::' && word(tokens[end + 2])) {
        parts.push(word(tokens[end + 2])!);
        end += 2;
      }
      let alias: string[] | undefined;
      for (let depth = scope.length; depth >= 0 && !alias; depth--)
        alias = importMap.get([...scope.slice(0, depth), name].join('::'));
      const at = locate(tokens[end].at);
      if (alias || parts.length > 1 || starts.has(name)) {
        source.occurrences.push({
          ...at,
          binding: binding(alias ? [...alias, ...parts.slice(1)] : parts),
          scope: [...scope],
        });
      } else {
        const target = locals.get([...scope, name].join('::'));
        if (target !== undefined && target !== at.offset)
          source.occurrences.push({ ...at, target, scope: [...scope] });
      }
      i = end;
    }
    return { ...base, coverage: 'symbols', source };
  } catch (error) {
    if (!(error instanceof RustSyntax)) throw error;
    return {
      ...base,
      coverage: 'skipped',
      reason: `Syntax error: ${error.message}`,
      errorLine: locate(error.offset).line,
    };
  }
}
