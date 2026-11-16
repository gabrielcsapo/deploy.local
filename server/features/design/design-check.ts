import type {
  DesignBuildReport,
  InboxItem,
  TaskDesignCheck,
} from '../../../shared/v2/contracts.ts';
import { fail } from '../../kernel/errors.ts';
import { db, event, get, id, list, now, save } from '../../workspace/store.ts';
import { queueMessage, queuedMessage } from '../../workspace/queued-message.ts';
import { createInboxItem, registerInboxSource } from '../../v2/inbox.ts';

/** A pending, missing or undone landing cannot grant a build check. */
export function approvedTaskDesign(owner: string, taskId: string) {
  const landings = new Map(list('design-review-landing', owner).map((row) => [row.id, row]));
  return list('v2-inbox-native', owner)
    .filter(
      (row) =>
        row.context?.source === 'design' &&
        row.context.taskId === taskId &&
        row.item.state === 'answered' &&
        row.item.answer?.actionId === 'approve' &&
        landings.get(row.id)?.state === 'landed',
    )
    .sort((a, b) => b.item.answer.at.localeCompare(a.item.answer.at))[0];
}

export function taskDesignCheck(owner: string, taskId: string): TaskDesignCheck | undefined {
  const row = approvedTaskDesign(owner, taskId);
  if (!row) return undefined;
  const landing = get('design-review-landing', owner, row.id);
  const report = list('design-review-built', owner).find((built) => built.id === row.id);
  const decision =
    report?.decisionId &&
    list('v2-inbox-native', owner).find((item) => item.id === report.decisionId);
  return {
    reviewId: row.id,
    title: row.item.title,
    approvedAt: row.item.answer.at,
    commit: landing.commit,
    boards: row.context.checkBoards ?? [],
    reviewHref: `/dashboard/inbox?item=${encodeURIComponent(row.id)}`,
    ...(decision
      ? { decisionHref: `/dashboard/inbox?item=${encodeURIComponent(decision.id)}` }
      : {}),
    state: report?.state ?? 'waiting',
    ...(report
      ? Object.fromEntries(
          [
            'at',
            'captures',
            'differences',
            'text',
            'why',
            'board',
            'width',
            'screenshotId',
            'appCommit',
            'comparisons',
          ]
            .filter((key) => report[key] !== undefined)
            .map((key) => [key, report[key]]),
        )
      : {}),
  };
}

function words(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 4000)
    fail(`${label} must contain plain words (maximum 4000 characters)`);
  return value.trim();
}

