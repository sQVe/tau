import { expect, it } from 'vitest';

import type { HcWaitResult } from '../../../hc/hc.js';
import { askWaitStep } from './askWaitDecision.js';
import type { AskWaitStep } from './askWaitDecision.js';

const waitResult = (ended: boolean, reason: string): HcWaitResult => ({
  terminal: 't-ask',
  ended,
  reason,
  turn: 1,
  children: [],
  exit_code: ended ? 0 : null,
  signal: null,
});

const now = 10_000;
const deadline = 70_000;

const table: {
  name: string;
  result: HcWaitResult;
  now: number;
  deadline: number;
  expected: AskWaitStep;
}[] = [
  {
    name: 'exits when the terminal exits',
    result: waitResult(true, 'exit'),
    now,
    deadline,
    expected: { kind: 'exited' },
  },
  {
    name: 'times out when the wait ends without an exit',
    result: waitResult(false, 'timeout'),
    now,
    deadline,
    expected: { kind: 'timeout' },
  },
  {
    name: 'waits again with the seconds left after a status change',
    result: waitResult(true, 'status'),
    now,
    deadline,
    expected: { kind: 'waitAgain', secondsLeft: 60 },
  },
  {
    name: 'waits again with the seconds left after a message',
    result: waitResult(true, 'message'),
    now,
    deadline,
    expected: { kind: 'waitAgain', secondsLeft: 60 },
  },
  {
    name: 'waits again with the seconds left after output',
    result: waitResult(true, 'output'),
    now,
    deadline,
    expected: { kind: 'waitAgain', secondsLeft: 60 },
  },
  {
    name: 'waits again with the seconds left after a terminal that did not start',
    result: waitResult(true, 'not_started'),
    now,
    deadline,
    expected: { kind: 'waitAgain', secondsLeft: 60 },
  },
  {
    name: 'times out when no time is left before the deadline',
    result: waitResult(true, 'status'),
    now: deadline,
    deadline,
    expected: { kind: 'timeout' },
  },
  {
    name: 'rounds the seconds left up to a whole second',
    result: waitResult(true, 'status'),
    now: 10_500,
    deadline,
    expected: { kind: 'waitAgain', secondsLeft: 60 },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(askWaitStep(row.result, row.now, row.deadline)).toStrictEqual(row.expected);
});
