import { parentPort, workerData } from 'node:worker_threads';

export type IndexWork = { database: string; workspace: string; owner: string; project: string };
export type QueryWork = {
  database: string;
  workspace: string;
  registry?: string;
  owner: string;
  name: string;
  args: Record<string, unknown>;
};
export type Work = ({ kind: 'index' } & IndexWork) | ({ kind: 'query' } & QueryWork);

async function run(work: Work) {
  if (work.kind === 'index') {
    const { indexProject } = await import('./index-project.ts');
    return indexProject(work);
  }
  const { queryIndex } = await import('./queries.ts');
  return queryIndex(work);
}

if (parentPort) {
  const port = parentPort;
  run(workerData as Work).then(
    (result) => port.postMessage({ result }),
    (error) => port.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
}
