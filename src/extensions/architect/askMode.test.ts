import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { askModePrompt, registerAskMode } from './askMode.js';
import { readAskRecordAt, writeAskRecordAt } from './record.js';
import type { AskRecord } from './record.js';

const askRecord = (): AskRecord => ({
  version: 1,
  askId: 'ask-1',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name should replace --fast?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1,
  status: 'running',
  detail: null,
});

const askFile = async (
  cleanup: (cleanup: () => void) => void,
): Promise<{ path: string; record: AskRecord }> => {
  const directory = temporaryDirectory(cleanup, 'tau-ask-mode-');
  const path = join(directory, 'ask.json');
  const record = askRecord();

  await writeAskRecordAt(path, record);

  return { path, record };
};

it('ask mode names the ask in its prompt and shuts down after a queued handover', async ({
  onTestFinished,
}) => {
  const { path, record } = await askFile(onTestFinished);
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<() => void>();

  registerAskMode(fake.pi, path);

  const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: [] } };

  await fake.handler('before_agent_start')(event, {} as never);

  expect(event.systemPromptOptions.appendSystemPrompt).toBe(askModePrompt(record, path));

  await fake.handler('tool_result')({ toolName: 'handover', details: { status: 'queued' } }, {
    shutdown,
  } as never);

  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(await readAskRecordAt(path)).toMatchObject({ status: 'sent' });
});

it('ask mode does not shut down when no handover was queued', async ({ onTestFinished }) => {
  const { path } = await askFile(onTestFinished);
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<() => void>();

  registerAskMode(fake.pi, path);

  await fake.handler('tool_result')({ toolName: 'handover', details: { status: 'unknown' } }, {
    shutdown,
  } as never);

  expect(shutdown).not.toHaveBeenCalled();
  expect(await readAskRecordAt(path)).toMatchObject({ status: 'running' });
});
