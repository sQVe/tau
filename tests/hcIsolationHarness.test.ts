import { expect, it } from 'vitest';

import config, { testEnvironment } from '../vite.config.js';
import { isolationProblems, protectedVariables } from './hcIsolationHarness.js';
import type { HcIsolationFacts, ProtectedVariable } from './hcIsolationHarness.js';

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

it('refuses an inherited HERDR_ variable', () => {
  expect(isolationProblems(facts({ variables: [...privateVariables, 'HERDR_PANE_ID'] }))).toEqual([
    'HERDR_PANE_ID must not be set',
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

it('accepts a private value when the real value is missing', () => {
  expect(
    isolationProblems(facts({ realValues: { ...realValues, XDG_DATA_HOME: undefined } })),
  ).toEqual([]);
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
