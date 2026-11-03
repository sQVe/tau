import { afterEach, expect, it, vi } from 'vitest';

import { isWorkerProcess } from './worker.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([
  { role: 'worker', recordDirectory: undefined, expected: true },
  { role: undefined, recordDirectory: undefined, expected: false },
  { role: '', recordDirectory: undefined, expected: false },
  { role: 'Worker', recordDirectory: undefined, expected: false },
  { role: 'manager', recordDirectory: undefined, expected: false },
  { role: undefined, recordDirectory: '/records/task-one', expected: false },
])(
  'reads the worker role from TAU_ROLE only: role $role, record $recordDirectory',
  ({ role, recordDirectory, expected }) => {
    vi.stubEnv('TAU_ROLE', role);
    vi.stubEnv('TAU_WORKER_RECORD', recordDirectory);

    expect(isWorkerProcess()).toBe(expected);
  },
);
