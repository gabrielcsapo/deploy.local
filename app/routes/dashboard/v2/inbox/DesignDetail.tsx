'use client';
import { useState } from 'react';
import { Action, Banner, Dialog, Icon, Skeleton } from '@/components/ui';
import type {
  DesignReview,
  DesignReviewScreen,
  DesignReviewSummary,
  InboxItem,
} from '../../../../../shared/v2/contracts';
import { useInbox } from '../data/hooks';
import { request, useData } from '../projects/data';
import { designApi } from '../design/model';
import { documentReviewHref, reviewHref } from '../design/review-model';
import { previewKey, useReviewPreviews, type Preview } from '../design/ReviewPreviews';
import { KindTile } from './WaitingRows';
import { namedList, notesLabel, screensLabel, shotRegion, waitingAge } from './waiting';

const noScreens: DesignReviewScreen[] = [];
/** How many changed screens the detail shows as Before and After; the rest are summed up. */
const SHOWN = 2;

/** The review's screens in canvas order, as the review lists them. */
function canvasOrder(review: DesignReview) {
  const remaining = [...review.boards];
  const ordered: DesignReviewScreen[] = [];
  for (const file of review.groups.flatMap((group) => group.boards)) {
    const index = remaining.findIndex((board) => board.file === file);
    if (index >= 0) ordered.push(...remaining.splice(index, 1));
  }
  return [...ordered, ...remaining];
}

const statusWord = { changed: 'Changed', new: 'New', removed: 'Removed' } as const;

/**
 * A design waiting on you (Inbox and InboxDetail boards): what it changes, the main changed
 * screens Before and After, the rest summed up, then Approve design and Ask for changes.
 */
