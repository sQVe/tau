import { expect, it, onTestFinished, vi } from 'vitest';

import { monotonicNow } from './admission.js';
import { boundedTiming } from './controllerBudget.js';
import type { Task } from './types.js';

it('refuses child work when the parent deadline leaves no work budget', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'hrtime'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const parent = {
    deadline: 61_000,
    cancellationBudget: 5000,
    tree: { monotonicDeadline: monotonicNow() + 1000 },
  } as Task;
  const timing = {
    createdAt: 0,
    deadline: 60_000,
    expires: performance.now() + 60_000,
    cancellationBudget: 5000,
  };

  expect(() => boundedTiming(timing, parent)).toThrow('no child work budget remaining');
});
