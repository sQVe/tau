import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import type { Mock } from 'vitest';

import { createHcFake } from '../../../../tests/hcFake.js';
import { startLeadInbox } from '../fixtures/leadInbox.js';
import { contextOf, holdLock, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import {
  askRecordDirectory,
  readArchitectRecord,
  readAskRecords,
  writeAskRecord,
} from '../record.js';
import type { HiddenAskRecord, LiveAskRecord } from '../record.js';
import { createArchitectTool } from '../tool.js';
import { askDeadlineSeconds } from './ask.js';

const hiddenAsk = (
  askId: string,
  createdAt: string,
  status: HiddenAskRecord['status'] = 'running',
): HiddenAskRecord => ({
  version: 3,
  route: 'hidden',
  askId,
  createdAt,
  question: `Question ${askId}?`,
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status,
  detail: null,
  answer: null,
  gateRecord: null,
});

const liveAsk = (askId: string, createdAt: string): LiveAskRecord => ({
  version: 3,
  route: 'live',
  askId,
  createdAt,
  question: `Question ${askId}?`,
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

it('ask refuses without a recorded session file', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('architect open');
});

it('ask refuses while another checkout holds the lock', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });
  const lockPath = `${architectLockPath(root)}.1`;

  await recordSession(root, { terminal: 't-architect' });
  await holdLock(root, '/other/checkout');

  const recordBefore = await readArchitectRecord(root);
  const lockBefore = await readFile(lockPath, 'utf8');

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('/other/checkout');
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('get');
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
  await expect(readArchitectRecord(root)).resolves.toEqual(recordBefore);
  await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockBefore);
});

it('ask to a newer lock holder asks again shortly', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root, { terminal: 't-architect' });
  await holdLock(root, root, 'newer');

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({
    action: 'ask',
    status: 'needsOpen',
    reason: 'The architect is starting. Ask again shortly.',
  });

  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('get');
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
  await expect(readAskRecords(root)).resolves.toEqual({ records: [], gaps: [] });
});

it('ask to an ask-mode holder waits for its answer', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root, { terminal: 't-architect', mode: 'ask' });
  await holdLock(root, root);

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({
    action: 'ask',
    status: 'needsOpen',
    reason: 'A hidden ask is running. Wait for its answer.',
  });

  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('get');
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
  await expect(readAskRecords(root)).resolves.toEqual({ records: [], gaps: [] });
});

it('ask reports an inbox that does not answer', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });
  const missingSocket = join(root, 'absent-inbox.sock');

  await recordSession(root, { terminal: 't-architect', sessionId: 'absent-inbox' });
  await holdLock(root, root);

  await startLeadInbox(cleanup, hc);

  hc.reply(
    'get',
    JSON.stringify({
      address: 't-architect',
      name: null,
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${missingSocket}` },
    }),
  );

  await expect(
    tool.execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    ),
  ).rejects.toThrow(/did not answer.*Nothing was queued/);

  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
});

it('an ask deadline returns needsOpen and kills the terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({ terminal: 't-ask', ended: false, reason: 'timeout', turn: 0, children: [] }),
  );

  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'finished' }));
  const startedAt = Date.now();

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect(hc.calls.some((call) => call.commandArguments[0] === 'kill')).toBe(true);
  const { records } = await readAskRecords(root);
  const [record] = records;
  const deadline = record?.route === 'hidden' ? record.deadline : undefined;

  expect(record).toMatchObject({ status: 'timeout', terminal: 't-ask' });
  expect(deadline).toBeGreaterThanOrEqual(startedAt + askDeadlineSeconds * 1000);
});

it('ask returns the answer the architect saved', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const answer = 'Use --quick.';

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({ terminal: 't-ask', ended: true, reason: 'ended', turn: 1, children: [] }),
  );

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      const { records } = await readAskRecords(root);
      const [record] = records;

      if (record?.route === 'hidden') {
        await writeAskRecord(root, { ...record, status: 'sent', answer });
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  const tool = createArchitectTool({ ...hc, exec, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'ended', answer });
});

it('a newer live record does not hide a running ask', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);

  await writeAskRecord(
    root,
    hiddenAsk('0190c1d2-0000-7000-8000-000000000108', '2026-11-17T10:00:00.000Z'),
  );

  await writeAskRecord(
    root,
    liveAsk('0190c1d2-0000-7000-8000-000000000109', '2026-11-17T10:00:01.000Z'),
  );

  hc.reply('get', JSON.stringify({ address: 't-ask', state: 'live' }));

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });

  expect((result.details as { reason: string }).reason).toContain(
    '0190c1d2-0000-7000-8000-000000000108',
  );

  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
});

it('ask falls back when its record disappears', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({
      terminal: 't-ask',
      ended: true,
      reason: 'ended',
      turn: 1,
      children: [],
      exit_code: 0,
    }),
  );

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      await rm(askRecordDirectory(root), { recursive: true, force: true });
    }

    return hc.exec(command, commandArguments, options);
  };

  const tool = createArchitectTool({ ...hc, exec, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
});

it('ask ignores a present record on another route', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({
      terminal: 't-ask',
      ended: true,
      reason: 'ended',
      turn: 1,
      children: [],
      exit_code: 0,
    }),
  );

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      const { records } = await readAskRecords(root);
      const [record] = records;

      if (record?.route === 'hidden') {
        await writeAskRecord(root, {
          ...liveAsk(record.askId, record.createdAt),
          status: 'failed',
        });
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  const tool = createArchitectTool({ ...hc, exec, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
});

it('ask reports a bad ask file and keeps the running ask', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const context = contextOf(root);
  const notify = context.ui.notify as unknown as Mock;

  await recordSession(root);

  await writeAskRecord(
    root,
    hiddenAsk('0190c1d2-0000-7000-8000-000000000108', '2026-11-17T10:00:00.000Z'),
  );

  await writeFile(join(askRecordDirectory(root), 'malformed.json'), '{"version":2');
  hc.reply('get', JSON.stringify({ address: 't-ask', state: 'live' }));

  const result = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    context,
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });

  expect((result.details as { reason: string }).reason).toContain(
    '0190c1d2-0000-7000-8000-000000000108',
  );

  expect(notify).toHaveBeenCalledWith(expect.stringContaining('Malformed ask record'), 'warning');
});
