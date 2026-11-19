export type Ecosystem = 'npm' | 'cargo';
export type Confidence = 'checker' | 'module' | 'path';
export type Location = { offset: number; line: number; column: number };
export type Definition = Location & {
  name: string;
  kind: string;
  signature: string;
  doc?: string;
  scope?: string[];
};
export type Binding = { module: string; name: string; member?: string; optionalMember?: boolean };
export type Occurrence = Location & {
  target?: number;
  binding?: Binding;
  scope?: string[];
};
export type Export = { name: string; target?: number; binding?: Binding; scope?: string[] };
export type Source = { definitions: Definition[]; occurrences: Occurrence[]; exports: Export[] };
export type Entry = { name: string; path: string; exposure: 'import' | 'bin' | 'entry' };
export type Dependency = { alias: string; name: string; requirement?: string };
export type Manifest = {
  ecosystem: Ecosystem;
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  entries: Entry[];
  dependencies: Dependency[];
  inheritDependencies?: string[];
  workspaceDependencies?: Dependency[];
  workspaceVersion?: string;
  wildcardEntries?: boolean;
};
export type Locked = Record<string, string[]>;
export type Lock = { ecosystem: Ecosystem; versions: Locked; importers?: Record<string, Locked> };
export type ExtractedFile = {
  kind: string;
  coverage: 'symbols' | 'packages' | 'text' | 'skipped';
  lines: number;
  reason?: string;
  errorLine?: number;
  text?: string;
  source?: Source;
  manifest?: Manifest;
  lock?: Lock;
  title?: string;
};
export type IndexProject = {
  id: string;
  name: string;
  description?: string;
  repositoryPath: string;
  defaultBranch: string;
};
export type IndexStatus = {
  project: string;
  commit: string;
  branch: string;
  indexedAt: string;
  durationMs: number;
  computer: string;
  extractedFiles: number;
  incremental: number;
  omittedFiles: number;
};
export const emptySource = (): Source => ({ definitions: [], occurrences: [], exports: [] });
export const fileLimit = 1024 * 1024;
export const projectByteLimit = 96 * fileLimit;
export const projectFileLimit = 20_000;

export function locations(text: string) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g))
    starts.push(match.index + match[0].length);
  return (offset: number): Location => {
    let low = 0;
    let high = starts.length;
    while (high - low > 1) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return { offset, line: low + 1, column: offset - starts[low] + 1 };
  };
}

export const oneLine = (text: string, limit = 200) =>
  text.trim().replace(/\s+/g, ' ').slice(0, limit);
export const lineCount = (text: string) =>
  text
    ? (text.match(/\r\n|[\n\r\u2028\u2029]/g)?.length ?? 0) +
      Number(!/[\n\r\u2028\u2029]$/.test(text))
    : 0;
