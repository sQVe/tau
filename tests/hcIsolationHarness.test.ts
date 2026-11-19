import { mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import config, { testEnvironment } from '../vite.config.js';
import { isolatedRootParent, isolationProblems, protectedVariables } from './hcIsolationHarness.js';
import type { HcIsolationFacts, ProtectedVariable } from './hcIsolationHarness.js';
import { temporaryDirectory as createTemporaryDirectory } from './temporaryDirectoryHarness.js';

const realValues: Record<ProtectedVariable, string> = {
  HOME: '/real/home',
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_STATE_HOME: '/real/state',
  XDG_CONFIG_HOME: '/real/config',
  XDG_DATA_HOME: '/real/data',
  XDG_CACHE_HOME: '/real/cache',
};

const privateValues: Record<ProtectedVariable, string> = {
  HOME: '/tmp/tau-test-abc/home',
  XDG_RUNTIME_DIR: '/tmp/tau-test-abc/run',
  XDG_STATE_HOME: '/tmp/tau-test-abc/state',
  XDG_CONFIG_HOME: '/tmp/tau-test-abc/config',
  XDG_DATA_HOME: '/tmp/tau-test-abc/data',
  XDG_CACHE_HOME: '/tmp/tau-test-abc/cache',
};

const privateVariables = ['HC_SESSION', ...protectedVariables];

const facts = (
  overrides: Partial<HcIsolationFacts> = {},
  values: Partial<Record<ProtectedVariable, string | undefined>> = {},
): HcIsolationFacts => ({
  session: 'tau-test-abc',
  inheritedSession: undefined,
  values: { ...privateValues, ...values },
  realValues,
  variables: privateVariables,
  ...overrides,
});

it('accepts a fully private environment', () => {
  expect(isolationProblems(facts())).toEqual([]);
});

it('refuses an empty session', () => {
  expect(isolationProblems(facts({ session: '' }))).toEqual(['HC_SESSION is missing']);
});

it('refuses an undefined session', () => {
  expect(isolationProblems(facts({ session: undefined }))).toEqual(['HC_SESSION is missing']);
});

it('refuses a session equal to the inherited HC_SESSION', () => {
  expect(isolationProblems(facts({ inheritedSession: 'tau-test-abc' }))).toEqual([
    'HC_SESSION equals the inherited HC_SESSION',
  ]);
});

it('refuses the default session', () => {
  expect(isolationProblems(facts({ session: 'default' }))).toEqual([
    'HC_SESSION is the default session',
  ]);
});

it('refuses a padded default session', () => {
  expect(isolationProblems(facts({ session: '  default  ' }))).toEqual([
    'HC_SESSION is the default session',
  ]);
});

it('refuses a whitespace-only session', () => {
  expect(isolationProblems(facts({ session: '   ' }))).toEqual(['HC_SESSION is missing']);
});

it('refuses an inherited HC_SOCKET', () => {
  expect(isolationProblems(facts({ variables: [...privateVariables, 'HC_SOCKET'] }))).toEqual([
    'HC_SOCKET must not be set',
  ]);
});

it('refuses an inherited HC_ variable other than HC_SESSION', () => {
  expect(isolationProblems(facts({ variables: [...privateVariables, 'HC_TERMINAL_ID'] }))).toEqual([
    'HC_TERMINAL_ID must not be set',
  ]);
});

it.each(protectedVariables)('refuses %s equal to the real value', (name) => {
  expect(isolationProblems(facts({}, { [name]: realValues[name] }))).toEqual([
    `${name} equals the real ${name}`,
  ]);
});

it.each(protectedVariables)('refuses %s inside the real value', (name) => {
  expect(isolationProblems(facts({}, { [name]: `${realValues[name]}/child` }))).toEqual([
    `${name} is inside the real ${name}`,
  ]);
});

it.each(protectedVariables)('refuses a missing or empty %s', (name) => {
  for (const value of [undefined, '']) {
    expect(isolationProblems(facts({}, { [name]: value }))).toEqual([`${name} is missing`]);
  }
});

it('refuses a path inside the real home only after symlinks resolve', () => {
  expect(isolationProblems(facts({}, { HOME: '/real/home/tau-hc-abc/home' }))).toEqual([
    'HOME is inside the real HOME',
  ]);
});

it('refuses a dot-segment alias of the real XDG runtime dir', () => {
  expect(isolationProblems(facts({}, { XDG_RUNTIME_DIR: '/run/user/other/../1000' }))).toEqual([
    'XDG_RUNTIME_DIR equals the real XDG_RUNTIME_DIR',
  ]);
});

it('refuses a canonical alias outside the lexical prefix', () => {
  expect(
    isolationProblems(facts({}, { XDG_RUNTIME_DIR: '/run/user/1000/../other/../1000' })),
  ).toEqual(['XDG_RUNTIME_DIR equals the real XDG_RUNTIME_DIR']);
});

it('refuses the default state home when the real XDG state home is unset', () => {
  expect(
    isolationProblems(
      facts(
        { realValues: { ...realValues, XDG_STATE_HOME: undefined } },
        { XDG_STATE_HOME: '/real/home/.local/state' },
      ),
    ),
  ).toEqual(['XDG_STATE_HOME equals the real XDG_STATE_HOME']);
});

it('accepts a private value when the real value is missing', () => {
  expect(
    isolationProblems(facts({ realValues: { ...realValues, XDG_DATA_HOME: undefined } })),
  ).toEqual([]);
});

it.each([
  { temporaryDirectory: '/tmp/x', realHome: '/real/home', expected: '/tmp/x' },
  { temporaryDirectory: '/real/home', realHome: '/real/home', expected: '/tmp' },
  {
    temporaryDirectory: '/real/home/.pi/agent/tmp/tau-worker-scratch/abc',
    realHome: '/real/home',
    expected: '/tmp',
  },
  { temporaryDirectory: '/other/../real/home/scratch', realHome: '/real/home', expected: '/tmp' },
  { temporaryDirectory: '/real/homework', realHome: '/real/home', expected: '/real/homework' },
  { temporaryDirectory: '/real/home/x', realHome: undefined, expected: '/real/home/x' },
  { temporaryDirectory: '/real/home/x', realHome: '', expected: '/real/home/x' },
])(
  'gives $expected as the isolated root parent for $temporaryDirectory with real home $realHome',
  ({ temporaryDirectory, realHome, expected }) => {
    expect(isolatedRootParent(temporaryDirectory, realHome)).toBe(expected);
  },
);

it('runs tests with a temporary directory outside the real home', () => {
  const env = (config as { test?: { env?: Record<string, string> } }).test?.env ?? {};
  const temporaryDirectory = env['TMPDIR'] ?? '';

  expect(temporaryDirectory).not.toBe('');
  expect(isolatedRootParent(temporaryDirectory, homedir())).toBe(temporaryDirectory);
  expect(env['TMP']).toBe(temporaryDirectory);
  expect(env['TEMP']).toBe(temporaryDirectory);
  expect(env['TAU_TEST_WRITE_ROOT']).toBe(temporaryDirectory);
});

it('resolves a symlinked HOME before choosing the test temporary directory', async () => {
  const outer = createTemporaryDirectory(onTestFinished, 'tau-config-home-');
  const realHome = join(outer, 'home');
  const alias = join(outer, 'alias');
  const workerDirectory = join(realHome, 'worker');

  mkdirSync(workerDirectory, { recursive: true });
  symlinkSync(realHome, alias, 'dir');
  vi.stubEnv('HOME', alias);
  vi.stubEnv('TMPDIR', workerDirectory);

  try {
    vi.resetModules();

    const reloaded = await import('../vite.config.js');
    const env = (reloaded.default as { test?: { env?: Record<string, string> } }).test?.env ?? {};

    expect(env['TMPDIR']).toBe('/tmp');
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

it('clears the inherited hc session and terminal id before every test worker starts', () => {
  const env = (config as { test?: { env?: Record<string, string> } }).test?.env ?? {};

  expect(env['HC_SESSION']).toBe('');
  expect(env['HC_TERMINAL_ID']).toBe('');

  expect(process.env.HC_SESSION ?? '').toBe('');
  expect(process.env.HC_TERMINAL_ID ?? '').toBe('');

  expect(testEnvironment).not.toContain('HC_SESSION');
  expect(testEnvironment).not.toContain('HC_TERMINAL_ID');
});
