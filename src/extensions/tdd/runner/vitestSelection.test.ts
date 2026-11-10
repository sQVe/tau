import { expect, it } from 'vitest';

import { selectExactFiles } from './vitestSelection.js';

it.for([
  {
    name: 'exact identity',
    discovered: ['/repo/value.test.ts', '/repo/other-value.test.ts'],
    allowed: ['/repo/value.test.ts'],
    expected: ['/repo/value.test.ts'],
  },
  {
    name: 'configured discovery',
    discovered: ['/repo/other.test.ts'],
    allowed: ['/repo/value.test.ts'],
    expected: [],
  },
  {
    name: 'distinct directories',
    discovered: ['/repo/one/value.test.ts', '/repo/two/value.test.ts'],
    allowed: ['/repo/two/value.test.ts'],
    expected: ['/repo/two/value.test.ts'],
  },
  {
    name: 'literal glob characters',
    discovered: ['/repo/value[1].test.ts', '/repo/value1.test.ts'],
    allowed: ['/repo/value[1].test.ts'],
    expected: ['/repo/value[1].test.ts'],
  },
])('selects discovered files by $name', ({ discovered, allowed, expected }) => {
  expect(selectExactFiles(discovered, new Set(allowed))).toEqual(expected);
});