/** Replace a report and its unanswered decision atomically; answered receipts stay immutable. */
export function reportDesignBuild(owner: string, taskId: string, args: any) {
  if (
    !['matches', 'differs'].includes(args.state) ||
    (args.state === 'differs' && (!Number.isInteger(args.differences) || args.differences < 1))
  )
    fail('Name matches or differs with a positive differences count');
  const text = words(args.text, 'What differs');
  if (args.state === 'differs' && !text) fail('Say what differs in plain words');
  const why = words(args.why, 'Why');
  if (args.captures !== undefined && (!Number.isInteger(args.captures) || args.captures < 0))
    fail('captures must be a non-negative integer');
  return db
    .transaction(() => {
      const row = approvedTaskDesign(owner, taskId);
      if (!row) fail('This task has no approved design', 409);
      const check = taskDesignCheck(owner, taskId)!;
      if (args.board !== undefined && !check.boards.some((entry) => entry.file === args.board))
        fail('Name a board in the approved design');
      const board = check.boards.find((entry) => entry.file === args.board) ?? check.boards[0];
      if (
        args.width !== undefined &&
        (!Number.isInteger(args.width) || args.width < 320 || args.width > 2560)
      )
        fail('Width must be 320 to 2560');
      const shot =
        args.screenshotId === undefined ? undefined : get('screenshot', owner, args.screenshotId);
      if (shot && (shot.taskId !== taskId || !shot.image)) fail('Use a capture from this task');
      if (shot && args.width !== undefined && shot.width !== args.width)
        fail('Capture width does not match the report');
      if (
        args.comparisons !== undefined &&
        (!Array.isArray(args.comparisons) || args.comparisons.length > 100)
      )
        fail('comparisons must be a list of at most 100 board captures');
      const comparisons = (args.comparisons ?? []).map((pair: any) => {
        if (!pair || !check.boards.some((entry) => entry.file === pair.board))
          fail('Name a board in the approved design');
        const capture = get('screenshot', owner, pair.screenshotId);
        if (capture.taskId !== taskId || !capture.image) fail('Use a capture from this task');
        if (
          !Number.isInteger(pair.width) ||
          pair.width < 320 ||
          pair.width > 2560 ||
          capture.width !== pair.width
        )
          fail('Capture width does not match the comparison');
        return {
          board: pair.board,
          width: pair.width,
          screenshotId: capture.id,
          image: capture.image,
          height: capture.height,
        };
      });
      const task = get('task', owner, taskId);
      const report: DesignBuildReport = {
        state: args.state,
        at: now(),
        ...(args.captures !== undefined ? { captures: args.captures } : {}),
        ...(args.state === 'differs' ? { differences: args.differences, text, why } : {}),
        ...(board
          ? { board: board.file, width: args.width ?? shot?.width ?? board.widths[0] }
          : {}),
        ...(shot ? { screenshotId: shot.id } : {}),
        ...(comparisons.length ? { comparisons } : {}),
        ...(task.publishedCommit || task.workspaceCommit?.commit
          ? { appCommit: task.publishedCommit || task.workspaceCommit.commit }
          : {}),
      };
      const waiting = list('v2-inbox-native', owner).find(
        (entry) =>
          entry.context?.source === 'design-build' &&
          entry.context.reviewId === row.id &&
          entry.item.state === 'waiting',
      );
      let decisionId: string | undefined;
      if (args.state === 'matches' && waiting) {
        const item = { ...waiting.item, state: 'withdrawn' };
        save('v2-inbox-native', owner, { ...waiting, item });
        event(owner, row.context.projectId, null, 'v2.inbox', { item });
      } else if (args.state === 'differs') {
        decisionId = waiting?.id ?? `design-build:${id()}`;
        const item: InboxItem = {
          id: decisionId!,
          kind: 'other',
          title: `${row.item.title} is built, with ${args.differences} difference${args.differences === 1 ? '' : 's'}`,
          text: text!,
          from: row.item.from,
          projectId: row.context.projectId,
          taskId,
          createdAt: waiting?.item.createdAt ?? report.at!,
          state: 'waiting',
          actions: [
            { id: 'fix-app', label: 'Fix the app', primary: true },
            { id: 'keep-design', label: 'Keep it and update the design' },
          ],
          designCheck: {
            reviewId: check.reviewId,
            title: check.title,
            approvedAt: check.approvedAt,
            commit: check.commit,
            boards: check.boards,
            reviewHref: check.reviewHref,
            ...report,
            projectId: row.context.projectId,
            ...(shot
              ? { capture: { image: shot.image, width: shot.width, height: shot.height } }
              : {}),
          },
        };
        const context = { source: 'design-build', reviewId: row.id, taskId };
        if (waiting) {
          save('v2-inbox-native', owner, { id: decisionId, item, context });
          event(owner, row.context.projectId, null, 'v2.inbox', { item });
        } else {
          createInboxItem(owner, item, context);
          event(owner, taskId, null, 'v2.conversation', {
            event: { kind: 'decision', id: decisionId, at: report.at, inboxItemId: decisionId },
          });
        }
      }
      const built = save('design-review-built', owner, {
        id: row.id,
        ...report,
        ...(decisionId ? { decisionId } : {}),
      });
      event(owner, taskId, null, 'design.built', { reviewId: row.id, state: report.state });
      return { built };
    })
    .immediate();
}

registerInboxSource('design-build', (owner, item, body, context) => {
  const report = get('design-review-built', owner, context.reviewId);
  if (report.decisionId !== item.id || report.state !== 'differs')
    fail('This report has been replaced', 409);
  const keep = body.actionId === 'keep-design';
  if (!keep && body.actionId !== 'fix-app') fail('Unknown design check answer');
  const content = [
    keep
      ? 'Keep it and update the design. The owner approved this difference. Change the approved board in this task’s own branch to match the app, so the pull request carries the design update. Do not change main directly.'
      : 'Fix the app to match the approved design, then compare again and report with deploy_design action "built".',
    `What differs: ${report.text}`,
    report.why && `Why: ${report.why}`,
    report.board &&
      `Board: design/boards/${report.board}${report.width ? ` at ${report.width} px` : ''}`,
    body.note?.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
  const queued = queuedMessage(owner, context.taskId);
  if (queued?.status === 'queued') {
    save('queued-message', owner, { ...queued, content: `${queued.content}\n\n${content}` });
    event(owner, context.taskId, null, 'message.queued', { status: 'queued' });
  } else queueMessage(owner, context.taskId, { content });
  save('design-review-built', owner, { ...report, state: keep ? 'kept' : 'waiting', at: now() });
  event(owner, context.taskId, null, 'design.built', {
    reviewId: context.reviewId,
    state: keep ? 'kept' : 'waiting',
  });
});
