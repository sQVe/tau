import { expect, it, vi } from 'vitest';

import {
  errorCode,
  errorMessage,
  failureWithRelease,
  hasErrorCode,
  isMissingFile,
  isMissingPath,
  toError,
} from './errors.js';

const withCode = (code: string) => Object.assign(new Error('failed'), { code });

it('reads a string code from an Error', () => {
  expect(errorCode(withCode('ENOENT'))).toBe('ENOENT');
});

it.for<[string, unknown]>([
  ['an Error without a code', new Error('failed')],
  ['an Error with a non-string code', Object.assign(new Error('failed'), { code: 1 })],
  ['a plain object with the code', { code: 'ENOENT' }],
  ['a string', 'ENOENT'],
  ['null', null],
])('reads no code from %s', ([, error]) => {
  expect(errorCode(error)).toBeUndefined();
});

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

it('reads a missing path from ENOENT and ENOTDIR only', () => {
  expect(isMissingPath(withCode('ENOENT'))).toBe(true);
  expect(isMissingPath(withCode('ENOTDIR'))).toBe(true);
  expect(isMissingPath(withCode('EISDIR'))).toBe(false);
  expect(isMissingPath('ENOENT')).toBe(false);
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
  const failure = new Error('The lock could not be written.');
  const release = vi.fn<() => Promise<void>>(() => Promise.resolve());

  const reported = await failureWithRelease(failure, release, {
    failure: 'The claim failed',
    release: 'releasing it failed',
  });

  expect(reported).toBe(failure);
  expect(release).toHaveBeenCalledTimes(1);
});

it.for<[string, () => Promise<void>]>([
  [
    'a synchronous throw',
    () => {
      throw new Error('The release failed.');
    },
  ],
  ['a rejected promise', () => Promise.reject(new Error('The release failed.'))],
])('returns the first failure and %s release failure together', async ([, release]) => {
  const failure = new Error('The lock could not be written.');

  const reported = await failureWithRelease(failure, release, {
    failure: 'The claim failed',
    release: 'releasing it failed',
  });

  const message = (reported as Error).message;

  expect(message).toContain('The claim failed: The lock could not be written.');
  expect(message).toContain('releasing it failed: The release failed.');
  expect((reported as Error).cause).toBe(failure);
});
