import {
  decideClasses,
  decideMeasures,
  effectiveDecisions,
} from '../../improvement/correctDecision.js';
import type {
  CorrectMeasures,
  ProposedClass,
  RankedClass,
} from '../../improvement/correctDecision.js';
import {
  correctEventOwners,
  correctEvents,
  correctFailed,
  correctIndexProblem,
  correctProjectRoots,
  correctGaps,
  readCorrectSources,
} from '../../improvement/correctSources.js';
import type { EventOwner, FailedProject } from '../../improvement/correctSources.js';
import type { ImprovementEvent } from '../../improvement/event.js';
import { decideTasks } from '../../improvement/statusDecision.js';
import type { CoverageCounts } from '../../improvement/statusDecision.js';
import type { RecordRequest } from './recordRequest.js';

type ClassEvent = Extract<ImprovementEvent, { kind: 'class' }>;

type DecisionEvent = Extract<ImprovementEvent, { kind: 'decision' }>;

type FactsEvent = Extract<ImprovementEvent, { kind: 'facts' }>;

type CorrectRequest = Extract<RecordRequest, { action: 'correct' }>;

interface CorrectBase {
  measures: CorrectMeasures;
  coverage: CoverageCounts;
  gaps: { path: string; reason: string }[];
  failed: FailedProject[];
  projectRoots: string[];
  eventOwners: EventOwner[];
  indexProblem: string | null;
}

export type CorrectResult =
  | (CorrectBase & { events: ImprovementEvent[]; rejected: string[] })
  | (CorrectBase & { classes: RankedClass[] });

const isClass = (event: ImprovementEvent): event is ClassEvent => event.kind === 'class';

const isDecision = (event: ImprovementEvent): event is DecisionEvent => event.kind === 'decision';

const isFacts = (event: ImprovementEvent): event is FactsEvent => event.kind === 'facts';

const rejectedClassIds = (
  classes: readonly ClassEvent[],
  decisions: readonly DecisionEvent[],
): string[] => {
  const classIds = new Set(classes.map((event) => event.id));

  return effectiveDecisions(decisions)
    .filter((decision) => decision.choice === 'rejected' && classIds.has(decision.subject))
    .map((decision) => decision.subject)
    .toSorted();
};

const rejectedClasses = (
  classes: readonly ClassEvent[],
  decisions: readonly DecisionEvent[],
): ClassEvent[] => {
  const rejected = new Set(rejectedClassIds(classes, decisions));

  return classes.filter((event) => rejected.has(event.id));
};

export const runCorrect = async (
  agentDirectory: string,
  cwd: string,
  request: CorrectRequest,
): Promise<CorrectResult> => {
  const sources = await readCorrectSources({ agentDirectory, cwd });
  const events = correctEvents(sources);
  const classes = events.filter(isClass);
  const decisions = events.filter(isDecision);
  const factsEvents = events.filter(isFacts);
  const measures = decideMeasures({ classes, decisions, factsEvents });
  const coverage = decideTasks(events).coverage;

  const base = {
    measures,
    coverage,
    gaps: correctGaps(sources),
    failed: correctFailed(sources),
    projectRoots: correctProjectRoots(sources),
    eventOwners: correctEventOwners(sources),
    indexProblem: correctIndexProblem(sources),
  };

  if (request.classes === undefined) {
    const rejected = rejectedClassIds(classes, decisions);

    return { ...base, events, rejected };
  }

  const proposed: ProposedClass[] = request.classes;

  const ranked = decideClasses({
    classes: proposed,
    rejected: rejectedClasses(classes, decisions),
  });

  return { ...base, classes: ranked };
};
