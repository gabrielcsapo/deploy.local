export function returnPath(value: string | null | undefined) {
  if (
    !value ||
    !value.startsWith('/dashboard') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return '/dashboard';
  const url = new URL(value, 'https://deploy.local');
  if (url.origin !== 'https://deploy.local' || !/^\/dashboard(?:\/|$)/.test(url.pathname))
    return '/dashboard';
  return url.pathname + url.search + url.hash;
}
