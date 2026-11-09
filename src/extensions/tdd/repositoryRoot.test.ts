import { expect, it } from 'vitest';

import { repositoryRootFrom } from './repositoryRoot.js';
import type { RepositoryRoot } from './repositoryRoot.js';

it.for<{
  name: string;
  git: { exitCode: number | null; stdout: string; stderr: string };
  expected: RepositoryRoot;
}>([
  {
    name: 'uses the checkout root that Git prints',
    git: { exitCode: 0, stdout: '/repo\n', stderr: '' },
    expected: { kind: 'root', path: '/repo' },
  },
  {
    name: 'keeps trailing spaces that belong to the checkout path',
    git: { exitCode: 0, stdout: '/repo \n', stderr: '' },
    expected: { kind: 'root', path: '/repo ' },
  },
  {
    name: 'uses the session directory when Git says it is not in a checkout',
    git: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    expected: { kind: 'root', path: '/repo/sub' },
  },
  {
    name: 'reports a Git call that timed out',
    git: {
      exitCode: null,
      stdout: '',
      stderr: 'git rev-parse --show-toplevel timed out after 5000 ms',
    },
    expected: {
      kind: 'error',
      message:
        'Tau could not find the Git checkout root of /repo/sub: git rev-parse --show-toplevel timed out after 5000 ms',
    },
  },
  {
    name: 'reports a Git call that did not finish',
    git: { exitCode: null, stdout: '', stderr: 'spawn git ENOENT' },
    expected: {
      kind: 'error',
      message: 'Tau could not find the Git checkout root of /repo/sub: spawn git ENOENT',
    },
  },
  {
    name: 'reports a successful Git call that printed no root',
    git: { exitCode: 0, stdout: '\n', stderr: '' },
    expected: {
      kind: 'error',
      message:
        'Tau could not find the Git checkout root of /repo/sub: git rev-parse --show-toplevel printed no path',
    },
  },
])('$name', ({ git, expected }) => {
  expect(repositoryRootFrom('/repo/sub', git)).toEqual(expected);
});
