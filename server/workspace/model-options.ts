import { spawn } from 'node:child_process';
export type ModelOption = { id: string; name: string; efforts: string[] };
export type AgentOption = { id: string; models: ModelOption[]; efforts: string[] };
const codexEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// Catalog metadata only; never expose account identity or credentials from the cache.
let discoveredModels: ModelOption[] = [];
let refreshing = false;
let refreshedAt = 0;
export function invalidateModelOptions() {
  refreshedAt = 0;
  discoveredModels = [];
}
// Discover through the installed runtime; a shared disk cache may belong to another client.
function refreshModels() {
  if (refreshing || Date.now() - refreshedAt < 60000) return;
  refreshing = true;
  const child = spawn(process.env.DEPLOY_CODEX_BIN || 'codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const finish = () => {
    refreshing = false;
    refreshedAt = Date.now();
    clearTimeout(timer);
    child.kill();
  };
  const timer = setTimeout(finish, 10000);
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
  let buffer = '';
  let models: ModelOption[] = [];
  child.stdin.on('error', finish);
  child.once('error', finish);
  child.once('close', () => {
    refreshedAt = Date.now();
    refreshing = false;
    clearTimeout(timer);
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      finish();
      return;
    }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.id === 0) {
          if (message.error) {
            finish();
            return;
          }
          send({ method: 'initialized' });
          send({ method: 'model/list', id: 1, params: { limit: 100, includeHidden: false } });
        }
        if (message.id === 1) {
          if (!message.result?.data) {
            finish();
            return;
          }
          models.push(
            ...message.result.data
              .filter((m: any) => !m.hidden)
              .map((m: any) => ({
                id: m.model,
                name: m.displayName || m.model,
                efforts: (m.supportedReasoningEfforts || []).map((r: any) => r.reasoningEffort),
              })),
          );
          if (message.result.nextCursor && models.length < 500)
            send({
              method: 'model/list',
              id: 1,
              params: { limit: 100, includeHidden: false, cursor: message.result.nextCursor },
            });
          else {
            discoveredModels = models;
            finish();
            return;
          }
        }
      } catch {
        /* Ignore unrelated runtime output. */
      }
    }
  });
  send({
    method: 'initialize',
    id: 0,
    params: { clientInfo: { name: 'deploy_local', version: '1.0.0' } },
  });
}
export function modelOptions(): AgentOption[] {
  refreshModels();
  const models = discoveredModels;
  return [
    { id: 'codex', models, efforts: codexEfforts },
    {
      id: 'claude',
      models: ['opus', 'sonnet', 'haiku'].map((id) => ({
        id,
        name: id[0].toUpperCase() + id.slice(1),
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      })),
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'compatible',
      models: process.env.DEPLOY_MODEL_NAME
        ? [{ id: process.env.DEPLOY_MODEL_NAME, name: process.env.DEPLOY_MODEL_NAME, efforts: [] }]
        : [],
      efforts: [],
    },
  ];
}
export function validateRunSettings(input: any, options: AgentOption[]) {
  const model = input.model == null ? '' : input.model;
  const effort = input.effort == null ? '' : input.effort;
  if (
    typeof model !== 'string' ||
    model.length > 160 ||
    [...model].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error('Invalid model name');
  if (typeof effort !== 'string') throw new Error('Invalid effort');
  const adapter = options.find((a) => a.id === (input.adapter || 'codex'));
  const levels = adapter?.models.find((m) => m.id === model)?.efforts ?? adapter?.efforts ?? [];
  if (effort && !levels.includes(effort))
    throw new Error('Effort is not supported by this model and agent');
  return { model: model.trim() || null, effort: effort || null };
}
