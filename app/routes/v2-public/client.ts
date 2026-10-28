import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { authenticatedFetch } from '../dashboard/v2/data/hooks';
import { setAuth } from '../dashboard/detail/shared';
export async function api<T = any>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await authenticatedFetch(
    path,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || 'Request failed. Try again.'), {
      status: response.status,
    });
  return result;
}
export async function trusted() {
  if (!window.isSecureContext || window.location.protocol !== 'https:') return false;
  try {
    const response = await fetch('/api/v2/auth/trust', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
export async function passkeySignIn() {
  if (!(await trusted()))
    throw new Error('Trust SER’s certificate to use a passkey. Your password always works.');
  const { options, challengeId } = await api('/api/v2/auth/passkey/login/options', {});
  const response = await startAuthentication({ optionsJSON: options });
  const result = await api('/api/v2/auth/passkey/login/verify', { challengeId, response });
  setAuth(result.username, result.token);
}
export async function addPasskey() {
  if (!(await trusted()))
    throw new Error('Trust SER’s certificate first. Your password always works.');
  const { options, challengeId } = await api('/api/v2/auth/passkey/register/options', {});
  const response = await startRegistration({ optionsJSON: options });
  await api('/api/v2/auth/passkey/register/verify', { challengeId, response });
}
