import { expect, it } from 'vitest';

import { decideStartupFailure } from './startupFailureDecision.js';
import type { StartupEvidence, StartupFailureOutcome } from './startupFailureDecision.js';

const failed = (kind: 'failed' | 'taskRetired' | 'taskNewer'): StartupEvidence => ({
  status: 'current',
  failure: { version: 1, kind, message: 'Saved model changed.' },
});

it.each<{ evidence: StartupEvidence; outcome: StartupFailureOutcome }>([
  {
    evidence: { status: 'missing' },
    outcome: { notice: undefined, workerError: undefined },
  },
  {
    evidence: failed('failed'),
    outcome: { notice: undefined, workerError: 'Saved model changed.' },
  },
  {
    evidence: failed('taskNewer'),
    outcome: { notice: undefined, workerError: 'Saved model changed.' },
  },
  {
    evidence: failed('taskRetired'),
    outcome: { notice: 'restart', workerError: 'Saved model changed.' },
  },
  {
    evidence: { status: 'newer' },
    outcome: { notice: 'newerRecord', workerError: undefined },
  },
  {
    evidence: { status: 'malformed' },
    outcome: { notice: 'unreadableRecord', workerError: undefined },
  },
])('decides the outcome for $evidence', ({ evidence, outcome }) => {
  expect(decideStartupFailure(evidence)).toEqual(outcome);
});
