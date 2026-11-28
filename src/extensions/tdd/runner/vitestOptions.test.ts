import { expect, it } from 'vitest';

import { normalizeVitestOptions, passesReporters, verificationArgvError } from './vitestOptions.js';

it.for([
  { name: 'an inline reporter flag', runnerArguments: ['run', '--reporter=json'], expected: true },
  {
    name: 'a spaced reporter flag',
    runnerArguments: ['run', '--reporter', 'json'],
    expected: true,
  },
  { name: 'no reporter flag', runnerArguments: ['run', '--no-color'], expected: false },
  { name: 'a reporter-like option', runnerArguments: ['run', '--reporters=json'], expected: false },
])('decides that $name passes reporters: $expected', ({ runnerArguments, expected }) => {
  expect(passesReporters(runnerArguments)).toBe(expected);
});

it.for([
  {
    name: 'CLI exclusions',
    filters: [],
    options: { exclude: ['one/**', 'two/**'] },
    expected: { cliExclude: ['one/**', 'two/**'] },
  },
  {
    name: 'ordinary options',
    filters: ['value.test.ts'],
    options: { globals: true },
    expected: { globals: true },
  },
  {
    name: 'location filters',
    filters: ['value.test.ts:4'],
    options: {},
    expected: { includeTaskLocation: true },
  },
  {
    name: 'explicit location setting',
    filters: ['value.test.ts:4'],
    options: { includeTaskLocation: false },
    expected: { includeTaskLocation: false },
  },
  {
    name: 'typecheck only',
    filters: [],
    options: { typecheck: { only: true } },
    expected: { typecheck: { only: true, enabled: true } },
  },
  {
    name: 'explicit typecheck setting',
    filters: [],
    options: { typecheck: { only: true, enabled: false } },
    expected: { typecheck: { only: true, enabled: false } },
  },
  {
    name: 'clear cache',
    filters: [],
    options: { clearCache: true, watch: true },
    expected: { clearCache: true, watch: false, run: true },
  },
  {
    name: 'list tags',
    filters: [],
    options: { listTags: true, watch: true },
    expected: { listTags: true, watch: false, run: true },
  },
])('normalizes $name before starting Vitest', ({ filters, options, expected }) => {
  expect(normalizeVitestOptions(filters, options)).toEqual(expected);
});

it.for([
  {
    name: 'the vitest default',
    argv: ['vitest', 'run', '--reporter=json', '--reporter=default', '--no-color'],
    accepted: true,
  },
  { name: 'related as the first token', argv: ['vitest', 'related', '--no-color'], accepted: true },
  { name: 'options without a command', argv: ['vitest', '--no-color'], accepted: true },
  { name: 'no arguments', argv: ['vitest'], accepted: true },
  {
    name: 'a second command word',
    argv: ['vitest', 'run', 'related', '--reporter=json'],
    accepted: false,
  },
  { name: 'a positional in the command slot', argv: ['vitest', 'other.test.ts'], accepted: false },
  { name: 'a positional argument', argv: ['vitest', 'run', 'other.test.ts'], accepted: false },
  { name: 'a bare --', argv: ['vitest', 'run', '--'], accepted: false },
  { name: 'a bare -t', argv: ['vitest', 'run', '-t'], accepted: false },
  {
    name: 'a bare --testNamePattern',
    argv: ['vitest', 'run', '--testNamePattern'],
    accepted: false,
  },
  { name: '-t with a value', argv: ['vitest', 'run', '-t', 'adds'], accepted: false },
  {
    name: 'a name filter after a flag',
    argv: ['vitest', 'run', '--no-color', '-t'],
    accepted: false,
  },
  {
    name: '--testNamePattern with a value',
    argv: ['vitest', 'run', '--testNamePattern', 'adds'],
    accepted: false,
  },
  {
    name: '--test-name-pattern with a value',
    argv: ['vitest', 'run', '--test-name-pattern', 'adds'],
    accepted: false,
  },
  { name: '-t=', argv: ['vitest', 'run', '-t=adds'], accepted: false },
  {
    name: '--testNamePattern=',
    argv: ['vitest', 'run', '--testNamePattern=adds'],
    accepted: false,
  },
  {
    name: '--test-name-pattern=',
    argv: ['vitest', 'run', '--test-name-pattern=adds'],
    accepted: false,
  },
  {
    name: '--no-testNamePattern',
    argv: ['vitest', 'run', '--no-testNamePattern'],
    accepted: false,
  },
  {
    name: '---no-testNamePattern',
    argv: ['vitest', 'run', '---no-testNamePattern'],
    accepted: false,
  },
  {
    name: '--no-test-name-pattern',
    argv: ['vitest', 'run', '--no-test-name-pattern'],
    accepted: false,
  },
  {
    name: '---no-test-name-pattern',
    argv: ['vitest', 'run', '---no-test-name-pattern'],
    accepted: false,
  },
  { name: '--no-t', argv: ['vitest', 'run', '--no-t'], accepted: false },
  { name: '---no-t', argv: ['vitest', 'run', '---no-t'], accepted: false },
  { name: '-no-t', argv: ['vitest', 'run', '-no-t'], accepted: false },
  {
    name: 'a negated filter after a flag',
    argv: ['vitest', 'run', '--no-color', '--no-testNamePattern'],
    accepted: false,
  },
  { name: 'a non-vitest command', argv: ['jest', 'run'], accepted: false },
])('classifies $name in verificationArgv as accepted: $accepted', ({ argv, accepted }) => {
  const error = verificationArgvError(argv);

  expect(error === null).toBe(accepted);
});
