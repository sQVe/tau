import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { createHcFake } from '../../../../tests/hcFake.js';
import { savedTexts } from '../../../../tests/inboxReceiverHarness.js';
import { startLiveArchitect } from '../fixtures/liveArchitect.js';
import { contextOf, recordSession, setup } from '../fixtures/toolHarness.js';
import { gateRecordDirectory, readAskRecord, readAskRecords, writeGateRecord } from '../record.js';
import type { GateRecord } from '../record.js';
import { createArchitectTool } from '../tool.js';

type AskInput = Parameters<ReturnType<typeof createArchitectTool>['execute']>[1];

interface RefusalCase {
  name: string;
  prepare: (root: string) => Promise<{ input: AskInput; error: string }>;
}

const uncertainGate: GateRecord = {
  version: 1,
  createdAt: '2026-11-18T10:00:00.000Z',
  request: 'Merge Koja PR #91 when every required check passes.',
  restatement: 'Merge PR #91 once its checks pass.',
  outcome: { kind: 'answered', label: 'open', confidence: 0.08 },
  decision: 'uncertain',
  label: 'open',
  confidence: 0.08,
};

const launchMessage = (hc: ReturnType<typeof createHcFake>): string | undefined =>
  hc.calls.find((call) => call.commandArguments[0] === 'run')?.commandArguments.at(-1);

const specifiedGate: GateRecord = {
  ...uncertainGate,
  outcome: { kind: 'answered', label: 'specified', confidence: 0.9 },
  decision: 'specified',
  label: 'specified',
  confidence: 0.9,
};

it('ask with gate saves the gate record on the live path', async ({ onTestFinished: cleanup }) => {
  const { root, receiver, tool } = await startLiveArchitect(cleanup);
  const gatePath = await writeGateRecord(root, uncertainGate);

  const result = await tool.execute(
    'call',
    { action: 'ask', gate: gatePath },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'queued' });

  const { askId } = result.details as { askId: string };
  const [sent = ''] = await savedTexts(receiver);

  expect(sent).toContain(uncertainGate.request);
  expect(sent).toContain(uncertainGate.restatement);
  expect(sent).toContain('Worker:');
  expect(sent).toContain('Open the architect:');

  const record = await readAskRecord(root, askId);

  expect(record).toMatchObject({ route: 'live', gateRecord: gatePath });
  expect(record?.question).toContain(uncertainGate.request);
  expect(record?.question).toContain(uncertainGate.restatement);
});

it('ask with gate saves the gate record on the hidden path', async ({
  onTestFinished: cleanup,
}) => {
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

  const gatePath = await writeGateRecord(root, uncertainGate);
  const tool = createArchitectTool({ ...hc, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', gate: gatePath },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });

  const message = launchMessage(hc);

  expect(message).toContain(uncertainGate.request);
  expect(message).toContain(uncertainGate.restatement);
  expect(message).toContain('Worker:');
  expect(message).toContain('Open the architect:');

  const { records } = await readAskRecords(root);
  const [record] = records;

  expect(record).toMatchObject({ route: 'hidden', gateRecord: gatePath });
  expect(record?.question).toContain(uncertainGate.request);
  expect(record?.question).toContain(uncertainGate.restatement);
});

it('ask with question saves no gate record', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({ terminal: 't-ask', ended: true, reason: 'ended', turn: 1, children: [] }),
  );

  const tool = createArchitectTool({ ...hc, cwd: root });

  await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const { records } = await readAskRecords(root);

  expect(records[0]).toMatchObject({ question: 'Which flag name?', gateRecord: null });
});

const refusalCases: RefusalCase[] = [
  {
    name: 'askId with gate',
    prepare: async () => ({
      input: { action: 'ask', askId: randomUUID(), gate: '/any/gate.json' },
      error: 'action ask with askId does not take gate.',
    }),
  },
  {
    name: 'question and gate',
    prepare: async () => ({
      input: { action: 'ask', question: 'Which flag name?', gate: '/any/gate.json' },
      error: 'action ask takes question or gate, not both.',
    }),
  },
  {
    name: 'neither question nor gate',
    prepare: async () => ({
      input: { action: 'ask' },
      error: 'question or gate is required.',
    }),
  },
  {
    name: 'a blank gate',
    prepare: async () => ({
      input: { action: 'ask', gate: '   ' },
      error: 'question or gate is required.',
    }),
  },
  {
    name: 'the gate directory itself',
    prepare: async (root) => {
      const directory = gateRecordDirectory(root);

      return {
        input: { action: 'ask', gate: directory },
        error: `gate ${directory} is not a gate record in ${directory}.`,
      };
    },
  },
  {
    name: 'a path outside the gate directory',
    prepare: async (root) => {
      const path = join(root, 'gate.json');

      return {
        input: { action: 'ask', gate: path },
        error: `gate ${path} is not a gate record in ${gateRecordDirectory(root)}.`,
      };
    },
  },
  {
    name: 'a missing record',
    prepare: async (root) => {
      const path = join(gateRecordDirectory(root), 'missing.json');

      return {
        input: { action: 'ask', gate: path },
        error: `gate record ${path} does not exist.`,
      };
    },
  },
  {
    name: 'a malformed record',
    prepare: async (root) => {
      const path = join(gateRecordDirectory(root), 'malformed.json');

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{"version":1');

      return {
        input: { action: 'ask', gate: path },
        error: `Malformed gate record ${path}: not JSON.`,
      };
    },
  },
  {
    name: 'a specified record',
    prepare: async (root) => {
      const path = await writeGateRecord(root, specifiedGate);

      return {
        input: { action: 'ask', gate: path },
        error: `gate record ${path} is specified, not uncertain. Follow it instead of asking.`,
      };
    },
  },
];

it.for(refusalCases.map((refusal) => [refusal.name, refusal] as const))(
  'ask refuses %s and writes nothing',
  async ([, refusal], { onTestFinished: cleanup }) => {
    const { root } = await setup(cleanup);
    const hc = createHcFake();
    const tool = createArchitectTool({ ...hc, cwd: root });
    const { input, error } = await refusal.prepare(root);

    await expect(
      tool.execute('call', input, undefined, undefined, contextOf(root)),
    ).rejects.toThrow(error);

    await expect(readAskRecords(root)).resolves.toEqual({ records: [], gaps: [] });
    expect(hc.calls).toEqual([]);
  },
);

it('a gate ask to an architect without an inbox tells the lead to keep the gate', async ({
  onTestFinished: cleanup,
}) => {
  const { root, hc, tool } = await startLiveArchitect(cleanup);
  const gatePath = await writeGateRecord(root, uncertainGate);

  hc.replyGet('t-architect', JSON.stringify({ address: 't-architect', name: null, state: 'live' }));

  const result = await tool.execute(
    'call',
    { action: 'ask', gate: gatePath },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });

  expect((result.details as { reason: string }).reason).toContain(
    `Call architect ask again with gate ${gatePath} in a few seconds.`,
  );

  await expect(readAskRecords(root)).resolves.toEqual({ records: [], gaps: [] });
});
