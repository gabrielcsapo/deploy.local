import { getAuth } from '../../../../auth.ts';

let adopted: string | undefined;
let pending: Promise<void> | undefined;
/** Also covers credentials injected by the desktop bridge and older browser sign-ins. */
export function adoptSession(): Promise<void> {
  const auth = getAuth();
  if (!auth) return Promise.resolve();
  const identity = JSON.stringify(auth);
  if (adopted === identity) return pending ?? Promise.resolve();
  adopted = identity;
  pending = fetch('/api/auth/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
    },
    body: '{}',
  })
    .then((response) => {
      if (!response.ok) adopted = undefined;
    })
    .catch(() => {
      adopted = undefined;
    });
  return pending;
}
