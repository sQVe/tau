import { expect, it } from 'vitest';

import { sessionDirectoryFor } from './sessionDirectory.ts';

const table: { name: string; worktree: string; expected: string }[] = [
  {
    name: 'a plain worktree path',
    worktree: '/home/sqve/code/personal/tau/me-1471',
    expected: '/agent/sessions/--home-sqve-code-personal-tau-me-1471--',
  },
  {
    name: 'a worktree path with a colon',
    worktree: '/home/sqve/repo:one',
    expected: '/agent/sessions/--home-sqve-repo-one--',
  },
  {
    name: 'a worktree path with a backslash',
    worktree: '/home/sqve/repo\\one',
    expected: '/agent/sessions/--home-sqve-repo-one--',
  },
];

it.each(table.map((row) => [row.name, row] as const))(
  'computes the session folder for %s',
  (_name, { worktree, expected }) => {
    expect(sessionDirectoryFor(worktree, '/agent')).toBe(expected);
  },
);
