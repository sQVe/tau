import { readdir } from 'node:fs/promises';

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

it.for([
  ['open', { action: 'open' }],
  ['gate', { action: 'gate', request: 'Rename --fast.', restatement: 'Rename it.' }],
] as const)(
  '%s refuses an askId and has no effects',
  async ([action, input], { onTestFinished }) => {
    const { root } = await setup(onTestFinished);
    const hc = createHcFake();

    await expect(
      createArchitectTool({ ...hc, cwd: root }).execute(
        'call',
        { ...input, askId: '0190c1d2-0000-7000-8000-000000000501' },
        undefined,
        undefined,
        contextOf(root),
      ),
    ).rejects.toThrow(`action ${action} does not take askId.`);

    expect(hc.calls).toEqual([]);
    await expect(readdir(gateRecordDirectory(root))).rejects.toThrow(/ENOENT/);
  },
);
