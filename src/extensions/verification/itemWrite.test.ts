import { existsSync } from 'node:fs';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { isMissingFile } from '../../errors.js';
import type { RunRecord } from '../../verification/records.js';
import { itemRecordPath, readItemRecord, readRuns } from '../../verification/verification.js';
import { createRunDirectory } from './fixtures/runDirectory.js';
import { recordItem } from './itemWrite.js';
import type { RecordInput } from './recordParameters.js';

interface RefusalCase {
  name: string;
  reason: string;
  items?: RunRecord['items'];
  input?: (input: RecordInput) => RecordInput;
  prepare?: (directory: string) => Promise<void>;
}

const run = 'delegate-a-check';
const item = 'journeys/delegate-a-check';

const validInput = (): RecordInput => ({
  run,
  item,
  steps: [
    { status: 'passed', artifacts: [{ kind: 'screenshot', path: 'screenshots/step-1.png' }] },
    { status: 'differs', observed: 'The dialog stays open.', artifacts: [] },
  ],
  endState: { status: 'passed' },
});

const listItems = async (directory: string): Promise<string[]> => {
  try {
    const entries = await readdir(join(directory, 'items'), { recursive: true });

    return entries.toSorted();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
};

const failureMessage = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

it('saves a valid hand result as a readable item file', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await mkdir(join(directory, 'screenshots'), { recursive: true });
  await writeFile(join(directory, 'screenshots', 'step-1.png'), 'png');

  const saved = await recordItem(root, validInput());
  const read = await readItemRecord(saved.path);

  expect(saved).toEqual({
    run,
    item,
    path: itemRecordPath(directory, item),
  });

  expect(read).toMatchObject({
    status: 'valid',
    record: {
      run,
      item,
      drive: 'hand',
      steps: [{ number: 1 }, { number: 2 }],
      endState: { status: 'passed' },
    },
  });
});

const refusalCases: RefusalCase[] = [
  {
    name: 'an unregistered item',
    reason: `Item ${item} is not registered in run ${run}. Registered: journeys/other.`,
    items: [{ item: 'journeys/other', steps: 2 }],
  },
  {
    name: 'a wrong step count',
    reason: `Item ${item} has 2 registered steps in run ${run}, but 1 results were given.`,
    input: (input) => ({ ...input, steps: input.steps.slice(0, 1) }),
  },
  {
    name: 'a missing end state',
    reason: `Item ${item} needs an endState result.`,
    input: ({ endState: _endState, ...input }) => input,
  },
  {
    name: 'an existing item file',
    reason: `Item ${item} already has a result in run ${run}. Each item is recorded once.`,
    prepare: async (directory) => {
      await mkdir(join(directory, 'items', 'journeys'), { recursive: true });
      await writeFile(itemRecordPath(directory, item), '{}');
    },
  },
  {
    name: 'an artifact outside the run directory',
    reason: 'Step 1 artifact ../outside.png is outside the run directory.',
    input: (input) => ({
      ...input,
      steps: [
        { status: 'passed', artifacts: [{ kind: 'screenshot', path: '../outside.png' }] },
        input.steps[1] ?? { status: 'passed', artifacts: [] },
      ],
    }),
  },
  {
    name: 'an artifact symlinked out of the run directory',
    reason: 'Step 1 artifact screenshots/step-1.png is outside the run directory.',
    prepare: async (directory) => {
      await mkdir(join(directory, 'screenshots'), { recursive: true });
      await writeFile(join(directory, '..', 'outside.png'), 'png');

      await symlink(
        join(directory, '..', 'outside.png'),
        join(directory, 'screenshots', 'step-1.png'),
      );
    },
  },
];

it('refuses a stopped run before probing an artifact under a regular file', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
    stop: { exitCode: 0, logPath: 'stop.log' },
  });

  await writeFile(join(directory, 'screenshots'), 'not a directory');

  const before = await listItems(directory);
  const failure = await failureMessage(recordItem(root, validInput()));

  expect({ failure, items: await listItems(directory) }).toEqual({
    failure: `Run ${run} is stopped; record results before the manager stops it.`,
    items: before,
  });
});

it('refuses an artifact path under a regular file as missing', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await writeFile(join(directory, 'screenshots'), 'not a directory');

  const before = await listItems(directory);
  const failure = await failureMessage(recordItem(root, validInput()));

  expect({ failure, items: await listItems(directory) }).toEqual({
    failure: 'Step 1 artifact screenshots/step-1.png does not exist in the run directory.',
    items: before,
  });
});

it('refuses an input only the record check rejects before creating the items folder', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await writeFile(join(directory, 'step-1.png'), 'png');

  const input = validInput();

  input.steps[0] = {
    status: 'passed',
    artifacts: [{ kind: 'screenshot', path: './step-1.png' }],
  };

  const failure = await failureMessage(recordItem(root, input));

  expect(failure).toContain('Malformed item record');

  expect({
    itemsFolder: existsSync(join(directory, 'items')),
    itemFile: existsSync(itemRecordPath(directory, item)),
  }).toEqual({ itemsFolder: false, itemFile: false });
});

it.each(refusalCases)('refuses $name and writes no item file', async (refusal) => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: refusal.items ?? [{ item, steps: 2 }],
  });

  await refusal.prepare?.(directory);

  const before = await listItems(directory);
  const input = refusal.input?.(validInput()) ?? validInput();
  const failure = await failureMessage(recordItem(root, input));

  expect({ failure, items: await listItems(directory) }).toEqual({
    failure: refusal.reason,
    items: before,
  });
});

it('saves two items recorded at once', async () => {
  const items = [
    { item: 'journeys/one', steps: 1 },
    { item: 'journeys/two', steps: 1 },
  ];

  const { root } = await createRunDirectory(onTestFinished, run, { items });

  const input = (name: string): RecordInput => ({
    run,
    item: name,
    steps: [{ status: 'passed', artifacts: [] }],
    endState: { status: 'passed' },
  });

  await Promise.all(items.map(({ item: name }) => recordItem(root, input(name))));

  const [result] = await readRuns(join(root, '.tau', 'verification'));

  expect(
    result?.items.map(({ item: name, read }) => ({ item: name, status: read.status })),
  ).toEqual([
    { item: 'journeys/one', status: 'valid' },
    { item: 'journeys/two', status: 'valid' },
  ]);
});
