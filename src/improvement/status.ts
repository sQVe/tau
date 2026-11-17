import { readEvents } from './event.ts';
import { findOptionalProjectRoot } from './projectRoot.ts';
import { decideCorrectDue, decideSweep, decideTasks, lastPassAt } from './statusDecision.ts';
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

  const eventRead = projectRoot === null ? { events: [], gaps: [] } : await readEvents(projectRoot);

  const index = await readSweepIndex(sources.agentDirectory);
  const { tasks, coverage } = decideTasks(eventRead.events);

  const correctDue = decideCorrectDue({
    events: eventRead.events,
    lastPassAt: lastPassAt(eventRead.events),
    now: sources.now,
    readFailed: eventRead.gaps.length > 0,
  });

  const sweep = decideSweep({ index, projectRoot, sessionSweep: sources.sessionSweep });

  return {
    projectRoot,
    tasks,
    correctDue,
    coverage,
    sweep,
    gaps: eventRead.gaps,
  };
};
