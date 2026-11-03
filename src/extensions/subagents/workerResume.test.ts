import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { decideWorkerResume } from './workerResume.js';

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
