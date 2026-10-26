import {
  appendFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import * as records from '../records.js';
import { followUpMilliseconds } from '../retentionDecision.js';
import { completed, savedFiles } from './fixtures/controllerFixture.js';

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

  expect(
    fixture.controller.status(fixture.source.taskId, fixture.input.parentSessionId).successorTaskId,
  ).toBe(next.taskId);
});

it.each(['task record', 'native session file'] as const)(
  'does not start a follow-up when the source %s changed during preparation',
  async (changed) => {
    const { fixture, next, placed } = await followUpWhileChanging(changed);

    expect(next.state).toBe('stopped');
    expect(next.outcome).toBe('failure');
    expect(placed).toBe(false);

    expect(
      fixture.controller.status(fixture.source.taskId, fixture.input.parentSessionId)
        .successorTaskId,
    ).toBeUndefined();
  },
);

it('does not start a follow-up whose source left the root after the follow-up was published', async () => {
  const fixture = await completed();
  const publish = records.publishRecord;

  vi.spyOn(records, 'publishRecord').mockImplementation((directory, name, value) => {
    publish(directory, name, value);

    if (name === 'task.json' && 'predecessorTaskId' in value) {
      renameSync(fixture.sourceDirectory, `${fixture.sourceDirectory}-moved`);
    }
  });

  const callsBefore = fixture.calls.length;
  const next = await fixture.controller.followUp(fixture.input, fixture.context);

  expect(next.predecessorTaskId).toBe(fixture.source.taskId);
  expect(next.state).toBe('stopped');
  expect(fixture.calls.slice(callsBefore).some((call) => call[0] === 'layout')).toBe(false);
});

it('refuses a follow-up of a source last written more than 13 days ago and saves nothing', async () => {
  const fixture = await completed();
  const old = new Date(Date.now() - followUpMilliseconds - 60_000);

  for (const entry of readdirSync(fixture.sourceDirectory)) {
    utimesSync(join(fixture.sourceDirectory, entry), old, old);
  }

  utimesSync(fixture.sourceDirectory, old, old);

  const saved = savedFiles(fixture.directory);
  const callsBefore = fixture.calls.length;

  await expect(fixture.controller.followUp(fixture.input, fixture.context)).rejects.toThrow(
    '13 days',
  );

  expect(savedFiles(fixture.directory)).toEqual(saved);
  expect(fixture.calls.slice(callsBefore).some((call) => call[0] === 'layout')).toBe(false);
});
