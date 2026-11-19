import { expect, it } from 'vitest';

import { assignmentPrefixFromName, workerName } from './workerName.js';

const prefixRows: { name: string | null | undefined; expected: string | undefined }[] = [
  { name: 'scout-027f77a4', expected: '027f77a4' },
  { name: 'a-b-0123abcd', expected: '0123abcd' },
  { name: 'shell', expected: undefined },
  { name: null, expected: undefined },
  { name: undefined, expected: undefined },
  { name: 'x-0123ABCD', expected: undefined },
  { name: 'x-0123abcde', expected: undefined },
];

it.each(prefixRows)('reads the assignment prefix of $name', ({ name, expected }) => {
  expect(assignmentPrefixFromName(name)).toBe(expected);
});

it('gives each name a prefix that matches its assignment', () => {
  const assignmentId = '027f77a4-1111-2222-3333-444455556666';
  const name = workerName('scout', assignmentId);

  expect(name).toBe('scout-027f77a4');
  const expectedPrefix = assignmentId.replaceAll('-', '').slice(0, 8);

  expect(assignmentPrefixFromName(name)).toBe(expectedPrefix);
});
