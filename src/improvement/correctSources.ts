import { errorMessage } from '../errors.ts';
import { readEvents } from './event.ts';
import type { EventRead, ImprovementEvent } from './event.ts';
import { findOptionalProjectRoot, projectRootsOf } from './projectRoot.ts';
import { readSweepIndex } from './sweepIndex.ts';
import type { SweepIndexRead } from './sweepIndex.ts';

type EventGap = EventRead['gaps'][number];

type ProjectEventRead =
  | {
      projectRoot: string;
      status: 'read';
      events: ImprovementEvent[];
      gaps: EventGap[];
    }
  | { projectRoot: string; status: 'failed'; reason: string };

export interface CorrectSources {
  projects: ProjectEventRead[];
  indexProblem: string | null;
}

export interface FailedProject {
  projectRoot: string;
  reason: string;
}

export interface EventOwner {
  id: string;
  projectRoot: string;
}

const indexProblemOf = (index: SweepIndexRead): string | null => {
  if (index.status === 'malformed') {
    return index.reason;
  }

  return index.status === 'newer' ? index.notice : null;
};

const projectRoots = async (sources: {
  agentDirectory: string;
  cwd: string;
}): Promise<{ roots: string[]; indexProblem: string | null }> => {
  const index = await readSweepIndex(sources.agentDirectory);
  const indexed = index.status === 'read' ? Object.keys(index.index.projects) : [];
  const current = await findOptionalProjectRoot(sources.cwd);

  return { roots: projectRootsOf(indexed, current), indexProblem: indexProblemOf(index) };
};

export const correctEvents = (sources: CorrectSources): ImprovementEvent[] =>
  sources.projects.flatMap((project) => (project.status === 'read' ? project.events : []));

export const correctGaps = (sources: CorrectSources): EventGap[] =>
  sources.projects.flatMap((project) => (project.status === 'read' ? project.gaps : []));

export const correctFailed = (sources: CorrectSources): FailedProject[] =>
  sources.projects.flatMap((project) =>
    project.status === 'failed'
      ? [{ projectRoot: project.projectRoot, reason: project.reason }]
      : [],
  );

export const correctProjectRoots = (sources: CorrectSources): string[] =>
  sources.projects.flatMap((project) => (project.status === 'read' ? [project.projectRoot] : []));

export const correctEventOwners = (sources: CorrectSources): EventOwner[] =>
  sources.projects.flatMap((project) =>
    project.status === 'read'
      ? project.events.map((event) => ({ id: event.id, projectRoot: project.projectRoot }))
      : [],
  );

export const correctIndexProblem = (sources: CorrectSources): string | null => sources.indexProblem;

export const readCorrectSources = async (sources: {
  agentDirectory: string;
  cwd: string;
}): Promise<CorrectSources> => {
  const projects: ProjectEventRead[] = [];
  const { roots, indexProblem } = await projectRoots(sources);

  for (const projectRoot of roots) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each project root is read in sorted order.
      const read = await readEvents(projectRoot);

      projects.push({
        projectRoot,
        status: 'read',
        events: read.events,
        gaps: read.gaps,
      });
    } catch (error) {
      projects.push({ projectRoot, status: 'failed', reason: errorMessage(error) });
    }
  }

  return { projects, indexProblem };
};
