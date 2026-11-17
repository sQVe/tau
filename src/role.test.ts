import { afterEach, expect, it, vi } from 'vitest';

import { currentRole, isWorkerProcess, roleKind } from './role.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([
  { role: 'worker', expected: 'worker' },
  { role: 'lead', expected: 'lead' },
  { role: 'architect', expected: 'architect' },
  { role: undefined, expected: 'lead' },
  { role: '', expected: 'lead' },
  { role: 'Worker', expected: 'lead' },
  { role: 'manager', expected: 'lead' },
])('an unset role is a lead: $role reads as $expected', ({ role, expected }) => {
  vi.stubEnv('TAU_ROLE', role);

  expect(roleKind({ TAU_ROLE: role })).toBe(expected);
  expect(currentRole()).toBe(expected);
});

it.each([
  { role: 'worker', recordDirectory: undefined, expected: true },
  { role: 'worker', recordDirectory: '', expected: true },
  { role: undefined, recordDirectory: undefined, expected: false },
  { role: undefined, recordDirectory: '', expected: false },
  { role: '', recordDirectory: '', expected: false },
  { role: 'lead', recordDirectory: '/records/task-one', expected: false },
  { role: 'architect', recordDirectory: undefined, expected: false },
])(
  'reads the worker role from TAU_ROLE only: role $role, record $recordDirectory',
  ({ role, recordDirectory, expected }) => {
    vi.stubEnv('TAU_ROLE', role);
    vi.stubEnv('TAU_WORKER_RECORD', recordDirectory);

    expect(isWorkerProcess()).toBe(expected);
  },
);
