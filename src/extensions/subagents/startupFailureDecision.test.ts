import { expect, it } from 'vitest';

import { startupFailureAdvice } from './startupFailureDecision.js';
import type { StartupEvidence } from './startupFailureDecision.js';

const failed = (kind: 'failed' | 'taskRetired'): StartupEvidence => ({
  status: 'current',
  failure: { version: 1, kind, message: 'Saved model changed.' },
});

it.each([
  { evidence: { status: 'missing' } as const, parts: [], absent: ['Worker error', 'Restart'] },
  {
    evidence: failed('failed'),
    parts: ['Worker error: Saved model changed.'],
    absent: ['Restart'],
  },
  {
    evidence: failed('taskRetired'),
    parts: [
      'Worker error: Saved model changed.',
      'Tau was updated on disk',
      'Restart this session',
    ],
    absent: [],
  },
  {
    evidence: { status: 'newer' } as const,
    parts: ['newer Tau', 'restart this session'],
    absent: ['Worker error'],
  },
  { evidence: { status: 'malformed' } as const, parts: ['unreadable'], absent: ['Worker error'] },
])('decides the advice for $evidence', ({ evidence, parts, absent }) => {
  const advice = startupFailureAdvice(evidence);

  for (const part of parts) {
    expect(advice).toContain(part);
  }

  for (const part of absent) {
    expect(advice).not.toContain(part);
  }
});
