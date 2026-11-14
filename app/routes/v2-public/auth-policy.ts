export async function trusted(
  context: Pick<Window, 'isSecureContext' | 'location'> = window,
  request: typeof fetch = fetch,
) {
  if (!context.isSecureContext || context.location.protocol !== 'https:') return false;
  try {
    const response = await request('/api/auth/trust', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function offerPasskey(
  account: { hasPasskey: boolean; passkeyOffered: boolean },
  trust: boolean,
) {
  return trust && !account.hasPasskey && !account.passkeyOffered;
}

export function preferPasskey(methods: { passkey: boolean }, trust: boolean) {
  return methods.passkey && trust;
}
