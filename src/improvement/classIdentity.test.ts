import { expect, it } from 'vitest';

import { classEventId } from './classIdentity.ts';

it('gives one class ID for the same identity and occurrences in any order', () => {
  expect(classEventId('lint-await', ['b', 'a'])).toBe(classEventId('lint-await', ['a', 'b']));
});

it('gives one class ID for a repeated occurrence', () => {
  expect(classEventId('lint-await', ['a', 'a'])).toBe(classEventId('lint-await', ['a']));
});

it('gives a new class ID when an occurrence is added', () => {
  expect(classEventId('lint-await', ['a', 'b'])).not.toBe(classEventId('lint-await', ['a']));
});
