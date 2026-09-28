import { expect, it } from 'vitest';

import { handoffContract } from './handoff.js';
import { handoffSections } from './presentation.js';

it('accepts a summary written with one heading per section the handoff contract lists', () => {
  const summary = handoffContract
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => `${line.slice(2, line.indexOf(':'))}:\n- None`)
    .join('\n\n');

  expect(handoffSections({ summary })?.missing).toEqual([]);
});
