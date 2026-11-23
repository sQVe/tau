import { expect, it } from 'vitest';

import { assignmentPrefixFromName, assignmentShortId, workerName } from './workerName.js';

const prefixRows: { name: string | null | undefined; expected: string | undefined }[] = [
  { name: 'scout-027f77a4', expected: '027f77a4' },
  { name: 'a-b-0123abcd', expected: '0123abcd' },
  { name: 'shell', expected: undefined },
  { name: null, expected: undefined },
  { name: undefined, expected: undefined },
  { name: 'x-0123ABCD', expected: undefined },
  { name: 'x-0123abcde', expected: undefined },
  { name: 'x-0123abc', expected: undefined },
  { name: 'x0123abcd', expected: undefined },
  { name: 'x-0123abcd-y', expected: undefined },
  { name: 'x-0123abcg', expected: undefined },
];

it.each(prefixRows)('reads the assignment prefix of $name', ({ name, expected }) => {
  expect(assignmentPrefixFromName(name)).toBe(expected);
});

it('drops every dash of the assignment id before it takes the prefix', () => {
  expect(workerName('scout', 'ab-cd-ef0123456')).toBe('scout-abcdef01');
});

it('shortens an assignment id to its first eight dash-free characters', () => {
  expect(assignmentShortId('3f9a2c1d-0000-4000-8000-000000000000')).toBe('3f9a2c1d');
});

it('gives each name a prefix that matches its assignment', () => {
  const assignmentId = '027f77a4-1111-2222-3333-444455556666';
  const name = workerName('scout', assignmentId);

  expect(name).toBe('scout-027f77a4');
  const expectedPrefix = assignmentId.replaceAll('-', '').slice(0, 8);

  expect(assignmentPrefixFromName(name)).toBe(expectedPrefix);
});
