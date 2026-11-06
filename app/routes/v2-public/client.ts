import { trusted } from './auth-policy';
export { trusted } from './auth-policy';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api';
export { api } from './api';
import { setAuth } from '../dashboard/detail/shared';
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
