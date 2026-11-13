#!/usr/bin/env node
// Every field in shared/v2/contracts.ts (with workspace.ts) must have a Swift counterpart in
// DeployCore, or be listed below as a known gap. A new TypeScript field fails this check until the
// iPhone app decodes it or someone records here why it doesn't need to.
//
// The Swift types stay hand-written: their names, number types, initializers and custom decoding
// (kind-tagged unions, defaults, renamed keys) are the app's public API, so they are not generated.
// This check follows each TypeScript type into the Swift type that decodes it: the same name, or
// V2<name>, or the table below; then each property into its declared Swift type.
//
//   node scripts/check-swift-contracts.mjs          check (pnpm lint runs this)
//   node scripts/check-swift-contracts.mjs --list   print every gap, to review the list below
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseSync } from 'vite';

const rootFlag = process.argv.indexOf('--root');
const root =
  rootFlag > 0 ? resolve(process.argv[rootFlag + 1]) : resolve(import.meta.dirname, '..');
const contracts = join(root, 'shared/v2/contracts.ts');
const swiftRoot = join(root, 'native/Apple/Packages/DeployKit/Sources/DeployCore');

/**
 * TypeScript types the iPhone app decodes under another Swift name, and the ones where both
 * `Name` and `V2Name` exist, so the table says which one.
 */
const swiftNames = {
  Agent: 'Agent',
  AgentApprovalRule: 'V2ApprovalRule',
  AgentConfiguration: 'V2Agent',
  ApprovalRule: 'ApprovalRule',
  BackupPoint: 'V2Backup',
  BackupRestore: 'V2Restore',
  BackupsResponse: 'V2Backups',
  Computer: 'V2Computer',
  DesignRect: 'V2ReviewRect',
  DesignReviewChange: 'V2ReviewChange',
  DesignReviewDrawing: 'V2ReviewDrawing',
  DesignReviewPin: 'V2ReviewPin',
  DesignReviewPreview: 'V2ReviewPreview',
  DesignReviewResolution: 'V2ReviewResolution',
  DesignReviewRow: 'V2ReviewRow',
  DesignReviewScreen: 'V2DesignReview.Board',
  DesignReviewSummary: 'V2ReviewSummary',
  EventPage: 'EventPage',
  LiveAppResponse: 'V2LiveDetail',
  LiveResponse: 'V2Live',
  ModelChoice: 'V2Model',
  NodePermissionStep: 'NodePermission.Step',
  Project: 'V2Project',
  Worker: 'Worker',
  WorkspaceProject: 'Project',
};

/** TypeScript types the iPhone app does not decode today. Map one here once it does. */
const notMirrored = Object.fromEntries(
  [
    'AgentTracking',
    'ApprovalSuggestion',
    'ComputerModels',
    'ComputerRemoval',
    'ComputerUpdateOverview',
    'ComputerUpdates',
    'CreateWorkspaceTaskRequest',
    'DesignApproved',
    'DesignBuildDecision',
    'DesignBuildReport',
    'DesignCheckBoard',
    'ModelDefaults',
    'ProjectReleaseSettings',
    'ProjectSetting',
    'ProjectSettings',
    'ReleasePart',
    'RollbackDataLoss',
    'SelfUpdateChange',
    'SelfUpdateRun',
    'SelfUpdateStatus',
    'SelfUpdateStep',
    'TaskDesignCheck',
    'TaskRequirementsSnapshot',
  ].map((name) => [name, 'No Swift type decodes it.']),
);

