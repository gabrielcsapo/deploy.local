import type { LiveResponse, Project } from '../../../../../shared/v2/contracts';
import { appAddress, projectHealth } from '../live/presentation';

export function orderUnlinkedApps(apps: Project['apps'], name: string) {
  return [...apps].sort(
    (a, b) => Number(b.name === name) - Number(a.name === name) || a.name.localeCompare(b.name),
  );
}

export function projectRuntime(
  project: Project,
  live: LiveResponse | undefined,
  coordinator: string,
): { label: string; kind?: NonNullable<ReturnType<typeof projectHealth>>['kind']; where?: string } {
  if (!project.apps.length) return { label: 'Not deployed' };
  const entries =
    live?.computers.flatMap((computer) =>
      computer.apps
        .filter((app) => project.apps.some((entry) => entry.id === app.appId))
        .map((app) => ({
          app,
          computer: computer.id === 'coordinator' ? coordinator : computer.name,
        })),
    ) || [];
  if (entries.length !== project.apps.length) return { label: 'Health unavailable' };
  const health = projectHealth(entries.map(({ app }) => app))!;
  const where =
    entries.length === 1
      ? entries[0].app.state === 'stopped'
        ? 'Stopped'
        : `${appAddress(entries[0].app)} · ${entries[0].computer}`
      : `${entries.length} apps · ${[...new Set(entries.map(({ computer }) => computer))].join(' and ')}`;
  return { ...health, where };
}
