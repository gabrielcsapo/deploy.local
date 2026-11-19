import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import {
  SyntaxKind as K,
  isIdentifier,
  isStringLiteral,
  visitEachChild,
  type Node,
  type Identifier,
  type SourceFile,
  type CallExpression,
  type BinaryExpression,
  type PropertyAccessExpression,
  type QualifiedName,
} from 'typescript/unstable/ast';
import {
  emptySource,
  lineCount,
  locations,
  oneLine,
  type Binding,
  type ExtractedFile,
} from './model.ts';

type SyntaxNode = Node & {
  name?: Node;
  propertyName?: Node;
  expression?: Node;
  moduleSpecifier?: Node;
  importClause?: Node;
  namedBindings?: Node;
  exportClause?: Node;
  elements?: readonly Node[];
  modifiers?: readonly Node[];
  initializer?: Node;
  body?: Node;
  members?: readonly Node[];
};

const declarationKinds = new Map([
  [K.FunctionDeclaration, 'function'],
  [K.FunctionExpression, 'function'],
  [K.ClassDeclaration, 'class'],
  [K.ClassExpression, 'class'],
  [K.InterfaceDeclaration, 'interface'],
  [K.TypeAliasDeclaration, 'type'],
  [K.EnumDeclaration, 'enum'],
  [K.EnumMember, 'member'],
  [K.ModuleDeclaration, 'namespace'],
  [K.VariableDeclaration, 'variable'],
  [K.BindingElement, 'variable'],
  [K.Parameter, 'parameter'],
  [K.TypeParameter, 'type parameter'],
  [K.MethodDeclaration, 'method'],
  [K.MethodSignature, 'method'],
  [K.PropertyDeclaration, 'property'],
  [K.PropertySignature, 'property'],
  [K.GetAccessor, 'getter'],
  [K.SetAccessor, 'setter'],
  [K.PropertyAssignment, 'property'],
]);

function nameOf(node: Node | undefined) {
  if (node && (isIdentifier(node) || isStringLiteral(node) || node.kind === K.PrivateIdentifier))
    return (node as Identifier).text;
}

function loadedModule(node: Node | undefined) {
  if (node?.kind !== K.CallExpression) return;
  const { expression, arguments: args } = node as CallExpression;
  if (nameOf(expression) === 'require' || expression.kind === K.ImportKeyword)
    return nameOf(args[0]);
}

function commonJsExport(node: Node) {
  if (node.kind !== K.PropertyAccessExpression) return;
  const { expression, name } = node as PropertyAccessExpression;
  if (nameOf(expression) === 'exports') return name.text;
  if (nameOf(expression) === 'module' && name.text === 'exports') return 'default';
  if (expression.kind === K.PropertyAccessExpression) {
    const receiver = expression as PropertyAccessExpression;
    if (nameOf(receiver.expression) === 'module' && receiver.name.text === 'exports')
      return name.text;
  }
}

function moduleScope(node: Node) {
  const names: string[] = [];
  for (
    let parent = node.parent;
    parent?.kind === K.ModuleBlock || parent?.kind === K.ModuleDeclaration;
    parent = parent.parent
  ) {
    if (parent.kind !== K.ModuleDeclaration) continue;
    const name = nameOf((parent as SyntaxNode).name);
    if (name) names.unshift(name);
  }
  return names;
}

