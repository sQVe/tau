import { classEventId } from './classIdentity.ts';
import type { ImprovementEvent } from './event.ts';

type ClassEvent = Extract<ImprovementEvent, { kind: 'class' }>;

type DecisionEvent = Extract<ImprovementEvent, { kind: 'decision' }>;

type FactsEvent = Extract<ImprovementEvent, { kind: 'facts' }>;

export type ClassLevel = 'architecture' | 'type' | 'lint' | 'test' | 'prose';

export interface ProposedClass {
  identity: string;
  level: ClassLevel;
  summary: string;
  occurrences: string[];
  reverted: boolean;
  qaMiss: boolean;
}

export interface RankedClass extends ProposedClass {
  id: string;
  repeatCount: number;
}

export interface RejectedClass {
  identity: string;
  occurrences: readonly string[];
}

interface Measure {
  value: number | undefined;
  coverage: number;
}

export interface CorrectMeasures {
  repeatRateAfterCheck: Measure;
  medianFixRounds: Measure;
  acceptanceRate: Measure;
}

const maximumClasses = 5;

const minimumRepeatCount = 2;

const rankClass = (proposed: ProposedClass): RankedClass => ({
  ...proposed,
  id: classEventId(proposed.identity, proposed.occurrences),
  repeatCount: new Set(proposed.occurrences).size,
});

const countsAsClass = (ranked: RankedClass): boolean =>
  ranked.repeatCount >= minimumRepeatCount || ranked.reverted || ranked.qaMiss;

const compareClasses = (left: RankedClass, right: RankedClass): number => {
  if (left.repeatCount !== right.repeatCount) {
    return right.repeatCount - left.repeatCount;
  }

  return left.identity.localeCompare(right.identity);
};

// A rejected class stays rejected while the proposal adds no occurrence it did not already have.
const isRejected = (proposed: RankedClass, rejected: readonly RejectedClass[]): boolean =>
  rejected.some((entry) => {
    if (entry.identity !== proposed.identity) {
      return false;
    }

    const known = new Set(entry.occurrences);

    return proposed.occurrences.every((occurrence) => known.has(occurrence));
  });

export const decideClasses = (facts: {
  classes: readonly ProposedClass[];
  rejected: readonly RejectedClass[];
}): RankedClass[] => {
  const unique = new Map<string, RankedClass>();

  for (const proposed of facts.classes) {
    const ranked = rankClass(proposed);

    if (!unique.has(ranked.id)) {
      unique.set(ranked.id, ranked);
    }
  }

  const counted = [...unique.values()].filter(
    (ranked) => !isRejected(ranked, facts.rejected) && countsAsClass(ranked),
  );

  return counted.toSorted(compareClasses).slice(0, maximumClasses);
};

const isLater = (candidate: DecisionEvent, current: DecisionEvent): boolean => {
  const candidateTime = Date.parse(candidate.createdAt);
  const currentTime = Date.parse(current.createdAt);

  if (candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }

  return candidate.id > current.id;
};

export const effectiveDecisions = (decisions: readonly DecisionEvent[]): DecisionEvent[] => {
  const latest = new Map<string, DecisionEvent>();

  for (const decision of decisions) {
    const current = latest.get(decision.subject);

    if (current === undefined || isLater(decision, current)) {
      latest.set(decision.subject, decision);
    }
  }

  return [...latest.values()];
};

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;

  return (lower + upper) / 2;
};

const measure = (value: number | undefined, coverage: number): Measure => ({ value, coverage });

const repeatRate = (
  classes: readonly ClassEvent[],
  decisions: readonly DecisionEvent[],
): Measure => {
  const classById = new Map(classes.map((event) => [event.id, event]));

  const approved = decisions.filter(
    (decision) => decision.choice === 'approved' && classById.has(decision.subject),
  );

  if (approved.length === 0) {
    return measure(undefined, 0);
  }

  const recurring = approved.filter((decision) => {
    const approvedClass = classById.get(decision.subject);

    if (approvedClass === undefined) {
      return false;
    }

    return classes.some(
      (event) =>
        event.identity === approvedClass.identity &&
        Date.parse(event.createdAt) > Date.parse(decision.createdAt),
    );
  });

  return measure(recurring.length / approved.length, approved.length);
};

const fixRounds = (factsEvents: readonly FactsEvent[]): Measure => {
  const counts = factsEvents.flatMap((event) => {
    const count = event.facts['fixCaptures'];

    return typeof count === 'number' ? [count] : [];
  });

  if (counts.length === 0) {
    return measure(undefined, 0);
  }

  return measure(median(counts), counts.length);
};

const acceptanceRate = (
  classes: readonly ClassEvent[],
  decisions: readonly DecisionEvent[],
): Measure => {
  const classIds = new Set(classes.map((event) => event.id));
  const classDecisions = decisions.filter((decision) => classIds.has(decision.subject));

  if (classDecisions.length === 0) {
    return measure(undefined, 0);
  }

  const approved = classDecisions.filter((decision) => decision.choice === 'approved').length;

  return measure(approved / classDecisions.length, classDecisions.length);
};

export const decideMeasures = (facts: {
  classes: readonly ClassEvent[];
  decisions: readonly DecisionEvent[];
  factsEvents: readonly FactsEvent[];
}): CorrectMeasures => {
  const decisions = effectiveDecisions(facts.decisions);

  return {
    repeatRateAfterCheck: repeatRate(facts.classes, decisions),
    medianFixRounds: fixRounds(facts.factsEvents),
    acceptanceRate: acceptanceRate(facts.classes, decisions),
  };
};
