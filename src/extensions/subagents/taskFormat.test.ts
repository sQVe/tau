import { expect, it } from 'vitest';

import { taskFormat } from './taskFormat.js';

it.each([
  { version: 1, format: 'retired' },
  { version: 6, format: 'retired' },
  { version: 7, format: 'current' },
  { version: 8, format: 'current' },
  { version: 9, format: 'current' },
  { version: 10, format: 'newer' },
  { version: undefined, format: 'invalid' },
  { version: '7', format: 'invalid' },
  { version: null, format: 'invalid' },
  { version: Number.NaN, format: 'invalid' },
  { version: 0, format: 'invalid' },
  { version: -1, format: 'invalid' },
  { version: 6.5, format: 'invalid' },
])('classifies task version $version as $format', ({ version, format }) => {
  expect(taskFormat(version, 9, 7)).toBe(format);
});