/** Fields the Swift type does not decode today. Remove an entry once Swift decodes the field. */
const knownGaps = [
  'AgentConfiguration.createdBy (Swift V2Agent)',
  'AgentConfiguration.triggers (Swift V2Agent)',
  'AgentConfiguration.apps (Swift V2Agent)',
  'BackupsResponse.schedules (Swift V2Backups)',
  'Computer.nodeId (Swift V2Computer)',
  'Computer.workerIds (Swift V2Computer)',
  'Computer.supportedRoles (Swift V2Computer)',
  'Computer.has (Swift V2Computer)',
  'Computer.platform (Swift V2Computer)',
  'Computer.architecture (Swift V2Computer)',
  'Computer.version (Swift V2Computer)',
  'Computer.cpu (Swift V2Computer)',
  'Computer.cpuModel (Swift V2Computer)',
  'Computer.memory (Swift V2Computer)',
  'Computer.disk (Swift V2Computer)',
  'Computer.doing (Swift V2Computer)',
  'DesignReview.resolutions.mainExists (Swift V2ReviewResolution)',
  'DesignReview.resolutions.proposalExists (Swift V2ReviewResolution)',
  'DesignReview.item.designCheck (Swift InboxItem)',
  'DesignReview.proposerTaskId (Swift V2DesignReview)',
  'DesignReview.landing.commit (Swift V2ReviewLanding)',
  'DesignReview.landing.build (Swift V2ReviewLanding)',
  'DesignReview.boards.resolution.mainExists (Swift V2ReviewResolution)',
  'DesignReview.boards.resolution.proposalExists (Swift V2ReviewResolution)',
  'DesignReview.boards.previews (Swift V2DesignReview.Board)',
  'DesignReviewResolution.mainExists (Swift V2ReviewResolution)',
  'DesignReviewResolution.proposalExists (Swift V2ReviewResolution)',
  'DesignReviewScreen.resolution.mainExists (Swift V2ReviewResolution)',
  'DesignReviewScreen.resolution.proposalExists (Swift V2ReviewResolution)',
  'DesignReviewScreen.previews (Swift V2DesignReview.Board)',
  'DesignReviewSummary.resolutions (Swift V2ReviewSummary)',
  'InboxItem.designCheck (Swift InboxItem)',
  'LiveApp.source (Swift V2LiveApp)',
  'LiveApp.fromDiscover (Swift V2LiveApp)',
  'LiveAppResponse.app.source (Swift V2LiveApp)',
  'LiveAppResponse.app.fromDiscover (Swift V2LiveApp)',
  'LiveAppResponse.release (Swift V2LiveDetail)',
  'LiveResponse.rollbacks (Swift V2Live)',
  'LiveResponse.computers.apps.source (Swift V2LiveApp)',
  'LiveResponse.computers.apps.fromDiscover (Swift V2LiveApp)',
  'ModelChoice.provider (Swift V2Model)',
  'ModelChoice.model (Swift V2Model)',
  'Project.fromDiscover (Swift V2Project)',
  'Release.source.commit (Swift ReleaseSource)',
  'Release.source.message (Swift ReleaseSource)',
  'Release.source.gitRef (Swift ReleaseSource)',
  'Release.steps.parts (Swift ReleaseStep)',
  'Release.steps.verifyEmptyResources (Swift ReleaseStep)',
  'Rollback.steps.parts (Swift ReleaseStep)',
  'Rollback.steps.verifyEmptyResources (Swift ReleaseStep)',
];

// ---------------------------------------------------------------------------------------------
// Swift: each type's stored properties (by JSON key), and enum cases with one payload type.

function swiftFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.name.endsWith('.swift') ? [path] : [];
  });
}

function closing(text, start) {
  let depth = 1;
  let end = start;
  while (depth && end < text.length) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}') depth--;
    end++;
  }
  return end;
}

/** A declaration's own level, with nested bodies blanked (newlines kept). */
function ownLevel(body) {
  let own = '';
  let level = 0;
  for (const character of body) {
    if (character === '{') level++;
    own += level === 0 || character === '\n' ? character : ' ';
    if (character === '}') level--;
  }
  return own;
}

