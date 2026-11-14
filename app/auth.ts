export function getAuth() {
  try {
    const raw = localStorage.getItem('deploy-sh-auth');
    if (!raw) return null;
    return JSON.parse(raw) as { username: string; token: string };
  } catch {
    return null;
  }
}

export function setAuth(username: string, token: string) {
  localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'deploy-sh-auth' }));
}

export function clearAuth() {
  void fetch('/api/auth/session', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch(() => {});
  localStorage.removeItem('deploy-sh-auth');
  window.dispatchEvent(new StorageEvent('storage', { key: 'deploy-sh-auth' }));
}
