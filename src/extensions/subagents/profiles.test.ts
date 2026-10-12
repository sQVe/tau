import { expect, it } from 'vitest';

import { workerPrompt } from './profiles.js';
import type { Task } from './types.js';

const task = (acceptance?: string[]) =>
  ({
    taskId: 'task-1',
    task: 'Fix the parser.',
    deadline: 1_700_000_000_000,
    ...(acceptance === undefined ? {} : { acceptance }),
  }) as Task;

it('lists acceptance criteria in order under the task', () => {
  const prompt = workerPrompt(task(['Parses empty input.', 'Keeps the old API.']));

  expect(prompt).toContain(
    'Fix the parser.\n\nAcceptance criteria:\n1. Parses empty input.\n2. Keeps the old API.\n\nDeadline:',
  );
});

it('adds no criteria section when the task has none', () => {
  expect(workerPrompt(task())).not.toContain('Acceptance criteria');
});