/** Types by qualified name (`V2Client.Computer`), following nested types and extensions. */
function parseSwift() {
  const types = new Map();
  const visit = (text, scope) => {
    const own = ownLevel(text);
    const declaration = /\b(struct|class|enum|extension)\s+([A-Za-z_][\w.]*)[^\n]*$/gm;
    for (const match of own.matchAll(declaration)) {
      // The declaration's `{` is blanked in `own` when it opens on this line; find the real one.
      const open = text.indexOf('{', match.index);
      if (open < 0) continue;
      const end = closing(text, open + 1);
      const body = text.slice(open + 1, end - 1);
      const name = match[1] === 'extension' ? match[2] : scope ? `${scope}.${match[2]}` : match[2];
      if (match[1] !== 'extension') {
        const type = {
          enum: match[1] === 'enum',
          properties: new Map(),
          cases: new Map(),
          raw: [],
          keys: null,
        };
        // `var a: String; var b: String` declares two properties.
        const statements = body.replace(/;/g, '\n');
        const originals = statements.split('\n');
        for (const [index, line] of ownLevel(statements).split('\n').entries()) {
          if (/\bstatic\b/.test(line)) continue;
          const property = line.match(
            /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|internal|fileprivate|package)(?:\(set\))?\s+)*(?:var|let)\s+`?([A-Za-z_]\w*)`?\s*:\s*([^=]+?)\s*(=.*)?$/,
          );
          // A body after the type (`var x: Int { … }`) is a computed property: no JSON key.
          const computed = /^[^=]*\{/.test(originals[index] ?? '');
          if (property && !computed) type.properties.set(property[1], property[2].trim());
          const payload = line.match(
            /^\s*(?:indirect\s+)?case\s+([A-Za-z_]\w*)\(\s*([A-Za-z_][\w.]*)\s*\)/,
          );
          if (payload) type.cases.set(payload[1], payload[2]);
          else {
            const plain = line.match(/^\s*case\s+(.+)$/);
            if (plain)
              for (const part of plain[1].split(',')) {
                const named = part.trim().match(/^([A-Za-z_]\w*)(?:\s*=\s*"([^"]+)")?/);
                if (named) type.raw.push([named[2] ?? named[1], named[1]]);
              }
          }
        }
        if (!types.has(name)) types.set(name, type);
      }
      visit(body, name);
    }
  };
  for (const file of swiftFiles(swiftRoot))
    visit(
      readFileSync(file, 'utf8')
        .replace(/"(?:[^"\\\n]|\\.)*"/g, (text) => text.replace(/[{}]/g, ' '))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, ''),
      '',
    );
  // A CodingKeys enum lists the JSON keys its type reads.
  for (const [name, type] of types) {
    const codingKeys = types.get(`${name}.CodingKeys`);
    if (codingKeys) type.keys = new Map(codingKeys.raw);
  }
  return types;
}

/** A type name as written inside `scope`: nested first, then outward, then top level. */
function resolveSwift(name, scope) {
  if (!name) return null;
  for (let prefix = scope; prefix; prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf('.'))))
    if (swift.has(`${prefix}.${name}`)) return `${prefix}.${name}`;
  return swift.has(name) ? name : null;
}

/** The Swift type a property decodes into: `[Foo]?` → `Foo`. Dictionaries are opaque. */
function baseSwiftType(declared) {
  const type = declared.replace(/[?!]/g, '').trim();
  if (/^\[[^\]]*:[^\]]*\]$/.test(type) || /^Dictionary</.test(type)) return null;
  const array = type.match(/^\[(.+)\]$/) || type.match(/^Array<(.+)>$/);
  return array ? baseSwiftType(array[1]) : type;
}

// ---------------------------------------------------------------------------------------------
// TypeScript: read the type aliases syntactically and resolve them to object shapes.

const aliases = new Map(); // `${file}#${name}` → annotation
const imports = new Map(); // file → Map<local name, `${file}#${name}`>
const exportsOf = new Map(); // file → names (with `export type *` followed)

const moduleFile = (from, specifier) => {
  const path = resolve(dirname(from), specifier);
  return path.endsWith('.ts') ? path : `${path}.ts`;
};

