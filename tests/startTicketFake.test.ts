import { expect, it, onTestFinished } from 'vitest';

import { processState } from '../src/process/process.js';
import {
  fakeRunningStartProcessId,
  fakeStartProcessId,
  useFakeStartProcess,
} from './startTicketFake.js';

it('keeps the state of each fake process apart and passes other processes through', () => {
  useFakeStartProcess(onTestFinished, 'running', false, fakeStartProcessId);
  useFakeStartProcess(onTestFinished, 'gone', false, fakeRunningStartProcessId);

  expect(processState(fakeStartProcessId)).toBe('running');
  expect(processState(fakeRunningStartProcessId)).toBe('gone');
  expect(processState(process.pid)).toBe('running');
});

it('fails a missing signal with its own message before the runner timeout', async () => {
  const control = useFakeStartProcess(onTestFinished, 'running');

  await expect(control.nextSignal(1)).rejects.toThrow(
    'The fake start process received 0 signals, but the test waited for 1.',
  );
}, 3_000);
