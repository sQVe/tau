import { expect, it } from 'vitest';

import type { CargoMetadata } from './cargoMetadata.js';
import { listArguments, runArguments, targetArguments, toolConfig } from './nextestArguments.js';

const scope = ['--workspace', '--lib', '--bins', '--tests'];

const metadata = (kinds: string[][]): CargoMetadata => ({
  workspaceRoot: '/repo',
  targets: kinds.map((kind, index) => ({
    packageId: `package-${index}`,
    name: `target-${index}`,
    kinds: kind,
    srcPath: `/repo/src/target-${index}.rs`,
  })),
});

it.for([
  { name: 'a bin-only workspace', kinds: [['bin']], targets: ['--workspace', '--bins', '--tests'] },
  { name: 'a library workspace', kinds: [['lib']], targets: scope },
  { name: 'a proc-macro workspace', kinds: [['proc-macro']], targets: scope },
  { name: 'a mixed workspace', kinds: [['bin'], ['lib']], targets: scope },
])('selects $name targets', ({ kinds, targets }) => {
  expect(targetArguments(metadata(kinds))).toEqual(targets);
});

it('builds focused run arguments with an exact name filter', () => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    targets: scope,
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

it('keeps the run target flags identical to the list flags', () => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    targets: ['--workspace', '--bins', '--tests'],
    testNames: ['tests::adds'],
  });

  expect(argumentsList).toContain('--bins');
  expect(argumentsList).not.toContain('--lib');
});

it.for([
  { name: 'odd(1)', filter: 'test(=odd(1\\))' },
  { name: 'com,ma', filter: 'test(=com\\,ma)' },
  { name: 'back\\slash', filter: 'test(=back\\\\slash)' },
])('escapes $name in the name filter', ({ name, filter }) => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    targets: scope,
    testNames: [name],
  });

  expect(argumentsList.at(-1)).toBe(filter);
});

it('scopes a focused run to the binaries that contain the requested files', () => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    targets: scope,
    testNames: ['sub::tests::fails'],
    binaryIds: ['demo', 'demo::bin/demo'],
  });

  expect(argumentsList.at(-1)).toBe(
    '(binary_id(demo) | binary_id(demo::bin/demo)) & test(=sub::tests::fails)',
  );
});

it('wraps several test names when scoping to binaries', () => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    targets: scope,
    testNames: ['a::b', 'c::d'],
    binaryIds: ['demo'],
  });

  expect(argumentsList.at(-1)).toBe('binary_id(demo) & (test(=a::b) | test(=c::d))');
});

it('runs every test without a filter in a full run', () => {
  const argumentsList = runArguments({
    profileName: 'tau-1',
    toolConfigPath: '/diagnostics/tool-config.toml',
    targets: scope,
  });

  expect(argumentsList).not.toContain('-E');
  expect(argumentsList).toContain('--ignore-default-filter');
});

it('lists the same build targets as a run, as JSON', () => {
  expect(listArguments(scope)).toEqual(['nextest', 'list', ...scope, '--message-format', 'json']);
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
