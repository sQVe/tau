import { expect, it } from 'vitest';

import {
  errorMessage,
  failureWithRelease,
  hasErrorCode,
  isMissingFile,
  toError,
} from './errors.js';

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

it.for<[string, unknown, string]>([
  ['an Error', new Error('failed'), 'failed'],
  ['an object with a message', { message: 'x' }, 'x'],
  ['an object without a message', { code: 1 }, '{"code":1}'],
  ['a string', 'plain', 'plain'],
  ['null', null, 'null'],
  ['an object JSON cannot print', { size: 1n }, '[object Object]'],
])('describes %s', ([, error, expected]) => {
  expect(errorMessage(error)).toBe(expected);
});

it('keeps an Error as it is', () => {
  const error = new Error('failed');

  expect(toError(error)).toBe(error);
});

it('wraps a thrown value that is not an Error', () => {
  expect(toError('plain')).toStrictEqual(new Error('plain'));
});

it('returns the first failure when the release succeeds', async () => {
  const failure = new Error('The claim failed.');

  const reported = await failureWithRelease(failure, () => Promise.resolve(), {
    failure: 'The claim failed',
    release: 'releasing it failed',
  });

  expect(reported).toBe(failure);
});

it('returns the first failure and a synchronous release failure together', async () => {
  const failure = new Error('The claim failed.');

  const reported = await failureWithRelease(
    failure,
    () => {
      throw new Error('The release failed.');
    },
    { failure: 'The claim failed', release: 'releasing it failed' },
  );

  expect((reported as Error).message).toBe(
    'The claim failed: The claim failed.; releasing it failed: The release failed.',
  );

  expect((reported as Error).cause).toBe(failure);
});
