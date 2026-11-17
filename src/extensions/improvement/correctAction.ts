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
import { readCorrectSources } from '../../improvement/correctSources.js';
import type { ImprovementEvent } from '../../improvement/event.js';
import { decideTasks } from '../../improvement/statusDecision.js';
import type { CoverageCounts } from '../../improvement/statusDecision.js';
import type { RecordRequest } from './recordRequest.js';

type ClassEvent = Extract<ImprovementEvent, { kind: 'class' }>;

type DecisionEvent = Extract<ImprovementEvent, { kind: 'decision' }>;

type FactsEvent = Extract<ImprovementEvent, { kind: 'facts' }>;

type CorrectRequest = Extract<RecordRequest, { action: 'correct' }>;

interface FailedProject {
  projectRoot: string;
  reason: string;
}

interface CorrectBase {
  measures: CorrectMeasures;
  coverage: CoverageCounts;
  skipped: { path: string; notice: string }[];
  failed: FailedProject[];
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

export const runCorrect = async (
  agentDirectory: string,
  cwd: string,
  request: CorrectRequest,
): Promise<CorrectResult> => {
  const sources = await readCorrectSources({ agentDirectory, cwd });
  const classes = sources.events.filter(isClass);
  const decisions = sources.events.filter(isDecision);
  const factsEvents = sources.events.filter(isFacts);
  const measures = decideMeasures({ classes, decisions, factsEvents });
  const coverage = decideTasks(sources.events).coverage;

  const failed = sources.projects.flatMap((project) =>
    project.status === 'failed'
      ? [{ projectRoot: project.projectRoot, reason: project.reason }]
      : [],
  );

  const base = { measures, coverage, skipped: sources.skipped, failed };

  if (request.classes === undefined) {
    const rejected = rejectedClassIds(classes, decisions);

    return { ...base, events: sources.events, rejected };
  }

  const proposed: ProposedClass[] = request.classes;

  const ranked = decideClasses({
    classes: proposed,
    rejected: new Set(rejectedClassIds(classes, decisions)),
  });

  return { ...base, classes: ranked };
};
