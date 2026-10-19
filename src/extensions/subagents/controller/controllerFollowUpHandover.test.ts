import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { completed } from './fixtures/controllerFixture.js';
import { taskStatus } from './record.js';

type SourceChange = 'nothing' | 'task record' | 'native session file';

// Changes the source while the follow-up lists live panes, after preparation read the source.
const followUpWhileChanging = async (changed: SourceChange) => {
  let following = false;
  let sourceDirectory = '';
  let nativeFile = '';

  const fixture = await completed(async (argumentsList) => {
    if (following && argumentsList[1] === 'list') {
      if (changed === 'task record') {
        const path = join(sourceDirectory, 'task.json');

        const saved = JSON.parse(readFileSync(path, 'utf8')) as {
          deadline: number;
        };

        writeFileSync(path, JSON.stringify({ ...saved, deadline: saved.deadline + 1 }));
      }

      if (changed === 'native session file') {
        appendFileSync(nativeFile, '{"type":"message"}\n');
      }
    }

    return '';
  });

  sourceDirectory = fixture.sourceDirectory;
  nativeFile = fixture.source.nativeSessionFile;
  following = true;
  const callsBefore = fixture.calls.length;

  const next = await fixture.controller.followUp(fixture.input, fixture.context);

  const placed = fixture.calls.slice(callsBefore).some((call) => call[0] === 'layout');

  return { fixture, next, placed };
};

it('starts a follow-up when the source did not change during preparation', async () => {
  const { fixture, next, placed } = await followUpWhileChanging('nothing');

  expect(placed).toBe(true);
  expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBe(next.taskId);
});

it.each(['task record', 'native session file'] as const)(
  'does not start a follow-up when the source %s changed during preparation',
  async (changed) => {
    const { fixture, next, placed } = await followUpWhileChanging(changed);

    expect(next.state).toBe('stopped');
    expect(next.outcome).toBe('failure');
    expect(placed).toBe(false);
    expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();
  },
);
