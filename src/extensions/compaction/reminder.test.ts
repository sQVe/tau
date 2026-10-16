import { expect, it } from 'vitest';

import { decideReminder } from './reminder.js';

it.each([
  { contextPercent: 40, reminded: false, step: 'keep' },
  { contextPercent: 50, reminded: false, step: 'keep' },
  { contextPercent: 50.1, reminded: false, step: 'remind' },
  { contextPercent: 70, reminded: true, step: 'keep' },
  { contextPercent: 40, reminded: true, step: 'rearm' },
  { contextPercent: undefined, reminded: false, step: 'keep' },
  { contextPercent: undefined, reminded: true, step: 'keep' },
])(
  '$contextPercent percent with reminded $reminded: $step',
  ({ contextPercent, reminded, step }) => {
    expect(decideReminder({ contextPercent, thresholdPercent: 50, reminded })).toBe(step);
  },
);
