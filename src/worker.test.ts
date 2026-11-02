import { afterEach, expect, it, vi } from 'vitest';

import { isWorkerProcess, parseWorkerNoticeEvent } from './worker.js';

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

it('reads a notice payload', () => {
  expect(parseWorkerNoticeEvent({ worker: 'scout', label: 'asks' })).toEqual({
    worker: 'scout',
    label: 'asks',
  });
});

it.each([undefined, null, 'text', [], {}, { worker: 'scout' }, { worker: 1, label: 'asks' }])(
  'ignores malformed data %j',
  (data) => {
    expect(parseWorkerNoticeEvent(data)).toBeUndefined();
  },
);
