import { errorMessage } from '../errors.ts';
import { readEvents } from './event.ts';
import type { ImprovementEvent } from './event.ts';
import { findOptionalProjectRoot } from './projectRoot.ts';
import { readSweepIndex } from './sweepIndex.ts';

type ProjectEventRead =
  | { projectRoot: string; status: 'read'; events: ImprovementEvent[] }
  | { projectRoot: string; status: 'failed'; reason: string };

export interface CorrectSources {
  projects: ProjectEventRead[];
  events: ImprovementEvent[];
  unknownProjects: string[];
  skipped: { path: string; notice: string }[];
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

export const readCorrectSources = async (sources: {
  agentDirectory: string;
  cwd: string;
}): Promise<CorrectSources> => {
  const projects: ProjectEventRead[] = [];
  const events: ImprovementEvent[] = [];
  const unknownProjects: string[] = [];
  const skipped: { path: string; notice: string }[] = [];

  for (const projectRoot of await projectRoots(sources)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each project root is read in sorted order.
      const read = await readEvents(projectRoot);

      projects.push({ projectRoot, status: 'read', events: read.events });
      events.push(...read.events);
      skipped.push(...read.skipped);
    } catch (error) {
      projects.push({ projectRoot, status: 'failed', reason: errorMessage(error) });
      unknownProjects.push(projectRoot);
    }
  }

  return { projects, events, unknownProjects, skipped };
};
