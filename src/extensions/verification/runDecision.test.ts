import { expect, it } from 'vitest';

import type { RunRecord } from '../../verification/records.js';
import { decideRegister, decideStop } from './runDecision.js';
import type { RegisterDecision, StopDecision } from './runDecision.js';

type RunFacts = Pick<RunRecord, 'doctor' | 'stop' | 'items'>;
type RegisteredItem = RunRecord['items'][number];

const readyDoctor: RunRecord['doctor'] = { exitCode: 0, logPath: 'doctor.log' };

const run = (overrides: Partial<RunFacts>): RunFacts => ({
  doctor: readyDoctor,
  stop: null,
  items: [],
  ...overrides,
});

const item = (name: string): RegisteredItem => ({ item: name, steps: 1 });

const registerTable: {
  name: string;
  facts: RunFacts;
  request: RegisteredItem[];
  expected: RegisterDecision;
}[] = [
  {
    name: 'accepts new items on a ready run and keeps the earlier ones first',
    facts: run({ items: [item('login')] }),
    request: [item('search'), item('checkout')],
    expected: {
      kind: 'accept',
      items: [item('login'), item('search'), item('checkout')],
    },
  },
  {
    name: 'refuses a stopped run',
    facts: run({ stop: { exitCode: 0, logPath: 'stop.log' } }),
    request: [item('login')],
    expected: {
      kind: 'refuse',
      reason: 'The run is stopped. Launch a new run to register items.',
    },
  },
  {
    name: 'refuses a run with no doctor result',
    facts: run({ doctor: null }),
    request: [item('login')],
    expected: {
      kind: 'refuse',
      reason: "The run's doctor did not pass, so no item can be driven on it. Stop the run.",
    },
  },
  {
    name: 'refuses a run whose doctor exited 1',
    facts: run({ doctor: { exitCode: 1, logPath: 'doctor.log' } }),
    request: [item('login')],
    expected: {
      kind: 'refuse',
      reason: "The run's doctor did not pass, so no item can be driven on it. Stop the run.",
    },
  },
  {
    name: 'refuses a run whose doctor was killed',
    facts: run({ doctor: { exitCode: null, logPath: 'doctor.log' } }),
    request: [item('login')],
    expected: {
      kind: 'refuse',
      reason: "The run's doctor did not pass, so no item can be driven on it. Stop the run.",
    },
  },
  {
    name: 'refuses an empty request',
    facts: run({}),
    request: [],
    expected: { kind: 'refuse', reason: 'Register at least one item.' },
  },
  {
    name: 'refuses a name twice in the request',
    facts: run({}),
    request: [item('login'), item('search'), item('login')],
    expected: {
      kind: 'refuse',
      reason: 'login appears twice in the request.',
    },
  },
  {
    name: 'refuses a name twice in the request with a case-only difference',
    facts: run({}),
    request: [item('Login'), item('login')],
    expected: {
      kind: 'refuse',
      reason: 'login appears twice in the request.',
    },
  },
  {
    name: 'refuses an already registered item',
    facts: run({ items: [item('login')] }),
    request: [item('login')],
    expected: {
      kind: 'refuse',
      reason: 'login is already registered on this run.',
    },
  },
  {
    name: 'refuses an already registered item with a case-only difference',
    facts: run({ items: [item('Login')] }),
    request: [item('login')],
    expected: {
      kind: 'refuse',
      reason: 'login is already registered on this run.',
    },
  },
  {
    name: 'gives the stopped reason when the stopped run also failed its doctor',
    facts: run({
      doctor: { exitCode: 1, logPath: 'doctor.log' },
      stop: { exitCode: 0, logPath: 'stop.log' },
    }),
    request: [item('login')],
    expected: {
      kind: 'refuse',
      reason: 'The run is stopped. Launch a new run to register items.',
    },
  },
  {
    name: 'gives the duplicate reason over the registered reason',
    facts: run({ items: [item('login')] }),
    request: [item('login'), item('search'), item('search')],
    expected: {
      kind: 'refuse',
      reason: 'search appears twice in the request.',
    },
  },
];

it.each(registerTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideRegister(row.facts, row.request)).toStrictEqual(row.expected);
});

const stopTable: {
  name: string;
  facts: Pick<RunRecord, 'stop'>;
  expected: StopDecision;
}[] = [
  {
    name: 'accepts a run that is not stopped',
    facts: { stop: null },
    expected: { kind: 'accept' },
  },
  {
    name: 'refuses a stopped run',
    facts: { stop: { exitCode: 0, logPath: 'stop.log' } },
    expected: { kind: 'refuse', reason: 'The run is already stopped.' },
  },
  {
    name: 'accepts a retry when the saved stop exited nonzero',
    facts: { stop: { exitCode: 7, logPath: 'stop.log' } },
    expected: { kind: 'accept' },
  },
  {
    name: 'accepts a retry when the saved stop was killed',
    facts: { stop: { exitCode: null, logPath: 'stop.log' } },
    expected: { kind: 'accept' },
  },
];

it.each(stopTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideStop(row.facts)).toStrictEqual(row.expected);
});
