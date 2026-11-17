import { errorMessage } from '../errors.ts';
import { readEvents } from './event.ts';
import type { EventRead, ImprovementEvent } from './event.ts';
import { findOptionalProjectRoot } from './projectRoot.ts';
import { readSweepIndex } from './sweepIndex.ts';

type SkippedEvent = EventRead['skipped'][number];

type ProjectEventRead =
  | {
      projectRoot: string;
      status: 'read';
      events: ImprovementEvent[];
      skipped: SkippedEvent[];
    }
  | { projectRoot: string; status: 'failed'; reason: string };

export interface CorrectSources {
  projects: ProjectEventRead[];
}

export interface FailedProject {
  projectRoot: string;
  reason: string;
}

export interface EventOwner {
  id: string;
  projectRoot: string;
}

const indexProjectRoots = async (agentDirectory: string): Promise<string[]> => {
  const index = await readSweepIndex(agentDirectory);

  return index.status === 'read' ? Object.keys(index.index.projects) : [];
};

const projectRoots = async (sources: {
  agentDirectory: string;
  cwd: string;
}): Promise<string[]> => {
  const indexed = await indexProjectRoots(sources.agentDirectory);
  const current = await findOptionalProjectRoot(sources.cwd);
  const roots = current === null ? indexed : [...indexed, current];

  return [...new Set(roots)].toSorted();
};

export const correctEvents = (sources: CorrectSources): ImprovementEvent[] =>
  sources.projects.flatMap((project) => (project.status === 'read' ? project.events : []));

export const correctSkipped = (sources: CorrectSources): SkippedEvent[] =>
  sources.projects.flatMap((project) => (project.status === 'read' ? project.skipped : []));

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

export const readCorrectSources = async (sources: {
  agentDirectory: string;
  cwd: string;
}): Promise<CorrectSources> => {
  const projects: ProjectEventRead[] = [];

  for (const projectRoot of await projectRoots(sources)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each project root is read in sorted order.
      const read = await readEvents(projectRoot);

      projects.push({
        projectRoot,
        status: 'read',
        events: read.events,
        skipped: read.skipped,
      });
    } catch (error) {
      projects.push({ projectRoot, status: 'failed', reason: errorMessage(error) });
    }
  }

  return { projects };
};
