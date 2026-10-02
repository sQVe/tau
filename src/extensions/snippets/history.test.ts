import type { SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { refillsHistory } from './history.js';

it.each<{ reason: SessionStartEvent['reason']; refills: boolean }>([
  { reason: 'startup', refills: false },
  { reason: 'new', refills: false },
  { reason: 'resume', refills: true },
  { reason: 'fork', refills: true },
  { reason: 'reload', refills: true },
])('refills history after $reason: $refills', ({ reason, refills }) => {
  expect(refillsHistory(reason)).toBe(refills);
});
