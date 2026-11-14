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

/** How the sidebar groups tasks: by day (Today, Yesterday) or by project. One choice per browser. */
export type TaskGrouping = 'date' | 'project';
export const taskGroupingKey = 'deploy.sidebar.tasks';
export const taskGroupingEvent = 'deploy:task-grouping';

export function taskGrouping(): TaskGrouping {
  try {
    return localStorage.getItem(taskGroupingKey) === 'project' ? 'project' : 'date';
  } catch {
    return 'date';
  }
}
export function rememberTaskGrouping(grouping: TaskGrouping) {
  try {
    localStorage.setItem(taskGroupingKey, grouping);
  } catch {
    // The choice still applies until the page reloads.
  }
}
