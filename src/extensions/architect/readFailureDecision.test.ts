import { expect, it } from 'vitest';

import { readFailureDecision } from './readFailureDecision.js';

const nodeFileError = (): Error =>
  Object.assign(new Error("EACCES: permission denied, open '/tmp/ask.json'"), {
    code: 'EACCES',
    errno: -13,
    syscall: 'open',
  });

const cases = [
  {
    name: 'a matching proof with a Node filesystem error is a filesystem read failure',
    hasRefusalProof: true,
    error: nodeFileError(),
    expected: 'filesystem',
  },
  {
    name: 'no proof with the same Node filesystem error is another read failure',
    hasRefusalProof: false,
    error: nodeFileError(),
    expected: 'other',
  },
  {
    name: 'a matching proof with an ordinary Error is another read failure',
    hasRefusalProof: true,
    error: new Error('record read failed'),
    expected: 'other',
  },
  {
    name: 'a matching proof with a non-Error lookalike is another read failure',
    hasRefusalProof: true,
    error: { code: 'EACCES', errno: -13, syscall: 'open' },
    expected: 'other',
  },
  {
    name: 'a matching proof with a missing syscall is another read failure',
    hasRefusalProof: true,
    error: Object.assign(new Error('record read failed'), { code: 'EACCES', errno: -13 }),
    expected: 'other',
  },
  {
    name: 'a matching proof with a string errno is another read failure',
    hasRefusalProof: true,
    error: Object.assign(new Error('record read failed'), {
      code: 'EACCES',
      errno: '-13',
      syscall: 'open',
    }),
    expected: 'other',
  },
  {
    name: 'a matching proof with a numeric code is another read failure',
    hasRefusalProof: true,
    error: Object.assign(new Error('record read failed'), {
      code: 13,
      errno: -13,
      syscall: 'open',
    }),
    expected: 'other',
  },
  {
    name: 'a matching proof with a numeric syscall is another read failure',
    hasRefusalProof: true,
    error: Object.assign(new Error('record read failed'), {
      code: 'EACCES',
      errno: -13,
      syscall: 13,
    }),
    expected: 'other',
  },
] as const;

it.each(cases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(readFailureDecision(row)).toBe(row.expected);
});
