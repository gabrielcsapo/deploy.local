import type { LiveResponse, Project, ProjectListGroup } from '../../../../../shared/v2/contracts';
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

const urgency: Record<string, number> = { failed: 0, attention: 1, inactive: 2 };
/** Live projects in the order they arrive (newest change first), the ones that need you on top. */
export function rankLiveProjects(
  projects: Project[],
  live: LiveResponse | undefined,
  coordinator: string,
) {
  return projects
    .map((project) => ({
      project,
      rank: urgency[projectRuntime(project, live, coordinator).kind ?? ''] ?? 3,
    }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ project }) => project);
}

const count = (value: number, one: string, many = `${one}s`) =>
  `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`;

/** “7 live, 1 failing · 15 repositories”: what the page holds, whatever is shown or searched. */
export function projectListSummary(
  counts: Record<ProjectListGroup, number>,
  failing: number,
): string {
  return [
    counts.live ? `${counts.live} live${failing ? `, ${failing} failing` : ''}` : '',
    counts.repositories ? count(counts.repositories, 'repository', 'repositories') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The Show button names what is ticked. */
export function showLabel(show: ProjectListGroup[]): string {
  const names = { live: 'Live', repositories: 'Repositories', archived: 'Archived' };
  const ticked = (['live', 'repositories', 'archived'] as const).filter((group) =>
    show.includes(group),
  );
  if (ticked.length === 3) return 'All projects';
  if (ticked.length === 2) return `${names[ticked[0]]} and ${names[ticked[1]].toLowerCase()}`;
  return names[ticked[0] ?? 'live'];
}

/** The one extra fact a card has room for: what waits on you before what merely describes it. */
export function projectCardFact(project: Project, changedLabel?: string): string {
  if (project.openPulls) return `${count(project.openPulls, 'PR')} open`;
  if (project.stage === 'maintained') return 'Maintained';
  if (project.id.startsWith('app:')) return 'Shipped from a folder';
  return changedLabel ? `Changed ${changedLabel}` : '';
}

/** A repository row's end: open pull requests, then when it last changed. */
export function repositoryRowFact(project: Project, changedLabel?: string): string {
  return [project.openPulls ? `${count(project.openPulls, 'PR')} open` : '', changedLabel || '']
    .filter(Boolean)
    .join(' · ');
}

/** Requests since midnight where the page is read, from the hourly counts of the last 24 hours. */
export function requestsToday(traffic: NonNullable<Project['traffic']>, midnight: number): string {
  const total = traffic.hourly.reduce(
    (sum, requests, hour) => (traffic.from + hour * 3_600_000 >= midnight ? sum + requests : sum),
    0,
  );
  return total ? `${count(total, 'request')} today` : 'No requests today';
}

/** Points for the 110 × 40 sparkline: a flat line along the bottom when nothing came in. */
export function sparkPoints(hourly: number[]): string {
  const peak = Math.max(...hourly, 0);
  const step = hourly.length > 1 ? 110 / (hourly.length - 1) : 0;
  return hourly
    .map((value, index) => {
      const x = Math.round(index * step * 10) / 10;
      const y = peak ? Math.round((36 - (value / peak) * 30) * 10) / 10 : 36;
      return `${x},${y}`;
    })
    .join(' ');
}
