import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { compileDeployYaml } from '../application-spec.ts';
import { repositorySource } from '../workspace/repositories.ts';
import { gitText } from '../workspace/repository-git.ts';
import { fail } from '../errors.ts';

export type RepositoryPreview = {
  found: { name: string; detail: string }[];
  address?: string;
  runsOn: string;
};

/** Read committed files in a temporary bare clone; never check out or execute repository code. */
export async function inspectRepository(sourcePath: unknown): Promise<RepositoryPreview> {
  const source = repositorySource(sourcePath);
  if (!source.location) fail('Repository is required');
  const directory = await mkdtemp(join(tmpdir(), 'deploy-repository-preview-'));
  try {
    const repository = join(directory, 'source.git');
    await gitText(directory, ['clone', '--bare', '--depth=1', '--', source.location, repository], {
      timeout: 30000,
    });
    const files = (await gitText(repository, ['ls-tree', '--name-only', 'HEAD'])).split('\n');
    const read = (name: string) =>
      gitText(repository, ['show', `HEAD:${name}`], { limit: 256 * 1024 });
    if (files.includes('deploy.yaml')) {
      const { spec } = compileDeployYaml(await read('deploy.yaml'));
      return {
        found: [
          ...Object.entries(spec.components).map(([name, component]) => ({
            name: component.displayName || name,
            detail: `${component.role === 'web' ? 'Web app' : component.role === 'worker' ? 'Worker' : 'Service'} · ${component.command?.join(' ') || component.image || 'build from repository'}${Object.values(component.interfaces).length ? ` · port ${Object.values(component.interfaces)[0].port}` : ' · no port'}`,
          })),
          ...Object.entries(spec.resources).map(([name, resource]) => ({
            name: resource.displayName || name,
            detail: `${resource.dataRole} · persistent data`,
          })),
        ],
        address: Object.values(spec.routes).find((route) => route.hostname)?.hostname,
        runsOn: 'Choose when you ship',
      };
    }
    const found: RepositoryPreview['found'] = [];
    if (files.includes('package.json')) {
      const pkg = JSON.parse(await read('package.json'));
      found.push({
        name: pkg.name || 'App',
        detail:
          [pkg.scripts?.build, pkg.scripts?.start].filter(Boolean).join(' · ') || 'package.json',
      });
    }
    const compose = [
      'compose.yaml',
      'compose.yml',
      'docker-compose.yml',
      'docker-compose.yaml',
    ].find((name) => files.includes(name));
    if (compose) {
      const manifest = parse(await read(compose), { maxAliasCount: 20 });
      for (const [name, service] of Object.entries(manifest?.services || {}) as [string, any][]) {
        found.push({ name, detail: `${service.image || 'Built from source'} · from ${compose}` });
      }
    }
    return { found, runsOn: 'Choose when you ship' };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function startApi(req: IncomingMessage, res: ServerResponse, _owner: string) {
  if (new URL(req.url!, 'http://localhost').pathname !== '/api/v2/start/inspect') return false;
  if (req.method !== 'POST') fail('Method not allowed', 405);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 4096) {
      req.resume();
      fail('Request too large', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const preview = await inspectRepository(body.sourcePath);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(preview));
  return true;
}
