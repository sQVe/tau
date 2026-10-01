import { expect, it } from 'vitest';

import { decideReminder } from './reminder.js';

it.each([
  { contextTokens: 150_000, reminded: false, step: 'keep' },
  { contextTokens: 200_000, reminded: false, step: 'keep' },
  { contextTokens: 200_001, reminded: false, step: 'remind' },
  { contextTokens: 250_000, reminded: true, step: 'keep' },
  { contextTokens: 150_000, reminded: true, step: 'rearm' },
  { contextTokens: undefined, reminded: false, step: 'keep' },
  { contextTokens: undefined, reminded: true, step: 'keep' },
])('$contextTokens tokens with reminded $reminded: $step', ({ contextTokens, reminded, step }) => {
  expect(decideReminder({ contextTokens, thresholdTokens: 200_000, reminded })).toBe(step);
});
