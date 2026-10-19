import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { completed } from './fixtures/controllerFixture.js';
import { taskStatus } from './record.js';

it.each(['task record', 'native session file'] as const)(
  'does not start a follow-up when the source %s changed during preparation',
  async (changed) => {
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
        } else {
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

    expect(next.state).toBe('stopped');
    expect(next.outcome).toBe('failure');
    expect(fixture.calls.slice(callsBefore).some((call) => call[0] === 'layout')).toBe(false);
    expect(taskStatus(fixture.sourceDirectory).successorTaskId).toBeUndefined();
  },
);
