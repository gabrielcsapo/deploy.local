import { loadOrCreateSecretKey, encryptSecret, decryptSecret } from '../secrets.ts';
import { deployDataDirectory } from '../kernel/files/data-directory.ts';
import { get, list, save, now, id } from './store.ts';

export const providerIds = ['codex', 'claude', 'compatible'] as const;
type ProviderId = (typeof providerIds)[number];
export interface ProviderConnection {
  id: string;
  workerId: string;
  provider: ProviderId;
  enabled: boolean;
  mode: 'account' | 'api-key';
  baseUrl: string;
  model: string;
  billingMode: 'local' | 'api';
  secret?: string;
  revision: string;
  updatedAt: string;
}
const address = (owner: string, key: string) => JSON.stringify(['workspace-provider', owner, key]);
function defaults(workerId: string, provider: ProviderId): ProviderConnection {
  return {
    id: `${workerId}:${provider}`,
    workerId,
    provider,
    enabled: provider !== 'compatible',
    mode: 'account',
    baseUrl: '',
    model: '',
    billingMode: 'api',
    revision: '',
    updatedAt: '',
  };
}
export function providerConnections(owner: string, workerId: string, includeSecrets = false) {
  const records = list('provider-connection', owner);
  return providerIds.map((provider) => {
    const value: ProviderConnection =
      records.find((r) => r.id === `${workerId}:${provider}`) || defaults(workerId, provider);
    const { secret, ...publicValue } = value;
    return {
      ...publicValue,
      hasKey: !!secret,
      ...(includeSecrets && secret
        ? {
            apiKey: decryptSecret(
              secret,
              loadOrCreateSecretKey(deployDataDirectory()),
              address(owner, value.id),
            ),
          }
        : {}),
    };
  });
}
export function saveProviderConnection(owner: string, input: any) {
  get('worker', owner, input.workerId);
  if (!providerIds.includes(input.provider)) throw new Error('Unsupported provider');
  const previous =
    list('provider-connection', owner).find(
      (r) => r.id === `${input.workerId}:${input.provider}`,
    ) || defaults(input.workerId, input.provider);
  if (typeof input.enabled !== 'boolean' || !['account', 'api-key'].includes(input.mode))
    throw new Error('Invalid connection mode');
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
    throw new Error('Invalid API key');
  const text = (value: unknown, limit: number) => {
    if (
      typeof value !== 'string' ||
      value.length > limit ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error('Invalid connection value');
    return value.trim();
  };
  const baseUrl = text(input.baseUrl || '', 2048),
    model = text(input.model || '', 160);
  if (input.provider === 'compatible' && input.enabled) {
    const url = new URL(baseUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Use an HTTP(S) API URL without credentials, query or fragment');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Remote provider connections require HTTPS');
    if (!model || !['local', 'api'].includes(input.billingMode))
      throw new Error('Model and billing mode required');
  }
  let secret = input.clearKey || !input.enabled ? undefined : previous.secret;
  if (input.apiKey)
    secret = encryptSecret(
      text(input.apiKey, 16384),
      loadOrCreateSecretKey(deployDataDirectory()),
      address(owner, previous.id),
    );
  if (input.enabled && input.provider !== 'compatible' && input.mode === 'api-key' && !secret)
    throw new Error('API key required');
  save('provider-connection', owner, {
    ...previous,
    enabled: input.enabled,
    mode: input.mode,
    baseUrl,
    model,
    billingMode: input.billingMode === 'local' ? 'local' : 'api',
    secret,
    revision: id(),
    updatedAt: now(),
  });
  return providerConnections(owner, input.workerId);
}
export function requestProviderLogin(owner: string, workerId: string) {
  get('worker', owner, workerId);
  const current = list('provider-login', owner).find((r) => r.id === workerId);
  if (
    current &&
    ['requested', 'pending'].includes(current.status) &&
    current.expiresAt > Date.now()
  )
    return current;
  return save('provider-login', owner, {
    id: workerId,
    requestId: id(),
    status: 'requested',
    expiresAt: Date.now() + 10 * 60000,
  });
}
export function updateProviderLogin(owner: string, workerId: string, input: any) {
  const current = get('provider-login', owner, workerId);
  if (current.requestId !== input.requestId || current.expiresAt < Date.now())
    throw new Error('Sign-in request expired');
  if (!['pending', 'succeeded', 'failed'].includes(input.status))
    throw new Error('Invalid sign-in status');
  const verificationUrl =
    input.verificationUrl === 'https://auth.openai.com/codex/device'
      ? input.verificationUrl
      : undefined;
  const userCode =
    typeof input.userCode === 'string' && /^[A-Z0-9-]{6,20}$/.test(input.userCode)
      ? input.userCode
      : undefined;
  return save('provider-login', owner, {
    ...current,
    status: input.status,
    ...(input.status === 'pending'
      ? { verificationUrl, userCode }
      : { verificationUrl: undefined, userCode: undefined }),
  });
}
