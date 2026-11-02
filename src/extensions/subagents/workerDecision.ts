import type { SavedQuestion, SavedReport } from './assignment.js';

export type WorkerReadFact =
  | { kind: 'skip' }
  | { kind: 'error'; message: string }
  | {
      kind: 'assignment';
      assignmentId: string;
      address: string;
      report: SavedReport | null;
      questions: SavedQuestion[];
    };

export interface WorkerDecisionFacts {
  shownKeys: readonly string[];
  facts: readonly WorkerReadFact[];
}

export interface WorkerDeliveryPlan {
  reports: { assignmentId: string; report: SavedReport }[];
  questions: { assignmentId: string; address: string; question: SavedQuestion }[];
  errors: string[];
}

export const reportKey = (assignmentId: string): string => `report:${assignmentId}`;

export const questionKey = (assignmentId: string, questionId: string): string =>
  `question:${assignmentId}:${questionId}`;

const takeReport = (
  fact: Extract<WorkerReadFact, { kind: 'assignment' }>,
  shown: Set<string>,
): SavedReport | undefined => {
  const key = reportKey(fact.assignmentId);

  if (fact.report === null || shown.has(key)) {
    return undefined;
  }

  shown.add(key);

  return fact.report;
};

const takeQuestions = (
  fact: Extract<WorkerReadFact, { kind: 'assignment' }>,
  shown: Set<string>,
): SavedQuestion[] => {
  const taken: SavedQuestion[] = [];

  for (const question of fact.questions) {
    const key = questionKey(fact.assignmentId, question.questionId);

    if (!shown.has(key)) {
      shown.add(key);
      taken.push(question);
    }
  }

  return taken;
};

export const decideWorkerDelivery = (facts: WorkerDecisionFacts): WorkerDeliveryPlan => {
  const shown = new Set(facts.shownKeys);
  const plan: WorkerDeliveryPlan = { reports: [], questions: [], errors: [] };

  for (const fact of facts.facts) {
    if (fact.kind === 'skip') {
      continue;
    }

    if (fact.kind === 'error') {
      plan.errors.push(fact.message);

      continue;
    }

    const report = takeReport(fact, shown);

    if (report !== undefined) {
      plan.reports.push({ assignmentId: fact.assignmentId, report });
    }

    for (const question of takeQuestions(fact, shown)) {
      plan.questions.push({ assignmentId: fact.assignmentId, address: fact.address, question });
    }
  }

  return plan;
};