function load(file) {
  if (exportsOf.has(file)) return;
  const { program, errors } = parseSync(file, readFileSync(file, 'utf8'), { lang: 'ts' });
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const names = new Set();
  const local = new Map();
  exportsOf.set(file, names);
  imports.set(file, local);
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'TSTypeAliasDeclaration') {
      aliases.set(`${file}#${declaration.id.name}`, declaration.typeAnnotation);
      if (statement.type === 'ExportNamedDeclaration') names.add(declaration.id.name);
    } else if (statement.type === 'ExportAllDeclaration') {
      const target = moduleFile(file, statement.source.value);
      load(target);
      for (const name of exportsOf.get(target)) {
        names.add(name);
        local.set(name, `${target}#${name}`);
      }
    } else if (statement.type === 'ImportDeclaration' && statement.source.value.startsWith('.')) {
      const target = moduleFile(file, statement.source.value);
      load(target);
      for (const specifier of statement.specifiers ?? [])
        local.set(
          specifier.local.name,
          `${target}#${specifier.imported?.name ?? specifier.local.name}`,
        );
    }
  }
}

function lookup(file, name) {
  if (aliases.has(`${file}#${name}`)) return { file, node: aliases.get(`${file}#${name}`) };
  const imported = imports.get(file)?.get(name);
  if (imported && aliases.has(imported))
    return { file: imported.split('#')[0], node: aliases.get(imported) };
  return null;
}

const literal = (node) =>
  node?.type === 'TSLiteralType' && typeof node.literal.value === 'string'
    ? node.literal.value
    : null;
const literals = (node) =>
  node.type === 'TSUnionType' ? node.types.map(literal) : [literal(node)];

/**
 * The object shapes a type stands for: a list of `Map<field, { file, node }>` (one per union
 * member), or null when it is not an object (a string, a union of literals, a Record of data).
 */
