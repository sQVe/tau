import { expect, it } from 'vitest';

import { hasErrorCode, isMissingFile } from './errors.js';

const withCode = (code: string) => Object.assign(new Error('failed'), { code });

it('matches an Error that has the exact code', () => {
  expect(hasErrorCode(withCode('ENOENT'), 'ENOENT')).toBe(true);
});

it.for<[string, unknown]>([
  ['an Error with another code', withCode('EACCES')],
  ['an Error without a code', new Error('failed')],
  ['a plain object with the code', { code: 'ENOENT' }],
  ['a string', 'ENOENT'],
  ['null', null],
])('does not match %s', ([, error]) => {
  expect(hasErrorCode(error, 'ENOENT')).toBe(false);
});

it('reads a missing file from the ENOENT code only', () => {
  expect(isMissingFile(withCode('ENOENT'))).toBe(true);
  expect(isMissingFile(withCode('EISDIR'))).toBe(false);
});
