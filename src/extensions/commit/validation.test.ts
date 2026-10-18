import { Value } from 'typebox/value';
import { afterEach, expect, it } from 'vitest';

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

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
});

it.each([
  { platform: 'win32', file: 'dir\\file.txt', expected: 'dir/file.txt' },
  { platform: 'win32', file: 'dir\\sub\\', expected: 'dir/sub' },
  { platform: 'win32', file: 'dir//file.txt', expected: 'dir/file.txt' },
  { platform: 'linux', file: 'dir\\file.txt', expected: 'dir\\file.txt' },
  { platform: 'linux', file: 'dir//sub/', expected: 'dir/sub' },
  { platform: 'darwin', file: 'dir\\file.txt', expected: 'dir\\file.txt' },
])('normalizes $file on $platform', ({ platform, file, expected }) => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });

  expect(normalizeRepositoryPath(file)).toBe(expected);
});
