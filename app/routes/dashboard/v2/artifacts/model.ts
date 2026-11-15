import type { ArtifactKind, ArtifactSummary } from '../../../../../shared/v2/artifacts';
import { artifactSlug, changedWhen } from '../../../../../shared/v2/artifacts';

export const galleryPath = '/dashboard/artifacts';

/** Where a card goes: a design to its canvas, a document to its page. */
export function artifactHref(entry: ArtifactSummary) {
  if (entry.kind === 'document')
    return `${galleryPath}/${encodeURIComponent(entry.projectId)}/${encodeURIComponent(entry.artifact ?? '')}`;
  const params = new URLSearchParams({ project: entry.projectId });
  if (entry.artifact) params.set('artifact', entry.artifact);
  params.set('view', 'canvas');
  // One that is only on its branch opens there; otherwise the canvas opens main, as it does.
  if (entry.branch) params.set('ref', entry.branch);
  return `/dashboard/design?${params}`;
}

/** Where a newly made artifact opens: its empty canvas, or its page ready to type in. */
export function createdHref(made: {
  projectId: string;
  artifact: string;
  kind: ArtifactKind;
  branch: string;
}) {
  if (made.kind === 'document')
    return `${galleryPath}/${encodeURIComponent(made.projectId)}/${encodeURIComponent(made.artifact)}?ref=${encodeURIComponent(made.branch)}`;
  return `/dashboard/design?${new URLSearchParams({
    project: made.projectId,
    artifact: made.artifact,
    view: 'canvas',
    ref: made.branch,
  })}`;
}

/** "deploy.local · 171 boards · today" for a design, "deploy.local · 3 days ago" for a document. */
export function artifactMeta(entry: ArtifactSummary, now = new Date()) {
  const when = changedWhen(entry.updatedAt, now);
  return [
    entry.project,
    entry.kind === 'design' && entry.boards !== undefined
      ? `${entry.boards} board${entry.boards === 1 ? '' : 's'}`
      : null,
    when || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export const stateLabel = { review: 'In review', unproposed: 'Not proposed' } as const;

export type GalleryTab = 'all' | 'designs' | 'documents';
export function galleryTab(value: string | null): GalleryTab {
  return value === 'designs' || value === 'documents' ? value : 'all';
}
export function shown(artifacts: ArtifactSummary[], tab: GalleryTab) {
  return tab === 'all'
    ? artifacts
    : artifacts.filter((entry) => entry.kind === (tab === 'designs' ? 'design' : 'document'));
}

/** What the dialog says will happen, once the name gives a folder. */
export function createNote(name: string, project: string | undefined) {
  const slug = artifactSlug(name);
  if (!slug || !project) return '';
  return `deploy.local adds artifacts/${slug} to ${project} on a new branch, artifact/${slug}. It reaches main when you approve it.`;
}
