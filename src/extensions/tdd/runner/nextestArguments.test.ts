import { expect, it } from 'vitest';

import { listArguments, runArguments, toolConfig } from './nextestArguments.js';

const scope = ['--workspace', '--lib', '--bins', '--tests'];

it('builds focused run arguments with an exact name filter', () => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    testNames: ['a::b', 'c d'],
  });

  expect(argumentsList).toEqual([
    'nextest',
    'run',
    ...scope,
    '--tool-config-file',
    'tau:/diagnostics/tool-config.toml',
    '--profile',
    'tau-1',
    '--no-fail-fast',
    '--ignore-default-filter',
    '-E',
    'test(=a::b) | test(=c d)',
  ]);
});

it.for([
  { name: 'odd(1)', filter: 'test(=odd(1\\))' },
  { name: 'com,ma', filter: 'test(=com\\,ma)' },
  { name: 'back\\slash', filter: 'test(=back\\\\slash)' },
])('escapes $name in the name filter', ({ name, filter }) => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    testNames: [name],
  });

  expect(argumentsList.at(-1)).toBe(filter);
});

it('runs every test without a filter in a full run', () => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
  });

  expect(argumentsList).not.toContain('-E');
  expect(argumentsList).toContain('--ignore-default-filter');
});

it('lists the same build targets as a run, as JSON', () => {
  expect(listArguments()).toEqual(['nextest', 'list', ...scope, '--message-format', 'json']);
});

it('writes a profile that keeps running after failures and saves a JUnit report', () => {
  expect(toolConfig('tau-1', '/diagnostics/a "b".xml')).toBe(
    [
      '[profile.tau-1]',
      'fail-fast = false',
      '',
      '[profile.tau-1.junit]',
      'path = "/diagnostics/a \\"b\\".xml"',
      '',
    ].join('\n'),
  );
});
