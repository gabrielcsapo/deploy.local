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

/**
 * How the sidebar groups tasks: by day (Today, Yesterday), by project, or by project with live
 * work only (Work). One choice per browser.
 */
export type TaskGrouping = 'date' | 'project' | 'work';
export const taskGroupingKey = 'deploy.sidebar.tasks';
export const taskGroupingEvent = 'deploy:task-grouping';

export function taskGrouping(): TaskGrouping {
  try {
    const stored = localStorage.getItem(taskGroupingKey);
    return stored === 'project' || stored === 'work' ? stored : 'date';
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

/** The canvas's left and right panels each stay open or closed on this device, apart. */
export type DesignPanel = 'left' | 'right';
export const designPanelKey = (panel: DesignPanel) => `deploy.design.${panel}Panel.hidden`;

export function designPanelHidden(panel: DesignPanel) {
  try {
    return localStorage.getItem(designPanelKey(panel)) === 'true';
  } catch {
    return false;
  }
}
export function rememberDesignPanel(panel: DesignPanel, hidden: boolean) {
  try {
    localStorage.setItem(designPanelKey(panel), String(hidden));
  } catch {
    // The panel still opens and closes when storage is unavailable.
  }
}
