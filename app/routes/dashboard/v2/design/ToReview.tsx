'use client';
import { useEffect } from 'react';
import { Skeleton, Action, Group, Head, IconButton, Item } from '@/components/ui';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import type { DesignApproved, DesignReviewSummary } from '../../../../../shared/v2/contracts';
import { useInbox } from '../data/hooks';
import { useData } from '../projects/data';
import { getAuth } from '../../detail/shared';
import { ago } from './ItemReview';
import { conflictCount, initialDesignProject, reviewCounts, reviewHref } from './review-model';
import './review.css';
export type DesignProject = {
  id: string;
  name: string;
  description?: string | null;
  boards: number;
};

export function ToReview({
  projectId,
  alwaysList,
  openProject,
}: {
  projectId?: string;
  alwaysList: boolean;
  openProject: (id: string) => void;
}) {
  const inbox = useInbox();
  const version = inbox.items
    .filter((item) => item.state === 'waiting' && item.id.startsWith('design:'))
    .map((item) => item.id)
    .join(',');
  const reviews = useData<{ proposals: DesignReviewSummary[]; approved?: DesignApproved[] }>(
    `/api/v2/design/reviews?${projectId ? `project=${encodeURIComponent(projectId)}&` : ''}v=${encodeURIComponent(version)}`,
  );
  const projects = useData<{ projects: DesignProject[] }>('/api/v2/design/projects');
  useEffect(() => {
    if (
      inbox.loading ||
      inbox.error ||
      alwaysList ||
      !reviews.data ||
      reviews.data.proposals.length ||
      reviews.data.approved?.length ||
      !projects.data
    )
      return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(`deploy.design.lastProject.${getAuth()?.username ?? ''}`);
    } catch {
      /* Storage is optional. */
    }
    const next = initialDesignProject(projects.data.projects, projectId ?? null, last);
    if (next) openProject(next);
  }, [inbox.loading, inbox.error, alwaysList, reviews.data, projects.data, projectId, openProject]);
  const usable =
    projects.data?.projects.filter(
      (project) => project.boards > 0 && (!projectId || project.id === projectId),
    ) ?? [];
  return (
    <div className="dl-review">
      <Head
        title="Design"
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
      />
      <div className="dl-review-scroll">
        <div className="dl-review-content dl-list">
          <h1>To review</h1>
          {(reviews.error || projects.error) && (
            <div className="dl-review-notice" role="alert">
              Designs could not be loaded.{' '}
              <Action
                onClick={() => {
                  reviews.refresh();
                  projects.refresh();
                }}
              >
                Retry
              </Action>
            </div>
          )}
          <section>
            <h2>Waiting on you</h2>
            <Group>
              {!reviews.data && <Skeleton rows={3} label="Loading reviews" />}
              {reviews.data?.proposals.map((proposal) => (
                <Item
                  key={proposal.id}
                  href={reviewHref(proposal.id)}
                  lead={
                    proposal.proposer.id ? (
                      <AgentAvatar
                        id={proposal.proposer.id}
                        avatar={proposal.proposer.avatar ?? undefined}
                      />
                    ) : undefined
                  }
                  title={proposal.title}
                  description={
                    <>
                      <span className="dl-review-proposal-meta">
                        {proposal.project} · {proposal.proposer.name} · {ago(proposal.createdAt)}
                      </span>
                      <span className="dl-review-proposal-meta">
                        {proposal.stale
                          ? conflictCount(proposal.conflicts)
                          : reviewCounts(proposal.counts)}
                      </span>
                    </>
                  }
                />
              ))}
            </Group>
          </section>
          {Boolean(reviews.data?.approved?.length) && (
            <section>
              <h2>Approved</h2>
              <Group>
                {reviews.data!.approved!.map((proposal) => (
                  <Item
                    key={proposal.id}
                    href={reviewHref(proposal.id)}
                    title={proposal.title}
                    description={proposal.detail}
                  />
                ))}
              </Group>
            </section>
          )}
          {usable.length > 0 && (
            <section>
              <h2>Projects with a design</h2>
              <Group>
                {usable.map((project) => (
                  <Item
                    key={project.id}
                    href={`/dashboard/design?project=${encodeURIComponent(project.id)}&view=canvas`}
                    title={project.name}
                    description={project.description}
                  />
                ))}
              </Group>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
