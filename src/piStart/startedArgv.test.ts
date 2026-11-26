import { expect, it } from 'vitest';

import { piArgv } from './startedArgv.js';

const modelArguments = ['--provider', 'morph', '--model', 'morph-dsv41flash-1017'];

it.each<{ name: string; argv: readonly string[] | undefined; expected: unknown }>([
  {
    name: 'a bare pi command',
    argv: ['pi', ...modelArguments],
    expected: ['pi', ...modelArguments],
  },
  {
    name: 'a pi path',
    argv: ['/usr/bin/pi', ...modelArguments],
    expected: ['/usr/bin/pi', ...modelArguments],
  },
  {
    name: 'a node pi path',
    argv: ['node', '/usr/local/bin/pi', ...modelArguments],
    expected: ['node', '/usr/local/bin/pi', ...modelArguments],
  },
  {
    name: 'a bare pi script after the runtime',
    argv: ['node', 'pi', ...modelArguments],
    expected: ['node', 'pi', ...modelArguments],
  },
  {
    name: 'a node pi path after a value-taking flag',
    argv: ['node', '--loader', 'tsx', '/path/pi', ...modelArguments],
    expected: ['node', '--loader', 'tsx', '/path/pi', ...modelArguments],
  },
  {
    name: 'a bun.exe pi.cmd path',
    argv: ['bun.exe', '/path/pi.cmd', ...modelArguments],
    expected: ['bun.exe', '/path/pi.cmd', ...modelArguments],
  },
  {
    name: 'no argv',
    argv: undefined,
    expected: undefined,
  },
  {
    name: 'a non-Pi command',
    argv: ['bash', ...modelArguments],
    expected: undefined,
  },
  {
    name: 'a node command with a trailing pi argument',
    argv: ['node', '/path/tool.js', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node eval command with a path-shaped pi after the code',
    argv: ['node', '-e', 'code', '/path/pi'],
    expected: undefined,
  },
  {
    name: 'a bare pi argument after an unknown value-taking flag',
    argv: ['node', '--stack-size', '2000', 'pi'],
    expected: undefined,
  },
])('recognizes $name', ({ argv, expected }) => {
  expect(piArgv(argv)).toEqual(expected);
});
