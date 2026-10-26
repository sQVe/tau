import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import { commitToolParameters, normalizeRepositoryPath } from './validation.js';

const accepted = [
  { name: 'a subject group', input: { groups: [{ files: ['a.txt'], subject: 'feat: a' }] } },
  { name: 'a body', input: { groups: [{ files: ['a.txt'], subject: 'feat: a', body: 'text' }] } },
  ...(['fixup', 'squash', 'amend'] as const).map((kind) => ({
    name: `a ${kind} fixup`,
    input: { groups: [{ files: ['a.txt'], fixup: { target: 'HEAD', kind } }] },
  })),
];

const rejected = [
  { name: 'no groups', input: { groups: [] } },
  { name: 'a missing groups list', input: {} },
  { name: 'a group without files', input: { groups: [{ files: [], subject: 'feat: a' }] } },
  { name: 'a non-string file', input: { groups: [{ files: [1], subject: 'feat: a' }] } },
  {
    name: 'an unknown fixup kind',
    input: { groups: [{ files: ['a.txt'], fixup: { target: 'HEAD', kind: 'reword' } }] },
  },
  {
    name: 'a fixup without a target',
    input: { groups: [{ files: ['a.txt'], fixup: { kind: 'fixup' } }] },
  },
];

it.each(accepted)('accepts $name', ({ input }) => {
  expect(Value.Check(commitToolParameters, input)).toBe(true);
});

it.each(rejected)('rejects $name', ({ input }) => {
  expect(Value.Check(commitToolParameters, input)).toBe(false);
});

it.each([
  { file: 'dir\\file.txt', expected: 'dir\\file.txt' },
  { file: 'dir//sub/', expected: 'dir/sub' },
])('normalizes $file', ({ file, expected }) => {
  expect(normalizeRepositoryPath(file)).toBe(expected);
});
