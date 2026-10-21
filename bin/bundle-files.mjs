import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { compileDeployYaml } from '../server/application-spec.ts';

export function getDeployManifestName(dir) {
  return existsSync(resolve(dir, 'deploy.yaml')) ? 'deploy.yaml' : null;
}

export function getIgnorePatterns(dir) {
  const manifestName = getDeployManifestName(dir);
  if (manifestName === 'deploy.yaml') {
    const source = readFileSync(resolve(dir, manifestName), 'utf-8');
    const { spec } = compileDeployYaml(source, manifestName);
    return [
      ...new Set(
        Object.values(spec.components).flatMap((component) => component.build?.ignore ?? []),
      ),
    ];
  }

  return [];
}

export function listBundleFiles(dir) {
  const manifestName = getDeployManifestName(dir);
  const ignorePatterns = getIgnorePatterns(dir);
  const excludes = ['node_modules', ...ignorePatterns];

  let isGitRepo = false;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
    isGitRepo = true;
  } catch {}

  if (isGitRepo) {
    const allFiles = execSync('git ls-files -co --exclude-standard -z', {
      cwd: dir,
      encoding: 'utf-8',
    })
      .split('\0')
      .filter(Boolean);

    // Always include the deployment manifest even if gitignored — the server
    // needs it to compile the application.
    if (manifestName && !allFiles.includes(manifestName)) {
      allFiles.push(manifestName);
    }

    return allFiles.filter((f) => {
      if (f === manifestName) return true;
      if (excludes.some((p) => f === p || f.startsWith(p + '/'))) return false;
      // Drop paths that no longer exist on disk — `git ls-files -c` lists
      // tracked files including ones the user has `rm`'d but not yet
      // committed, which would make tar fail.
      return existsSync(resolve(dir, f));
    });
  } else {
    // For non-git repos, use find and apply excludes
    const findArgs = ['.', '-type', 'f'];
    for (const pattern of excludes) {
      findArgs.push('-not', '-path', `./${pattern}`, '-not', '-path', `./${pattern}/*`);
    }
    const files = execFileSync('find', findArgs, { cwd: dir, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''));
    return files;
  }
}