function triviaEnd(text: string, node: Node) {
  trivia.lastIndex = node.pos;
  return trivia.exec(text) ? trivia.lastIndex : node.pos;
}
const trivia = /(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|#![^\r\n]*)*/y;

function sourceFile(
  program: import('typescript/unstable/sync').Program,
  checker: import('typescript/unstable/sync').Checker,
  file: SourceFile,
): ExtractedFile {
  const text = file.text;
  const at = locations(text);
  const base = {
    kind: /\.[cm]?tsx?$/i.test(file.fileName) ? 'TypeScript' : 'JavaScript',
    lines: lineCount(text),
    text,
  };
  const diagnostic = program.getSyntacticDiagnostics(file.fileName)[0];
  if (diagnostic)
    return {
      ...base,
      coverage: 'skipped',
      reason: `Syntax error: ${oneLine(diagnostic.text)}`,
      errorLine: at(diagnostic.pos ?? 0).line,
    };

  const source = emptySource();
  const declarations = new Map<Node, number>();
  const aliases = new Map<Node, Binding>();
  const uses: { node: Node; position: Node; member?: string }[] = [];
  const localExports: { name: string; node: Node; scope?: string[] }[] = [];
  const seen = new Set<number>();
  const addUse = (position: Node, binding: Binding) => {
    const offset = triviaEnd(text, position);
    if (seen.has(offset)) return;
    seen.add(offset);
    source.occurrences.push({ ...at(offset), binding });
  };
  const addDefinition = (node: SyntaxNode, name: string, kind: string) => {
    const start = triviaEnd(text, node);
    const offset = node.name ? triviaEnd(text, node.name) : start;
    const signatureEnd =
      node.body?.pos ??
      (node.initializer as SyntaxNode | undefined)?.body?.pos ??
      node.members?.[0]?.pos ??
      node.initializer?.pos ??
      node.end;
    const doc = text
      .slice(node.pos, start)
      .match(/\/\*\*([\s\S]*?)\*\//)?.[1]
      ?.split('\n')
      .map((line) => line.trim().replace(/^\*\s*/, ''))
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
    declarations.set(node, offset);
    source.definitions.push({
      ...at(offset),
      name,
      kind,
      signature: oneLine(text.slice(start, Math.min(start + 350, signatureEnd))),
      ...(doc ? { doc: oneLine(doc) } : {}),
    });
    return offset;
  };

  function walk(node: SyntaxNode) {
    const module = nameOf(node.moduleSpecifier);
    if (node.kind === K.ImportDeclaration && module) {
      const clause = node.importClause as SyntaxNode | undefined;
      const bind = (declaration: Node, position: Node, name: string) => {
        const binding = { module, name };
        aliases.set(declaration, binding);
        addUse(position, binding);
      };
      if (clause?.name) bind(clause, clause.name, 'default');
      const named = clause?.namedBindings as SyntaxNode | undefined;
      if (named?.name) bind(named, named.name, '*');
      for (const item of (named?.elements ?? []) as SyntaxNode[]) {
        const name = nameOf(item.propertyName ?? item.name);
        if (name && item.name) bind(item, item.propertyName ?? item.name, name);
      }
      if (!clause) addUse(node.moduleSpecifier!, { module, name: '' });
      return;
    }
    if (node.kind === K.ExportDeclaration) {
      const clause = node.exportClause as SyntaxNode | undefined;
      if (module) {
        if (!clause || clause.name) {
          const name = nameOf(clause?.name) ?? '*';
          const target = clause?.name ? addDefinition(clause, name, 'namespace') : undefined;
          source.exports.push({ name, target, binding: { module, name: '*' } });
          addUse(clause?.name ?? node.moduleSpecifier!, { module, name: '*' });
        }
        for (const item of (clause?.elements ?? []) as SyntaxNode[]) {
          const name = nameOf(item.name);
          const original = nameOf(item.propertyName ?? item.name);
          if (name && original) {
            source.exports.push({ name, binding: { module, name: original } });
            addUse(item.propertyName ?? item.name!, { module, name: original });
          }
        }
      } else
        for (const item of (clause?.elements ?? []) as SyntaxNode[]) {
          const name = nameOf(item.name);
          const original = item.propertyName ?? item.name;
          if (name && original)
            localExports.push({ name, node: original, scope: moduleScope(node) });
        }
      return;
    }
    if (node.kind === K.ExportAssignment && node.expression) {
      const name = (node as import('typescript/unstable/ast').ExportAssignment).isExportEquals
        ? 'export='
        : 'default';
      if (isIdentifier(node.expression)) localExports.push({ name, node: node.expression });
      else source.exports.push({ name, target: addDefinition(node, name, 'value') });
    }

    if (node.kind === K.BinaryExpression && node.parent?.parent === file) {
      const { left, right, operatorToken } = node as BinaryExpression;
      const name = operatorToken.kind === K.EqualsToken && commonJsExport(left);
      if (name) {
        if (isIdentifier(right)) localExports.push({ name, node: right });
        else {
          const target = addDefinition(
            left,
            name,
            right.kind === K.FunctionExpression || right.kind === K.ArrowFunction
              ? 'function'
              : 'value',
          );
          source.exports.push({ name, target });
        }
      }
    }

    const importModule = loadedModule(node.initializer);
    if (importModule && node.name) {
      if (isIdentifier(node.name)) aliases.set(node, { module: importModule, name: '*' });
      for (const item of ((node.name as SyntaxNode).elements ?? []) as SyntaxNode[]) {
        const name = nameOf(item.propertyName ?? item.name);
        if (name && item.name) {
          const binding = { module: importModule, name };
          aliases.set(item, binding);
          addUse(item.propertyName ?? item.name, binding);
        }
      }
    }
    const kind = declarationKinds.get(node.kind);
    const declarationOwner =
      node.parent?.kind === K.VariableDeclarationList ? (node.parent.parent as SyntaxNode) : node;
    const modifiers = declarationOwner.modifiers;
    const isDefault = modifiers?.some((item) => item.kind === K.DefaultKeyword);
    const name = nameOf(node.name) ?? (isDefault ? 'default' : undefined);
    if (kind && name) {
      const initializer = node.initializer?.kind;
      const target = addDefinition(
        node,
        name,
        initializer === K.ArrowFunction || initializer === K.FunctionExpression ? 'function' : kind,
      );
      if (declarationOwner.parent === file || declarationOwner.parent?.kind === K.ModuleBlock) {
        if (modifiers?.some((item) => item.kind === K.ExportKeyword)) {
          const scope = moduleScope(declarationOwner);
          source.exports.push({ name: isDefault ? 'default' : name, target, scope });
        }
      }
    }
    if (node.kind === K.PropertyAccessExpression || node.kind === K.QualifiedName) {
      const property = node.name ?? (node as QualifiedName).right;
      const lhs = node.expression ?? (node as QualifiedName).left;
      const member = nameOf(property);
      if (member && lhs && isIdentifier(lhs)) uses.push({ node: lhs, position: property!, member });
      const dependency = loadedModule(lhs);
      if (member && dependency) addUse(property!, { module: dependency, name: member });
    }
    if (node.kind === K.CallExpression) {
      const dependency = loadedModule(node);
      if (dependency && node.parent?.kind !== K.PropertyAccessExpression) {
        const declaration = node.parent as SyntaxNode;
        if (declaration?.name?.kind !== K.ObjectBindingPattern)
          addUse((node as CallExpression).arguments[0], { module: dependency, name: '' });
      }
    }
    if (isIdentifier(node) || node.kind === K.PrivateIdentifier) {
      const parent = node.parent as SyntaxNode;
      if (!(parent?.name === node && declarations.has(parent))) uses.push({ node, position: node });
    }
    return true;
  }
  const stack: Node[] = [file];
  while (stack.length) {
    const node = stack.pop()!;
    if (!walk(node)) continue;
    const start = stack.length;
    visitEachChild(node, (child) => {
      stack.push(child);
      return child;
    });
    // Keep sibling traversal in source order without recursing on generated ASTs.
    for (let left = start, right = stack.length - 1; left < right; left++, right--)
      [stack[left], stack[right]] = [stack[right], stack[left]];
  }

  for (const { name, node, scope } of localExports) {
    const symbol =
      node.parent?.kind === K.ExportSpecifier
        ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    for (const handle of symbol?.declarations ?? []) {
      const declaration = handle.resolve();
      if (!declaration) continue;
      const binding = aliases.get(declaration);
      const target = declarations.get(declaration);
      if (binding) source.exports.push({ name, binding, scope });
      else if (target !== undefined) source.exports.push({ name, target, scope });
      else continue;
      break;
    }
  }
  // The API batches checker calls across the process boundary. Use it only for
  // local binding identities; imports are resolved against the stored graph.
  for (let i = 0; i < uses.length; i += 2048) {
    const batch = uses.slice(i, i + 2048);
    const symbols = checker.getSymbolAtLocation(batch.map(({ node }) => node));
    for (const [index, { position, member }] of batch.entries()) {
      const offset = triviaEnd(text, position);
      if (seen.has(offset)) continue;
      const symbol = symbols[index];
      const handles = symbol?.valueDeclaration
        ? [symbol.valueDeclaration, ...symbol.declarations]
        : (symbol?.declarations ?? []);
      for (const handle of handles) {
        const declaration = handle.resolve();
        if (!declaration) continue;
        const binding = aliases.get(declaration);
        const target = declarations.get(declaration);
        if (binding) {
          // The property of a namespace import carries the use. An identifier
          // on its own still records package usage when passed as a value.
          const parent = position.parent as SyntaxNode;
          if (
            !member &&
            binding.name === '*' &&
            ((parent?.expression === position && parent.kind === K.PropertyAccessExpression) ||
              (parent?.kind === K.QualifiedName && (parent as QualifiedName).left === position))
          )
            break;
          addUse(
            position,
            member
              ? { ...binding, member, ...(binding.name === '*' ? {} : { optionalMember: true }) }
              : binding,
          );
        } else if (!member && target !== undefined && target !== offset) {
          seen.add(offset);
          source.occurrences.push({ ...at(offset), target });
        } else continue;
        break;
      }
    }
  }
  return { ...base, coverage: 'symbols', source };
}

export function extractTypeScript(inputs: { path: string; text: string }[]): ExtractedFile[] {
  if (!inputs.length) return [];
  const root = '/deploy-code-index';
  const config = root + '/tsconfig.json';
  // Virtual filenames are generated from trusted indexes. No repository path,
  // tsconfig, installed dependency or ambient type is loaded by the compiler.
  const names = inputs.map(
    ({ path }, i) =>
      `${i}/source${path.match(/(?:\.d)?\.[cm]?[jt]sx?$/i)?.[0].toLowerCase() ?? '.ts'}`,
  );
  const files = Object.fromEntries(inputs.map(({ text }, i) => [root + '/' + names[i], text]));
  files[config] = JSON.stringify({
    compilerOptions: { allowJs: true, jsx: 'preserve', noLib: true, noResolve: true, types: [] },
    files: names,
  });
  const virtual = createVirtualFileSystem(files);
  const api = new API({
    fs: {
      ...virtual,
      readFile: (file) => virtual.readFile?.(file) ?? null,
      fileExists: (file) => virtual.fileExists?.(file) ?? false,
      directoryExists: (dir) => virtual.directoryExists?.(dir) ?? false,
      getAccessibleEntries: (dir) =>
        virtual.getAccessibleEntries?.(dir) ?? { files: [], directories: [] },
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const { program, checker } = snapshot.getProject(config)!;
      return names.map((name, index) => {
        const file = program.getSourceFile(root + '/' + name);
        if (!file) throw new Error(`TypeScript could not load virtual source ${index}`);
        return sourceFile(program, checker, file);
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
