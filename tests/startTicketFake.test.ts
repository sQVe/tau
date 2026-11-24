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
