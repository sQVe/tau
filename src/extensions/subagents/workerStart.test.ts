import { expect, it } from 'vitest';

import type { WorkerStart } from './workerResume.js';
import {
  isStartInput,
  startInputResult,
  startPromptText,
  workerContinuation,
  workerStartMessage,
} from './workerStart.js';

const taskPrompt = 'Inspect the fixture.';

it.each([
  { name: 'sends the task prompt', start: 'sendTask', prompt: taskPrompt },
  { name: 'continues the restarted session', start: 'continue', prompt: workerContinuation },
  { name: 'waits without a prompt', start: 'wait', prompt: undefined },
  { name: 'shuts down without a prompt', start: 'shutdown', prompt: undefined },
] satisfies { name: string; start: WorkerStart; prompt: string | undefined }[])(
  '$name',
  ({ start, prompt }) => {
    expect(startPromptText(start, taskPrompt, undefined)).toBe(prompt);
  },
);

it('names the saved answer in the continuation prompt', () => {
  const answerPath = '/agent/assignments/a/answers/q.json';

  expect(startPromptText('continue', taskPrompt, answerPath)).toContain(answerPath);
});

it.each([
  {
    name: 'takes the pending start message',
    pending: true,
    text: workerStartMessage,
    expected: true,
  },
  {
    name: 'ignores another message',
    pending: true,
    text: 'Use A.',
    expected: false,
  },
  {
    name: 'ignores a start message after the first',
    pending: false,
    text: workerStartMessage,
    expected: false,
  },
])('$name', ({ pending, text, expected }) => {
  expect(isStartInput(pending, text)).toBe(expected);
});

it.each([
  {
    name: 'transforms the input to the start text',
    startText: taskPrompt,
    expected: { action: 'transform', text: taskPrompt },
  },
  {
    name: 'handles input with no start text',
    startText: undefined,
    expected: { action: 'handled' },
  },
])('$name', ({ startText, expected }) => {
  expect(startInputResult(startText)).toEqual(expected);
});
