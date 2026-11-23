import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { contextOf, setup } from './fixtures/toolHarness.js';
import { gateClassifier } from './gate.js';
import { gateRecordDirectory, readArchitectRecord, readGateRecord } from './record.js';
import { createArchitectTool } from './tool.js';

const classifyAsSpecified = async () => ({
  stopReason: 'stop',
  answers: { choice: { type: 'choice', choice: 'specified', confidence: 0.9 } },
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

  const reads = await Promise.all(
    names.map((name) => readGateRecord(root, join(gateRecordDirectory(root), name))),
  );

  expect(reads.map((read) => (read.kind === 'found' ? read.record.decision : undefined))).toEqual([
    'specified',
    'specified',
  ]);

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

  const read =
    name === undefined
      ? undefined
      : await readGateRecord(root, join(gateRecordDirectory(root), name));

  const decision = read?.kind === 'found' ? read.record.decision : undefined;

  expect(decision).toBe('uncertain');
});

it.for([
  ['open', { action: 'open', request: 'Rename --fast.' }],
  ['gate', { action: 'gate', request: 'Rename --fast.', restatement: 'Rename it.' }],
] as const)('%s refuses a gate and has no effects', async ([action, input], { onTestFinished }) => {
  const { root } = await setup(onTestFinished);
  const hc = createHcFake();

  const tool = createArchitectTool({ ...hc, cwd: root });

  const called = tool.execute(
    'call',
    { ...input, gate: join(gateRecordDirectory(root), 'gate.json') },
    undefined,
    undefined,
    contextOf(root),
  );

  await expect(called).rejects.toThrow(`action ${action} does not take gate.`);

  expect(hc.calls).toEqual([]);
  await expect(readdir(gateRecordDirectory(root))).rejects.toThrow(/ENOENT/);
});

it.for([
  ['open', { action: 'open' }],
  ['gate', { action: 'gate', request: 'Rename --fast.', restatement: 'Rename it.' }],
] as const)(
  '%s refuses an askId and has no effects',
  async ([action, input], { onTestFinished }) => {
    const { root } = await setup(onTestFinished);
    const hc = createHcFake();

    const tool = createArchitectTool({ ...hc, cwd: root });

    const called = tool.execute(
      'call',
      { ...input, askId: '0190c1d2-0000-7000-8000-000000000501' },
      undefined,
      undefined,
      contextOf(root),
    );

    await expect(called).rejects.toThrow(`action ${action} does not take askId.`);

    expect(hc.calls).toEqual([]);
    await expect(readdir(gateRecordDirectory(root))).rejects.toThrow(/ENOENT/);
  },
);

it('gate refuses a question and has no effects', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  const tool = createArchitectTool({ ...hc, cwd: root });

  const called = tool.execute(
    'call',
    {
      action: 'gate',
      request: 'Rename --fast.',
      restatement: 'Rename it.',
      question: 'Which flag name?',
    },
    undefined,
    undefined,
    contextOf(root),
  );

  await expect(called).rejects.toThrow('action gate does not take question.');

  expect(hc.calls).toEqual([]);
  await expect(readdir(gateRecordDirectory(root))).rejects.toThrow(/ENOENT/);
});
