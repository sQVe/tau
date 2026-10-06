import { describe, expect, it } from 'vitest';

import { unknownPaths } from './fileRequests.js';

describe('unknownPaths', () => {
  it.each([
    { exists: false, indexed: false, staged: false, expected: ['source.ts'] },
    { exists: false, indexed: false, staged: true, expected: [] },
    { exists: false, indexed: true, staged: false, expected: [] },
    { exists: false, indexed: true, staged: true, expected: [] },
    { exists: true, indexed: false, staged: false, expected: [] },
    { exists: true, indexed: false, staged: true, expected: [] },
    { exists: true, indexed: true, staged: false, expected: [] },
    { exists: true, indexed: true, staged: true, expected: [] },
  ])('exists=$exists indexed=$indexed staged=$staged', ({ expected, ...facts }) => {
    expect(unknownPaths([{ file: 'source.ts', ...facts }])).toEqual(expected);
  });
});
