import { expect, it } from 'vitest';

import type { SavedReport } from './assignment.js';
import { decideReportDelivery } from './reportDecision.js';
import type { ReportDecisionFacts, ReportDeliveryPlan, ReportReadFact } from './reportDecision.js';

const report = (summary: string): SavedReport => ({
  outcome: 'success',
  summary,
  evidence: [],
});

it.each<{
  name: string;
  facts: ReportDecisionFacts;
  expected: ReportDeliveryPlan;
}>([
  {
    name: 'shows a new report once',
    facts: {
      shownIds: [],
      facts: [{ kind: 'report', assignmentId: 'assignment-a', report: report('first') }],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-a', report: report('first') }],
      errors: [],
    },
  },
  {
    name: 'does not show a report already in the shown IDs',
    facts: {
      shownIds: ['assignment-a'],
      facts: [{ kind: 'report', assignmentId: 'assignment-a', report: report('first') }],
    },
    expected: { reports: [], errors: [] },
  },
  {
    name: 'shows a second report whose ID is not shown',
    facts: {
      shownIds: ['assignment-a'],
      facts: [{ kind: 'report', assignmentId: 'assignment-b', report: report('second') }],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-b', report: report('second') }],
      errors: [],
    },
  },
  {
    name: 'reports a missing assignment file as an error',
    facts: {
      shownIds: [],
      facts: [{ kind: 'error', message: 'Missing assignment file: /agent/assignment.json.' }],
    },
    expected: {
      reports: [],
      errors: ['Missing assignment file: /agent/assignment.json.'],
    },
  },
  {
    name: 'reports a malformed assignment file as an error',
    facts: {
      shownIds: [],
      facts: [{ kind: 'error', message: 'Malformed assignment /agent/assignment.json: not JSON.' }],
    },
    expected: {
      reports: [],
      errors: ['Malformed assignment /agent/assignment.json: not JSON.'],
    },
  },
  {
    name: 'skips a child without an assignment label',
    facts: { shownIds: [], facts: [{ kind: 'skip' }] },
    expected: { reports: [], errors: [] },
  },
  {
    name: 'ignores an assignment whose report is not written yet',
    facts: { shownIds: [], facts: [{ kind: 'no-report' }] },
    expected: { reports: [], errors: [] },
  },
  {
    name: 'shows one report when two children share an assignment ID',
    facts: {
      shownIds: [],
      facts: [
        { kind: 'report', assignmentId: 'assignment-a', report: report('first') },
        { kind: 'report', assignmentId: 'assignment-a', report: report('first') },
      ],
    },
    expected: {
      reports: [{ assignmentId: 'assignment-a', report: report('first') }],
      errors: [],
    },
  },
])('$name', ({ facts, expected }) => {
  expect(decideReportDelivery(facts)).toStrictEqual(expected);
});

it('reads no report fact as an error and never as no report', () => {
  const facts: ReportReadFact[] = [
    { kind: 'error', message: 'Missing assignment file: /agent/assignment.json.' },
    { kind: 'no-report' },
  ];

  const plan = decideReportDelivery({ shownIds: [], facts });

  expect(plan.reports).toEqual([]);
  expect(plan.errors).toEqual(['Missing assignment file: /agent/assignment.json.']);
});