export function DesignDetail({
  item,
  summary,
  project,
  who,
  now,
}: {
  item: InboxItem;
  summary?: DesignReviewSummary;
  project?: string | null;
  who: string;
  /** The page's clock, frozen through hydration. */
  now: number;
}) {
  const inbox = useInbox();
  const projectId = item.projectId ?? summary?.projectId ?? item.id.split(':')[1];
  const api = designApi(projectId, item.document);
  const review = useData<DesignReview>(
    `${api}/review?item=${encodeURIComponent(item.id)}&evidence=text`,
  );
  const screens = review.data && !item.document ? canvasOrder(review.data) : noScreens;
  const shown = screens.slice(0, SHOWN);
  const rest = screens.slice(SHOWN);
  const notes = review.data?.notes ?? [];
  const images = useReviewPreviews(api, item.id, shown.length ? shown : noScreens);
  const open = item.document
    ? documentReviewHref(projectId, item.document, item.id)
    : reviewHref(item.id);
  const count = summary?.counts.screens ?? review.data?.counts.screens;
  const meta = [
    summary?.project ?? review.data?.project ?? project,
    summary?.proposer.name ?? review.data?.proposer.name ?? who,
    waitingAge(item.createdAt, new Date(now)),
    count !== undefined
      ? `${screensLabel(count)}${notes.length ? ` and ${notesLabel(notes.length)}` : ''}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const stale = summary?.stale ?? review.data?.stale ?? false;
  const unseen = screens.filter((screen) => !screen.seen);

  const [dialog, setDialog] = useState<'approve' | 'changes' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (actionId: 'approve' | 'changes' | 'update') => {
    setBusy(true);
    setError('');
    try {
      // Approving waits 30 s before it reaches main, so the review can undo it, as there.
      await request(`/api/inbox/${encodeURIComponent(item.id)}/answer`, {
        method: 'POST',
        body: JSON.stringify({
          actionId,
          on: 'web',
          ...(actionId === 'approve' ? { delay: true } : {}),
          ...(actionId === 'changes' && note.trim() ? { note: note.trim() } : {}),
        }),
      });
      setDialog(null);
      setNote('');
      inbox.retry();
      review.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const answered = item.answer?.actionId;
  return (
    <>
      <div className="dl-asks-detail-scroll">
        <div className="dl-asks-pane">
          <a className="dl-asks-crumb v2-asks-crumb" href="/dashboard/inbox">
            <Icon name="back" size={14} />
            Waiting on you
          </a>
          <div className="dl-asks-title">
            <KindTile kind="design" large />
            <span className="dl-t">
              <h2 className="dl-title">{item.title}</h2>
              <span className="dl-meta">{meta}</span>
            </span>
          </div>
          {(summary?.summary ?? review.data?.summary) && (
            <p className="dl-asks-summary">{summary?.summary ?? review.data?.summary}</p>
          )}
          {stale && item.state === 'waiting' && (
            <div className="dl-banner" role="status">
              <span className="dl-t">
                <span>Some of these screens changed on main since</span>
                <span>Ask to update first, or review them as they are.</span>
              </span>
              <span className="dl-end">
                <Action disabled={busy} onClick={() => void decide('update')}>
                  Ask to update
                </Action>
              </span>
            </div>
          )}
          {error && <Banner kind="danger" title={error} />}
          {review.error && (
            <Banner
              kind="danger"
              title="The screens could not be loaded."
              action={<Action onClick={review.refresh}>Retry</Action>}
            />
          )}
          {!item.document && !review.data && !review.error && (
            <Skeleton rows={3} label="Loading the changed screens" />
          )}
          {shown.length > 0 && (
            <section className="dl-asks-shots" aria-label="Main changes">
              <h3 className="dl-group-label">Main changes</h3>
              {shown.map((screen) => (
                <div key={screen.file}>
                  <p className="dl-asks-screen-name">
                    {screen.title}
                    <span>{statusWord[screen.status]}</span>
                  </p>
                  <div className="dl-asks-pair">
                    {(['before', 'after'] as const).map((side) => (
                      <figure key={side}>
                        <Shot
                          preview={images.previews[previewKey(screen.file, screen.widths[0])]}
                          screen={screen}
                          side={side}
                        />
                        <figcaption>{side === 'before' ? 'Before · main' : 'After'}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              ))}
              {images.error && (
                <Banner
                  kind="danger"
                  title={images.error}
                  action={<Action onClick={images.retry}>Retry</Action>}
                />
              )}
              {(rest.length > 0 || notes.length > 0) && (
                <div className="dl-group">
                  {rest.length > 0 && (
                    <a className="dl-asks-more" href={open}>
                      <span className="dl-tile">
                        <Icon name="stack" />
                      </span>
                      <span className="dl-t">
                        <b>
                          {rest.length} more screen{rest.length === 1 ? '' : 's'}
                        </b>
                        <span>{namedList(rest.map((screen) => screen.title))}</span>
                      </span>
                      <Icon name="chevron" size={14} className="dl-chev" />
                    </a>
                  )}
                  {notes.length > 0 && (
                    <a className={`dl-asks-more${rest.length ? ' v2-asks-ruled' : ''}`} href={open}>
                      <span className="dl-tile">
                        <Icon name="text" />
                      </span>
                      <span className="dl-t">
                        <b>{notesLabel(notes.length)}</b>
                        <span>{namedList(notes.map((entry) => entry.title))}</span>
                      </span>
                      <Icon name="chevron" size={14} className="dl-chev" />
                    </a>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
      <div className="dl-asks-foot">
        {item.state === 'waiting' ? (
          <>
            <Action variant="primary" disabled={busy} onClick={() => setDialog('approve')}>
              {item.actions.find((action) => action.id === 'approve')?.label ?? 'Approve design'}
            </Action>
            <Action disabled={busy} onClick={() => setDialog('changes')}>
              Ask for changes
            </Action>
          </>
        ) : (
          <span className="dl-meta">
            {answered === 'approve'
              ? 'Approved'
              : answered === 'changes'
                ? 'Changes asked'
                : answered === 'update'
                  ? 'Asked to update'
                  : 'No longer waiting'}
          </span>
        )}
        <a href={open} className="dl-btn quiet v2-asks-open">
          Open the review
          <Icon name="chevron" size={14} />
        </a>
      </div>
      <Dialog
        open={dialog === 'approve'}
        title={item.actions.find((action) => action.id === 'approve')?.label ?? 'Approve design'}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Action onClick={() => setDialog(null)}>Cancel</Action>
            <Action variant="primary" disabled={busy} onClick={() => void decide('approve')}>
              {unseen.length ? 'Approve anyway' : 'Approve design'}
            </Action>
          </>
        }
      >
        {unseen.length > 0 && (
          <p>
            You haven’t looked at {namedList(unseen.map((screen) => screen.title))} in the review.
          </p>
        )}
        <p>
          Approving puts the proposed design on main in 30 seconds. You can undo it in the review.
        </p>
      </Dialog>
      <Dialog
        open={dialog === 'changes'}
        title="Ask for changes"
        onClose={() => setDialog(null)}
        actions={
          <>
            <Action onClick={() => setDialog(null)}>Cancel</Action>
            <Action
              variant="primary"
              disabled={busy || !note.trim()}
              onClick={() => void decide('changes')}
            >
              Send
            </Action>
          </>
        }
      >
        <label className="dl-field-label" htmlFor={`changes-${item.id}`}>
          What should change
        </label>
        <div className="dl-field">
          <textarea
            id={`changes-${item.id}`}
            rows={4}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={10000}
          />
        </div>
        <p className="dl-meta">To pin a note on a screen, open the review.</p>
      </Dialog>
    </>
  );
}

/** One side of a changed screen, cropped to the change the way the chat card crops it. */
function Shot({
  preview,
  screen,
  side,
}: {
  preview?: Preview;
  screen: DesignReviewScreen;
  side: 'before' | 'after';
}) {
  if ((side === 'before' && screen.added) || (side === 'after' && screen.removed))
    return (
      <div className="dl-asks-shot empty">{side === 'before' ? 'Not on main' : 'Removed'}</div>
    );
  const src = side === 'before' ? preview?.beforeSrc : preview?.afterSrc;
  if (!preview || !src)
    return (
      <div className="dl-asks-shot">
        <Skeleton block label={`Loading ${screen.title}`} />
      </div>
    );
  const region = shotRegion(preview, side);
  return (
    <div className="dl-asks-shot">
      <svg
        className="v2-asks-image"
        role="img"
        aria-label={`${screen.title}, ${side}`}
        viewBox={`${region.x} ${region.y} ${region.w} ${region.h}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <image href={src} width={preview.width} height={preview.height} />
        {/* After outlines what changed, as the review's Show changes does. */}
        {side === 'after' &&
          preview.areas.map(
            (area, index) =>
              area.after && (
                <rect
                  key={index}
                  className="v2-asks-change"
                  x={area.after.x - 4}
                  y={area.after.y - 4}
                  width={area.after.w + 8}
                  height={area.after.h + 8}
                  rx={6}
                  vectorEffect="non-scaling-stroke"
                />
              ),
          )}
      </svg>
    </div>
  );
}
