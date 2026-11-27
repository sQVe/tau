import { expect, it } from 'vitest';

import { piArgv } from './startedArgv.js';

const modelArguments = ['--provider', 'morph', '--model', 'morph-dsv41flash-1017'];

it.each<{
  name: string;
  argv: readonly string[] | undefined;
  expected: readonly string[] | undefined;
}>([
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
    name: 'a Windows pi.cmd path',
    argv: ['C:\\Users\\x\\pi.cmd', ...modelArguments],
    expected: ['C:\\Users\\x\\pi.cmd', ...modelArguments],
  },
  {
    name: 'a node Windows pi path',
    argv: ['node', 'C:\\tools\\pi', ...modelArguments],
    expected: ['node', 'C:\\tools\\pi', ...modelArguments],
  },
  {
    name: 'a Windows node.exe pi path',
    argv: ['C:\\tools\\node.exe', 'C:\\tools\\pi.cmd', ...modelArguments],
    expected: ['C:\\tools\\node.exe', 'C:\\tools\\pi.cmd', ...modelArguments],
  },
  {
    name: 'a Windows path whose executable name is upper case',
    argv: ['C:\\tools\\PI.CMD', ...modelArguments],
    expected: ['C:\\tools\\PI.CMD', ...modelArguments],
  },
  {
    name: 'a Windows node path whose executable names are upper case',
    argv: ['C:\\tools\\NODE.EXE', 'C:\\tools\\PI.CMD', ...modelArguments],
    expected: ['C:\\tools\\NODE.EXE', 'C:\\tools\\PI.CMD', ...modelArguments],
  },
  {
    name: 'a Windows script with an upper-case suffix after the runtime',
    argv: ['node', 'C:\\tools\\PI.EXE', ...modelArguments],
    expected: ['node', 'C:\\tools\\PI.EXE', ...modelArguments],
  },
  {
    name: 'a node pi path with a leading flag',
    argv: ['node', '--experimental-strip-types', '/path/pi', ...modelArguments],
    expected: ['node', '--experimental-strip-types', '/path/pi', ...modelArguments],
  },
  {
    name: 'a node pi path after a stack-size flag',
    argv: ['node', '--stack-size', '2000', '/path/pi', ...modelArguments],
    expected: ['node', '--stack-size', '2000', '/path/pi', ...modelArguments],
  },
  {
    name: 'a node pi.js script after a value-taking flag',
    argv: ['node', '--stack-size', '2000', 'pi.js', ...modelArguments],
    expected: ['node', '--stack-size', '2000', 'pi.js', ...modelArguments],
  },
  {
    name: 'a bare pi after an attached flag',
    argv: ['node', '--require=./setup.js', 'pi', ...modelArguments],
    expected: ['node', '--require=./setup.js', 'pi', ...modelArguments],
  },
  {
    name: 'a bare pi after a loader flag',
    argv: ['node', '--loader', 'tsx', 'pi', ...modelArguments],
    expected: ['node', '--loader', 'tsx', 'pi', ...modelArguments],
  },
  {
    name: 'a bare pi after a memory flag',
    argv: ['node', '--max-old-space-size', '4096', 'pi', ...modelArguments],
    expected: ['node', '--max-old-space-size', '4096', 'pi', ...modelArguments],
  },
  {
    name: 'a bun pi path',
    argv: ['bun', '/path/pi', ...modelArguments],
    expected: ['bun', '/path/pi', ...modelArguments],
  },
  {
    name: 'a bun.exe pi path',
    argv: ['bun.exe', '/path/pi', ...modelArguments],
    expected: ['bun.exe', '/path/pi', ...modelArguments],
  },
  {
    name: 'a node.exe pi.cmd path',
    argv: ['node.exe', '/usr/local/bin/pi.cmd', ...modelArguments],
    expected: ['node.exe', '/usr/local/bin/pi.cmd', ...modelArguments],
  },
  {
    name: 'no argv',
    argv: undefined,
    expected: undefined,
  },
  {
    name: 'an empty argv',
    argv: [],
    expected: undefined,
  },
  {
    name: 'a non-Pi command',
    argv: ['bash', ...modelArguments],
    expected: undefined,
  },
  {
    name: 'a path-shaped pi after the value of an unlisted flag',
    argv: ['node', '--experimental-config-file', 'config.json', '/path/pi'],
    expected: ['node', '--experimental-config-file', 'config.json', '/path/pi'],
  },
  {
    name: 'a pi executable suffix after a first candidate',
    argv: ['node', 'tool.js', 'pi.exe'],
    expected: ['node', 'tool.js', 'pi.exe'],
  },
  {
    name: 'a node command with a trailing pi argument',
    argv: ['node', '/path/tool.js', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node command with a flag value of pi',
    argv: ['node', '--title', 'pi', '/path/tool.js'],
    expected: undefined,
  },
  {
    name: 'a node command with a Pi-named flag value',
    argv: ['node', '--require', './pi.js', 'main.js'],
    expected: undefined,
  },
  {
    name: 'a node eval command with a trailing pi',
    argv: ['node', '-e', 'code', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node print command with a trailing pi',
    argv: ['node', '--print', 'code', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node long eval command with a trailing pi',
    argv: ['node', '--eval', 'code', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node short print command with a trailing pi',
    argv: ['node', '-p', 'code', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node long eval command with an inline code value and a trailing pi',
    argv: ['node', '--eval=code', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node long print command with an inline code value and a trailing pi',
    argv: ['node', '--print=code', 'pi'],
    expected: undefined,
  },
  {
    name: 'a node eval command with a path-shaped pi after the code',
    argv: ['node', '-e', 'code', '/path/pi'],
    expected: undefined,
  },
  {
    name: 'a bare pi after a stack-size flag',
    argv: ['node', '--stack-size', '2000', 'pi', ...modelArguments],
    expected: ['node', '--stack-size', '2000', 'pi', ...modelArguments],
  },
  {
    name: 'a node command with an attached short eval flag',
    argv: ['node', "-e'code'", 'pi'],
    expected: undefined,
  },
  {
    name: 'a node command with an attached short print flag',
    argv: ['node', '-pcodepi', 'pi'],
    expected: undefined,
  },
])('recognizes $name', ({ argv, expected }) => {
  expect(piArgv(argv)).toEqual(expected);
});
