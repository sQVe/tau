import { expect, it } from 'vitest';

import { monotonicNow } from './admission.js';
import { boundedTiming } from './controllerBudget.js';
import type { Task } from './types.js';

it('refuses child work when the parent deadline leaves no work budget', () => {
  const now = performance.now();
  const parent = {
    deadline: Date.now(),
    cancellationBudget: 5000,
    tree: { monotonicDeadline: monotonicNow() + 1000 },
  } as Task;
  const timing = {
    createdAt: Date.now(),
    deadline: Date.now() + 60_000,
    expires: now + 60_000,
    cancellationBudget: 5000,
  };

  expect(() => boundedTiming(timing, parent)).toThrow('no child work budget remaining');
});
