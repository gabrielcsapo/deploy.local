export const sidebarPreferenceKey = 'deploy.sidebar.collapsed';

export function sidebarCollapsed() {
  try {
    return localStorage.getItem(sidebarPreferenceKey) === 'true';
  } catch {
    return false;
  }
}
export function rememberSidebar(collapsed: boolean) {
  try {
    localStorage.setItem(sidebarPreferenceKey, String(collapsed));
  } catch {
    // The choice still works when storage is unavailable.
  }
}
