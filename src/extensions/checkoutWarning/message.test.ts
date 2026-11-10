import { expect, it } from 'vitest';

import { checkoutWarningMessage } from './message.js';

it.each([
  {
    name: 'two behind',
    exitCode: 0,
    stdout: '2\n',
    checkout: '/tau',
    count: '2 commits',
    path: '/tau',
  },
  {
    name: 'one behind',
    exitCode: 0,
    stdout: '1\n',
    checkout: '/tau',
    count: '1 commit behind',
    path: '/tau',
  },
  { name: 'equal', exitCode: 0, stdout: '0', checkout: '/tau' },
  { name: 'failed read', exitCode: 1, stdout: '2', checkout: '/tau' },
  { name: 'unfinished read', exitCode: null, stdout: '2', checkout: '/tau' },
  { name: 'non-numeric output', exitCode: 0, stdout: 'invalid', checkout: '/tau' },
  {
    name: 'space in path',
    exitCode: 0,
    stdout: '2',
    checkout: '/my tau',
    count: '2 commits',
    path: "'/my tau'",
  },
  {
    name: 'quote in path',
    exitCode: 0,
    stdout: '2',
    checkout: "/my'tau",
    count: '2 commits',
    path: String.raw`'/my'\''tau'`,
  },
])('checkout warning message: $name', ({ exitCode, stdout, checkout, count, path }) => {
  const message = checkoutWarningMessage({ exitCode, stdout, checkout });

  const command = `git -C ${path} pull --ff-only && pnpm -C ${path} install`;
  const expected = count === undefined ? undefined : true;
  const includesCount = message?.includes(count ?? '');
  const includesCommand = message?.includes(command);

  expect(includesCount).toBe(expected);
  expect(includesCommand).toBe(expected);
});
