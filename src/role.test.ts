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
  { role: 'worker', expected: true },
  { role: undefined, expected: false },
  { role: 'lead', expected: false },
  { role: 'architect', expected: false },
])('reads the worker role from TAU_ROLE only: role $role', ({ role, expected }) => {
  vi.stubEnv('TAU_ROLE', role);
  vi.stubEnv('TAU_WORKER_RECORD', '/records/task-one');

  expect(isWorkerProcess()).toBe(expected);
});
