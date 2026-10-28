'use client';
import { LegacySkeleton as Skeleton } from '@/components/ui';

/**
 * The workspace frame (rail, task sidebar, conversation) as placeholders, painted before the
 * stored sign-in is read so the first frame already has the dashboard's shape.
 */
export function WorkspaceLoadingFrame() {
  return (
    <div className="project-workspace is-loading" data-phone="" aria-busy="true">
      <div className="workspace-rail" aria-hidden="true" />
      <aside className="pw-sidebar task-navigation" aria-label="Tasks navigation">
        <Skeleton variant="sidebar" label="Loading tasks" />
      </aside>
      <section className="pw-chat" aria-label="Conversation">
        <div className="pw-transcript">
          <div className="pw-conversation">
            <Skeleton variant="conversation" label="Connecting to workspace" />
          </div>
        </div>
      </section>
    </div>
  );
}
