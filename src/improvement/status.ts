import { readEvents } from './event.ts';
import { findOptionalProjectRoot } from './projectRoot.ts';
import { decideCorrectDue, decideSweep, decideTasks } from './statusDecision.ts';
import type { ImprovementStatus } from './statusDecision.ts';
import type { SweepOutcome } from './sweep.ts';
import { readSweepIndex } from './sweepIndex.ts';

export const readImprovementStatus = async (sources: {
  cwd: string;
  agentDirectory: string;
  now: Date;
  sessionSweep?: SweepOutcome | undefined;
}): Promise<ImprovementStatus> => {
  const projectRoot = await findOptionalProjectRoot(sources.cwd);

  const eventRead =
    projectRoot === null ? { events: [], skipped: [] } : await readEvents(projectRoot);

  const index = await readSweepIndex(sources.agentDirectory);
  const { tasks, coverage } = decideTasks(eventRead.events);

  // No event marks a `correct` pass yet.
  const correctDue = decideCorrectDue({
    events: eventRead.events,
    lastPassAt: undefined,
    now: sources.now,
  });

  const sweep = decideSweep({ index, projectRoot, sessionSweep: sources.sessionSweep });

  return {
    projectRoot,
    tasks,
    correctDue,
    coverage,
    sweep,
    skipped: eventRead.skipped,
  };
};
