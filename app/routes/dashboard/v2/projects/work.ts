import type {
  ProjectWork,
  WorkRow,
  WorkStage,
} from '../../../../../server/features/repositories/project-work.ts';

const SECTIONS: { stage: WorkStage; title: string; sub?: string }[] = [
  { stage: 'needs-you', title: 'Needs you' },
  { stage: 'running', title: 'Running' },
  { stage: 'up-next', title: 'Up next', sub: 'Written down, not started. Open one to start it.' },
  {
    stage: 'found',
    title: 'Found by agents',
    sub: 'Not on your list yet. Open one to add it to Up next or dismiss it.',
  },
];

/** The open sections in order, each with its rows; a section with nothing in it is left out. */
export function workSections(work: Pick<ProjectWork, 'rows'>) {
  return SECTIONS.map((section) => ({
    ...section,
    rows: work.rows.filter((row) => row.stage === section.stage),
  })).filter((section): section is typeof section & { rows: WorkRow[] } => section.rows.length > 0);
}
