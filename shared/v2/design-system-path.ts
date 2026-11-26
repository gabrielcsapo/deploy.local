// Which design system a project's boards use, and where its files are. A project names it in
// canvas.json ("designSystem": "ds/larder"); otherwise it is the one folder under design/ds/
// (deploy.local's own repository has ds/deploy-local). Two layouts are read: deploy.local's
// (tokens.css, tokens.json, components/library.json, components/bundle.css) and the CLI starter's
// (tokens.css, components.css, library.json, README.md, examples/). A project with none has none:
// nothing falls back to deploy.local's.

/** "ds/larder" for a project: from canvas.json, else the single folder in design/ds. */
export function designSystemFolder(
  canvas: { designSystem?: unknown } | null | undefined,
  folders: string[],
): string | null {
  const named = typeof canvas?.designSystem === 'string' ? canvas.designSystem.trim() : '';
  if (named) return named.replace(/^design\//, '').replace(/\/+$/, '');
  const found = folders.filter((name) => /^[A-Za-z0-9_.-]+$/.test(name)).sort();
  if (!found.length) return null;
  if (found.length === 1) return `ds/${found[0]}`;
  // Several and none named: deploy.local's own, when it is one of them, else the first.
  return `ds/${found.includes('deploy-local') ? 'deploy-local' : found[0]}`;
}

/** The files of a design system, by role, as paths under design/, in the order to try them. */
export function designSystemPaths(folder: string) {
  return {
    tokensJson: [`${folder}/tokens.json`],
    tokensCss: [`${folder}/tokens.css`],
    library: [`${folder}/components/library.json`, `${folder}/library.json`],
    bundle: [`${folder}/components/bundle.css`, `${folder}/components.css`],
    // deploy.local keeps its rules beside the system, at ds/README.md.
    readme: [`${folder}/README.md`, 'ds/README.md'],
    examples: `${folder}/examples`,
  };
}

/** The first of these files that exists, by a reader that answers null for a missing one. */
export async function firstFile(
  paths: string[],
  read: (path: string) => Promise<string | null> | string | null,
) {
  for (const path of paths) {
    const text = await read(path);
    if (text !== null && text !== undefined) return { path, text };
  }
  return null;
}
