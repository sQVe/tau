import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { decideWorkerResume, decideWorkerStart } from './workerResume.js';

const entry = (message: unknown, type = 'message') =>
  ({ type, message }) as unknown as SessionEntry;

const user = () => entry({ role: 'user', content: 'Task: inspect the fixture.' });

const question = (isError = false) =>
  entry({ role: 'toolResult', toolName: 'subagent_question', isError });

const otherResult = () => entry({ role: 'toolResult', toolName: 'subagent_report' });

it.each([
  {
    name: 'sends the prompt with no entries',
    branch: [],
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
  {
    name: 'no prompt after a user message',
    branch: [user()],
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'waits after a question',
    branch: [user(), question()],
    sendTaskPrompt: false,
    waitingForQuestion: true,
  },
  {
    name: 'a user message ends the wait',
    branch: [user(), question(), user()],
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'a second question waits again',
    branch: [user(), question(), user(), question()],
    sendTaskPrompt: false,
    waitingForQuestion: true,
  },
  {
    name: 'another result does not answer',
    branch: [user(), question(), otherResult()],
    sendTaskPrompt: false,
    waitingForQuestion: true,
  },
  {
    name: 'another result is not a question',
    branch: [user(), otherResult()],
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'a failed question does not wait',
    branch: [user(), question(true)],
    sendTaskPrompt: false,
    waitingForQuestion: false,
  },
  {
    name: 'a non-message is not user text',
    branch: [entry({ role: 'user', content: 'Task' }, 'custom')],
    sendTaskPrompt: true,
    waitingForQuestion: false,
  },
] satisfies {
  name: string;
  branch: SessionEntry[];
  sendTaskPrompt: boolean;
  waitingForQuestion: boolean;
}[])('$name', ({ branch, sendTaskPrompt, waitingForQuestion }) => {
  expect(decideWorkerResume(branch)).toEqual({ sendTaskPrompt, waitingForQuestion });
});

const resume = (sendTaskPrompt: boolean, waitingForQuestion: boolean) => ({
  sendTaskPrompt,
  waitingForQuestion,
});

it.each([
  {
    name: 'shuts down a fresh worker whose assignment has a report',
    resume: resume(true, false),
    hasReport: true,
    start: 'shutdown',
  },
  {
    name: 'shuts down a reported worker that was waiting for an answer',
    resume: resume(false, true),
    hasReport: true,
    start: 'shutdown',
  },
  {
    name: 'sends the task when the task prompt never went out',
    resume: resume(true, false),
    hasReport: false,
    start: 'sendTask',
  },
  {
    name: 'waits when a question has no answer yet',
    resume: resume(false, true),
    hasReport: false,
    start: 'wait',
  },
  {
    name: 'continues a sent task with no question and no report',
    resume: resume(false, false),
    hasReport: false,
    start: 'continue',
  },
] satisfies {
  name: string;
  resume: ReturnType<typeof resume>;
  hasReport: boolean;
  start: string;
}[])('$name', ({ resume: facts, hasReport, start }) => {
  expect(decideWorkerStart(facts, hasReport)).toBe(start);
});
