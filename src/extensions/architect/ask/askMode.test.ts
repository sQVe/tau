import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { askRecordPath, readAskRecordAt, writeAskRecord, writeAskRecordAt } from '../record.js';
import type { HiddenAskRecord, LiveAskRecord } from '../record.js';
import { askModePrompt, registerAskMode } from './askMode.js';

const askRecord = (): HiddenAskRecord => ({
  version: 3,
  route: 'hidden',
  askId: '0190c1d2-0000-7000-8000-000000000105',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name should replace --fast?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1,
  status: 'running',
  detail: null,
  answer: null,
  gateRecord: null,
});

const liveRecord = (): LiveAskRecord => ({
  version: 3,
  route: 'live',
  askId: '0190c1d2-0000-7000-8000-000000000106',
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name should replace --fast?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  architectLockToken: 'live',
  status: 'queued',
  detail: null,
  answer: null,
  gateRecord: null,
});

const askFile = async (
  cleanup: (cleanup: () => void) => void,
): Promise<{ directory: string; path: string; record: HiddenAskRecord }> => {
  const directory = await createTemporaryRepository(cleanup);
  const record = askRecord();
  const path = askRecordPath(directory, record.askId);

  await writeAskRecord(directory, record);

  return { directory, path, record };
};

const writeHandover = async (directory: string, text: string): Promise<string> => {
  const path = join(directory, 'message.md');

  await writeFile(path, text);

  return path;
};

it('ask mode names the ask in its prompt and saves the answer to the lead', async ({
  onTestFinished,
}) => {
  const { directory, path, record } = await askFile(onTestFinished);
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<() => void>();
  const answer = 'Use --quick.';
  const file = await writeHandover(directory, answer);

  registerAskMode(fake.pi, () => directory, path);

  const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: [] } };

  await fake.handler('before_agent_start')(event, {} as never);

  expect(event.systemPromptOptions.appendSystemPrompt).toBe(askModePrompt(record, path));

  const block = await fake.handler('tool_call')(
    {
      type: 'tool_call',
      toolName: 'handover',
      toolCallId: 'call',
      input: { action: 'send', terminal: 't-lead', file },
    },
    { shutdown, cwd: directory } as never,
  );

  expect(block).toBeUndefined();

  await fake.handler('tool_result')(
    { toolName: 'handover', details: { status: 'queued' }, input: { terminal: 't-lead', file } },
    { shutdown, cwd: directory } as never,
  );

  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(await readAskRecordAt(path)).toMatchObject({ status: 'sent', answer });
});

it('ask mode blocks a handover send to a terminal that is not the lead', async ({
  onTestFinished,
}) => {
  const { directory, path } = await askFile(onTestFinished);
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<() => void>();
  const file = await writeHandover(directory, 'Use --quick.');

  registerAskMode(fake.pi, () => directory, path);

  const block = await fake.handler('tool_call')(
    {
      type: 'tool_call',
      toolName: 'handover',
      toolCallId: 'call',
      input: { action: 'send', terminal: 't-other', file },
    },
    { shutdown, cwd: directory } as never,
  );

  expect(block).toEqual({
    block: true,
    reason: expect.stringContaining('t-lead') as string,
  });

  expect(shutdown).not.toHaveBeenCalled();
  expect(await readAskRecordAt(path)).toMatchObject({ status: 'running', answer: null });
});

it('ask mode leaves a live record alone', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-ask-mode-');
  const path = join(directory, `${liveRecord().askId}.json`);
  const record = liveRecord();
  const file = await writeHandover(directory, 'Use --quick.');
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<() => void>();

  await writeAskRecordAt(path, record);
  registerAskMode(fake.pi, () => directory, path);

  await fake.handler('tool_result')(
    { toolName: 'handover', details: { status: 'queued' }, input: { terminal: 't-lead', file } },
    { shutdown, cwd: directory } as never,
  );

  expect(shutdown).not.toHaveBeenCalled();
  expect(await readAskRecordAt(path)).toEqual(record);
});

it('ask mode ignores a missing record', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-ask-mode-');
  const path = join(directory, 'missing.json');
  const file = await writeHandover(directory, 'Use --quick.');
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<() => void>();

  registerAskMode(fake.pi, () => directory, path);

  await fake.handler('tool_result')(
    { toolName: 'handover', details: { status: 'queued' }, input: { terminal: 't-lead', file } },
    { shutdown, cwd: directory } as never,
  );

  expect(shutdown).not.toHaveBeenCalled();
  expect(existsSync(path)).toBe(false);
});

it('ask mode does not shut down when no handover was queued', async ({ onTestFinished }) => {
  const { directory, path } = await askFile(onTestFinished);
  const fake = fakeExtensionApi();
  const shutdown = vi.fn<() => void>();

  registerAskMode(fake.pi, () => directory, path);

  await fake.handler('tool_result')({ toolName: 'handover', details: { status: 'unknown' } }, {
    shutdown,
  } as never);

  expect(shutdown).not.toHaveBeenCalled();
  expect(await readAskRecordAt(path)).toMatchObject({ status: 'running' });
});
