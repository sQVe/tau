import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { errorMessage, isMissingFile } from '../../errors.js';
import { itemRecordVersion } from '../../verification/records.js';
import type { ItemRecord, RunRecord, StepOutcome } from '../../verification/records.js';
import {
  itemRecordPath,
  readItemRecord,
  readRuns,
  verificationDirectoryPath,
} from '../../verification/verification.js';
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

const preCheck = vi.hoisted(() => ({ skip: false }));

vi.mock(import('../../tauDirectory.js'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    existingEntry: async (path: string) =>
      preCheck.skip ? undefined : original.existingEntry(path),
  };
});

const run = 'delegate-a-check';
const item = 'journeys/delegate-a-check';

const validInput = (): RecordInput & { endState: StepOutcome } => ({
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

const inputWithArtifact = (path: string): RecordInput => {
  const input = validInput();

  input.steps[0] = { status: 'passed', artifacts: [{ kind: 'screenshot', path }] };

  return input;
};

const unreadableArtifact = async (directory: string): Promise<string> => {
  const folder = join(directory, 'screenshots');

  await mkdir(folder);
  await writeFile(join(folder, 'step-1.png'), 'png');

  if (process.getuid?.() === 0) {
    await symlink('loop.png', join(folder, 'loop.png'));

    return 'screenshots/loop.png';
  }

  await chmod(folder, 0o000);
  onTestFinished(() => chmod(folder, 0o700));

  return 'screenshots/step-1.png';
};

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
    name: 'an artifact that does not exist',
    reason: 'Step 1 artifact screenshots/step-1.png does not exist in the run directory.',
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

it('returns the stopped-run refusal for a stopped run with an artifact under a regular file', async () => {
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

it('returns the stopped-run refusal for a stopped run with an unreadable artifact', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
    stop: { exitCode: 0, logPath: 'stop.log' },
  });

  const artifactPath = await unreadableArtifact(directory);
  const before = await listItems(directory);
  const failure = await failureMessage(recordItem(root, inputWithArtifact(artifactPath)));

  expect({ failure, items: await listItems(directory) }).toEqual({
    failure: `Run ${run} is stopped; record results before the manager stops it.`,
    items: before,
  });
});

it('refuses an unreadable artifact in an open run', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  const artifactPath = await unreadableArtifact(directory);
  const before = await listItems(directory);
  const failure = await failureMessage(recordItem(root, inputWithArtifact(artifactPath)));

  expect({ failure, items: await listItems(directory) }).toEqual({
    failure: `Step 1 artifact ${artifactPath} cannot be read in the run directory.`,
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

it('records an item from a linked worktree under the shared root', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await mkdir(join(directory, 'screenshots'), { recursive: true });
  await writeFile(join(directory, 'screenshots', 'step-1.png'), 'png');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const worktree = join(temporaryDirectory(onTestFinished, 'tau-item-worktree-'), 'worktree');

  await git(root, 'worktree', 'add', '--quiet', worktree, 'HEAD');

  const saved = await recordItem(worktree, validInput());

  expect(saved).toEqual({ run, item, path: itemRecordPath(directory, item) });
  expect(saved.path.startsWith(verificationDirectoryPath(root))).toBe(true);

  expect(await readItemRecord(saved.path)).toMatchObject({
    status: 'valid',
    record: { run, item },
  });
});

it('refuses an item when the shared verification folder is a symlink', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await mkdir(join(directory, 'screenshots'), { recursive: true });
  await writeFile(join(directory, 'screenshots', 'step-1.png'), 'png');

  const outside = temporaryDirectory(onTestFinished, 'tau-item-outside-');

  await rename(verificationDirectoryPath(root), join(outside, 'verification'));
  await symlink(join(outside, 'verification'), verificationDirectoryPath(root));

  const failure = await failureMessage(recordItem(root, validInput()));

  expect(failure).toBe('Refusing to write through a symlink: .tau/verification');
  expect(existsSync(itemRecordPath(directory, item))).toBe(false);
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

  const [result] = await readRuns(verificationDirectoryPath(root));

  expect(
    result?.items.map(({ item: name, read }) => ({ item: name, status: read.status })),
  ).toEqual([
    { item: 'journeys/one', status: 'valid' },
    { item: 'journeys/two', status: 'valid' },
  ]);
});

it('surfaces a publication failure that is not a duplicate', async () => {
  if (process.getuid?.() === 0) {
    return;
  }

  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await mkdir(join(directory, 'screenshots'), { recursive: true });
  await writeFile(join(directory, 'screenshots', 'step-1.png'), 'png');

  const itemDirectory = join(directory, 'items', 'journeys');

  await mkdir(itemDirectory, { recursive: true });
  await chmod(itemDirectory, 0o500);
  onTestFinished(() => chmod(itemDirectory, 0o700));

  const failure = await failureMessage(recordItem(root, validInput()));

  expect(failure).toContain('EACCES');
});

it('gives the item file the mode a new record gets', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await mkdir(join(directory, 'screenshots'), { recursive: true });
  await writeFile(join(directory, 'screenshots', 'step-1.png'), 'png');

  const saved = await recordItem(root, validInput());
  const reference = join(directory, 'reference');

  await writeFile(reference, '');

  expect((await stat(saved.path)).mode).toBe((await stat(reference)).mode);
});

it('saves one record from the winner when two writes for one item collide', async () => {
  const { root, directory } = await createRunDirectory(onTestFinished, run, {
    items: [{ item, steps: 2 }],
  });

  await mkdir(join(directory, 'screenshots'), { recursive: true });
  await writeFile(join(directory, 'screenshots', 'step-1.png'), 'png');

  const inputWithObserved = (observed: string) => {
    const input = validInput();

    input.steps[1] = { status: 'differs', observed, artifacts: [] };

    return input;
  };

  const inputs = [inputWithObserved('first'), inputWithObserved('second')];

  // Both writers pass the existing-file check, so the loser reaches the link and gets EEXIST.
  preCheck.skip = true;

  const results = await Promise.allSettled(inputs.map((input) => recordItem(root, input)));

  preCheck.skip = false;

  const fulfilled = results.filter((result) => result.status === 'fulfilled');

  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [errorMessage(result.reason)] : [],
  );

  expect({ fulfilled: fulfilled.length, failures }).toEqual({
    fulfilled: 1,
    failures: [`Item ${item} already has a result in run ${run}. Each item is recorded once.`],
  });

  const rejection = results.find((result) => result.status === 'rejected');

  expect(rejection).toMatchObject({ reason: { cause: { code: 'EEXIST' } } });

  const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
  const winner = inputs[winnerIndex];

  if (winner === undefined) {
    throw new Error('No write won the race.');
  }

  const expected: ItemRecord = {
    version: itemRecordVersion,
    run,
    item,
    drive: 'hand',
    steps: winner.steps.map((step, index) => ({ ...step, number: index + 1 })),
    endState: winner.endState,
  };

  expect(await readFile(itemRecordPath(directory, item), 'utf8')).toBe(
    `${JSON.stringify(expected, null, 2)}\n`,
  );

  expect(await listItems(directory)).toEqual(['journeys', 'journeys/delegate-a-check.json']);
});