function shapes(file, node, depth = 0) {
  if (!node || depth > 20) return null;
  switch (node.type) {
    case 'TSParenthesizedType':
      return shapes(file, node.typeAnnotation, depth + 1);
    case 'TSArrayType':
      return shapes(file, node.elementType, depth + 1);
    case 'TSTypeLiteral': {
      if (node.members.some((member) => member.type === 'TSIndexSignature')) return null;
      const fields = new Map();
      for (const member of node.members)
        if (member.type === 'TSPropertySignature') {
          const key = member.key.name ?? member.key.value;
          fields.set(key, { file, node: member.typeAnnotation?.typeAnnotation });
        }
      return [fields];
    }
    case 'TSUnionType': {
      const all = node.types.flatMap((part) => shapes(file, part, depth + 1) ?? []);
      return all.length ? all : null;
    }
    case 'TSIntersectionType': {
      const parts = node.types.map((part) => shapes(file, part, depth + 1)).filter(Boolean);
      if (!parts.length) return null;
      // A & (B | C) → (A & B) | (A & C).
      return parts.reduce((left, right) =>
        left.flatMap((a) => right.map((b) => new Map([...a, ...b]))),
      );
    }
    case 'TSImportType': {
      const target = moduleFile(file, node.source?.value ?? node.argument?.literal?.value);
      load(target);
      const name = node.qualifier?.name;
      const found = name && lookup(target, name);
      return found ? shapes(found.file, found.node, depth + 1) : null;
    }
    case 'TSIndexedAccessType': {
      if (node.indexType.type === 'TSNumberKeyword')
        return shapes(file, node.objectType, depth + 1);
      const key = literal(node.indexType);
      const object = shapes(file, node.objectType, depth + 1);
      const field = object?.map((shape) => shape.get(key)).find(Boolean);
      return field ? shapes(field.file, field.node, depth + 1) : null;
    }
    case 'TSTypeReference': {
      const name = node.typeName.name;
      const args = node.typeArguments?.params ?? [];
      if (name === 'Array' || name === 'Partial' || name === 'Required' || name === 'Readonly')
        return shapes(file, args[0], depth + 1);
      if (name === 'Omit' || name === 'Pick') {
        const keys = new Set(literals(args[1]));
        const inner = shapes(file, args[0], depth + 1);
        return inner?.map(
          (shape) =>
            new Map(
              [...shape].filter(([key]) => (name === 'Omit' ? !keys.has(key) : keys.has(key))),
            ),
        );
      }
      if (name === 'Record') {
        const keys = literals(args[0]);
        if (keys.some((key) => key === null)) return null;
        return [new Map(keys.map((key) => [key, { file, node: args[1] }]))];
      }
      const found = lookup(file, name);
      return found ? shapes(found.file, found.node, depth + 1) : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Compare.

const swift = parseSwift();
const missing = [];
const unmapped = [];
const checked = new Set();

function compare(path, list, swiftName) {
  const key = `${path}→${swiftName}`;
  if (checked.has(key)) return;
  checked.add(key);
  const target = swift.get(swiftName);
  // A union tagged by `kind`, decoded by a Swift enum with one case per kind.
  const kinds = list.map((shape) => literal(shape.get('kind')?.node));
  if (list.length > 1 && kinds.every(Boolean) && target.cases.size) {
    list.forEach((shape, index) => {
      const kind = kinds[index];
      const caseName = target.cases.get(kind.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
      const caseType = resolveSwift(caseName, swiftName);
      if (!caseName) missing.push(`${path}#${kind} (no case in Swift ${swiftName})`);
      else if (caseType) {
        const fields = new Map(shape);
        fields.delete('kind');
        compare(`${path}#${kind}`, [fields], caseType);
      }
    });
    return;
  }
  // Any other Swift enum decodes its value by hand (a string or an object): nothing to match.
  if (target.enum) return;
  const fields = new Map();
  for (const shape of list)
    for (const [name, field] of shape) if (!fields.has(name)) fields.set(name, field);
  for (const [name, field] of fields) {
    const property = target.keys ? target.keys.get(name) : name;
    if (!property || !(target.keys || target.properties.has(name))) {
      missing.push(`${path}.${name} (Swift ${swiftName})`);
      continue;
    }
    const nested = shapes(field.file, field.node);
    const nestedSwift =
      target.properties.has(property) &&
      resolveSwift(baseSwiftType(target.properties.get(property)), swiftName);
    if (nested && nestedSwift) compare(`${path}.${name}`, nested, nestedSwift);
  }
}

load(contracts);
const exported = exportsOf.get(contracts);
for (const name of [...exported].sort()) {
  if (name in notMirrored) continue;
  const found = lookup(contracts, name);
  const list = found && shapes(found.file, found.node);
  if (!list) continue; // string unions and primitives: nothing to compare
  // Both `Name` and `V2Name` exist for some types; the table must say which one decodes it.
  const candidates = [name, `V2${name}`].filter((candidate) => swift.has(candidate));
  const swiftName = swiftNames[name] ?? (candidates.length === 1 ? candidates[0] : null);
  if (!swiftName || !swift.has(swiftName)) unmapped.push(name);
  else compare(name, list, swiftName);
}

if (process.argv.includes('--list')) {
  for (const entry of missing) console.log(`  ${JSON.stringify(entry)},`);
  for (const entry of unmapped) console.log(`unmapped ${entry}`);
  process.exit(0);
}
const problems = [];
const gaps = new Set(knownGaps);
for (const entry of missing)
  if (!gaps.has(entry)) problems.push(`A TypeScript field has no Swift counterpart: ${entry}`);
for (const entry of knownGaps)
  if (!missing.includes(entry))
    problems.push(`Swift now decodes ${entry}: remove it from knownGaps`);
for (const name of unmapped)
  problems.push(`${name} has no Swift type: map it in swiftNames or explain it in notMirrored`);
for (const name of Object.keys({ ...swiftNames, ...notMirrored }))
  if (!exported.has(name)) problems.push(`${name} is listed but no longer exported`);
if (problems.length) {
  console.error('Swift contracts are out of step with shared/v2/contracts.ts:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    'Decode the field in native/Apple/Packages/DeployKit/Sources/DeployCore, or record why not in scripts/check-swift-contracts.mjs.',
  );
  process.exit(1);
}
console.log(`Swift contracts: ${checked.size} types compared, ${knownGaps.length} known gaps.`);
