import { expect, it } from 'vitest';

import { handoverContract } from './handover.js';
import { handoverSections } from './presentation.js';

it('accepts a summary written with one heading per section the handover contract lists', () => {
  const summary = handoverContract
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => `${line.slice(2, line.indexOf(':'))}:\n- None`)
    .join('\n\n');

  expect(handoverSections({ summary })?.missing).toEqual([]);
});
