// Decides which worker reports a manager shows and which reads are errors.
// tests/structure.test.ts keeps this module pure.

import type { SavedReport } from './assignment.js';

export type ReportReadFact =
  | { kind: 'skip' }
  | { kind: 'error'; message: string }
  | { kind: 'no-report' }
  | { kind: 'report'; assignmentId: string; report: SavedReport };

export interface ReportDecisionFacts {
  shownIds: readonly string[];
  facts: readonly ReportReadFact[];
}

export interface ReportDeliveryPlan {
  reports: { assignmentId: string; report: SavedReport }[];
  errors: string[];
}

export const decideReportDelivery = (facts: ReportDecisionFacts): ReportDeliveryPlan => {
  const shown = new Set(facts.shownIds);
  const reports: ReportDeliveryPlan['reports'] = [];
  const errors: string[] = [];

  for (const fact of facts.facts) {
    if (fact.kind === 'skip' || fact.kind === 'no-report') {
      continue;
    }

    if (fact.kind === 'error') {
      errors.push(fact.message);

      continue;
    }

    if (shown.has(fact.assignmentId)) {
      continue;
    }

    shown.add(fact.assignmentId);
    reports.push({ assignmentId: fact.assignmentId, report: fact.report });
  }

  return { reports, errors };
};
