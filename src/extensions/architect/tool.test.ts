import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { contextOf, holdLock, recordSession, setup } from '../../../tests/architectToolHarness.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { askDeadlineSeconds } from './ask.js';
import { gateClassifier } from './gate.js';
import { architectLockPath } from './lock.js';
import {
  askRecordDirectory,
  gateRecordDirectory,
  readAskRecords,
  readArchitectRecord,
  readGateRecord,
  writeAskRecord,
} from './record.js';
import { createArchitectTool } from './tool.js';

const classifyAsSpecified = async () => ({
  stopReason: 'stop',
  answers: { choice: { type: 'choice', choice: 'specified', confidence: 0.9 } },
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

  await recordSession(root, 't-architect');
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

it('ask reports an inbox that does not answer', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });
  const missingSocket = join(root, 'absent-inbox.sock');

  await recordSession(root, 't-architect');
  await holdLock(root, root);

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

it('a second ask while one runs is refused', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root, 't-architect');
  await holdLock(root, root);
  await mkdir(askRecordDirectory(root), { recursive: true });

  await writeFile(
    join(askRecordDirectory(root), 'ask-1.json'),
    JSON.stringify({
      version: 1,
      askId: 'ask-1',
      createdAt: new Date().toISOString(),
      question: 'Earlier question',
      sessionFile: join(root, 'architect-session.jsonl'),
      terminal: 't-ask',
      leadTerminal: 't-lead',
      deadline: Date.now() + 1000,
      status: 'running',
      detail: null,
      answer: null,
    }),
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
  expect((result.details as { reason: string }).reason).toContain('ask-1');
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);

  await expect(readAskRecords(root)).resolves.toMatchObject([
    { askId: 'ask-1', status: 'running' },
  ]);
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
  const [record] = await readAskRecords(root);

  expect(record).toMatchObject({ status: 'timeout', terminal: 't-ask' });
  expect(record?.deadline).toBeGreaterThanOrEqual(startedAt + askDeadlineSeconds * 1000);
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
      const [record] = await readAskRecords(root);

      if (record !== undefined) {
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

it('gate writes one record per call', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const classifierCalls: unknown[][] = [];

  const context = contextOf(root, {
    findOfType: (...args: unknown[]) => {
      classifierCalls.push(args);

      return {};
    },
    classify: classifyAsSpecified,
  });

  const first = await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  const second = await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  expect(first.details).toMatchObject({ decision: 'specified', label: 'specified' });
  expect(second.details).toMatchObject({ decision: 'specified', label: 'specified' });
  expect(classifierCalls[0]).toEqual(['classifier', ...gateClassifier.split('/')]);

  const names = await readdir(gateRecordDirectory(root));
  const records = await Promise.all(names.map((name) => readGateRecord(root, name)));

  expect(records.map((record) => record?.decision)).toEqual(['specified', 'specified']);
  expect(await readArchitectRecord(root)).toBeUndefined();
});

it('gate records an uncertain decision below the cutoff', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const context = contextOf(root, {
    findOfType: () => ({}),
    classify: async () => ({
      stopReason: 'stop',
      answers: { choice: { type: 'choice', choice: 'specified', confidence: 0.69 } },
    }),
  });

  await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  const [name] = await readdir(gateRecordDirectory(root));
  const record = name === undefined ? undefined : await readGateRecord(root, name);

  expect(record?.decision).toBe('uncertain');
});
