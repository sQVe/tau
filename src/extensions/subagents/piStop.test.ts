import { expect, it } from 'vitest';

import { decidePiStop } from './piStop.js';
import type { PiStopFacts, PiStopStep } from './piStop.js';

const facts = (overrides: Partial<PiStopFacts>): PiStopFacts => ({
  paneFound: true,
  owned: true,
  exited: false,
  closed: false,
  graceElapsed: true,
  ...overrides,
});

it.each<[string, Partial<PiStopFacts>, PiStopStep]>([
  ['a live owned worker', {}, 'close'],
  ['a live worker without saved ownership', { owned: false }, 'close'],
  ['a finished worker inside its grace', { graceElapsed: false }, 'wait'],
  ['a worker whose process exited before herdr removed its pane', { exited: true }, 'wait'],
  ['a pane Tau already closed', { closed: true }, 'wait'],
  ['a removed pane after the process exited', { paneFound: false, exited: true }, 'stopped'],
  ['a removed pane without saved ownership', { paneFound: false, owned: false }, 'stopped'],
  ['a pane Tau closed while its process ends', { paneFound: false, closed: true }, 'wait'],
  ['a pane herdr removed while the process ID is in use', { paneFound: false }, 'processRemains'],
])('decides the stop step for %s', (_case, overrides, step) => {
  expect(decidePiStop(facts(overrides))).toBe(step);
});
