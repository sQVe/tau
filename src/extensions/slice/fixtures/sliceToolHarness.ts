import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createLinearFake } from '../../../../tests/linearFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../../tests/toolContext.js';
import type { SliceApplyDetails, StepSummary } from '../apply.js';
import type { PartialApplyFailureDetails } from '../partialApply.js';
import { createSliceTool } from '../tool.js';
import type { SliceInput, SliceReadDetails, SliceToolDetails } from '../tool.js';

type Fake = ReturnType<typeof createLinearFake>;

type SliceApplyOutcome = SliceApplyDetails | PartialApplyFailureDetails<StepSummary>;

interface Setup {
  root: string;
  fake: Fake;
  context: ExtensionToolContext;
  directory: string;
  read: (container?: string) => Promise<SliceReadDetails>;
  apply: (applyContext?: ExtensionToolContext, at?: string) => Promise<SliceApplyOutcome>;
}

export const fixtures = join(import.meta.dirname, 'plans');

export const temporaryRepository = (): Promise<string> => createTemporaryRepository(onTestFinished);

export const run = async (
  fake: Fake,
  context: ExtensionToolContext,
  input: SliceInput,
): Promise<SliceToolDetails> => {
  const tool = createSliceTool(fake.exec);
  const result = await tool.execute('call', input, undefined, undefined, context);

  return result.details;
};

export const readDetails = (details: SliceToolDetails): SliceReadDetails => {
  if (!('stateToken' in details)) {
    throw new Error(`Expected a read result, got ${JSON.stringify(details)}`);
  }

  return details;
};

const applyDetails = (details: SliceToolDetails): SliceApplyOutcome => {
  if (!('applied' in details)) {
    throw new Error(`Expected an apply result, got ${JSON.stringify(details)}`);
  }

  return details;
};

export const failureDetails = (
  details: SliceToolDetails,
): PartialApplyFailureDetails<StepSummary> => {
  if (!('error' in details)) {
    throw new Error(`Expected a failed apply, got ${JSON.stringify(details)}`);
  }

  return details;
};

export const savedPlan = async (
  directory: string,
): Promise<{
  container: { identifier: string | null };
  slices: { identifier: string | null }[];
}> =>
  JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
    container: { identifier: string | null };
    slices: { identifier: string | null }[];
  };

export const snapshotDraft = async (directory: string): Promise<string[][]> => {
  const names = await readdir(directory);

  return Promise.all(
    names.toSorted().map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
  );
};

export const expectReadOnly = async <Value>(
  fake: Fake,
  directory: string,
  read: () => Promise<Value>,
): Promise<{ value?: Value; error?: string }> => {
  const draftBefore = await snapshotDraft(directory);
  const writesBefore = fake.writes().length;

  const outcome: { value?: Value; error?: string } = await read().then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );

  expect(await snapshotDraft(directory)).toEqual(draftBefore);
  expect(fake.writes()).toHaveLength(writesBefore);

  return outcome;
};

export const setUp = async (
  fixture = 'version-1.json',
  createRoot: () => Promise<string> = temporaryRepository,
): Promise<Setup> => {
  const root = await createRoot();
  const fake = createLinearFake();
  const context = noUiContext(root);
  const { directory } = await run(fake, context, { action: 'prepare', id: 'planning' });

  await copyFile(join(fixtures, fixture), join(directory, 'plan.json'));
  await writeFile(join(directory, 'container.md'), 'The design.\n');
  await writeFile(join(directory, 'slice-1.md'), 'Slice one.\n');
  await writeFile(join(directory, 'slice-2.md'), 'Slice two.\n');

  let current = directory;

  const read = async (container?: string) =>
    readDetails(
      await run(fake, context, {
        action: 'read',
        directory: current,
        ...(container === undefined ? {} : { container }),
      }),
    );

  const apply = async (applyContext: ExtensionToolContext = context, at = current) => {
    const { stateToken } = readDetails(
      await run(fake, applyContext, { action: 'read', directory: at }),
    );

    const result = applyDetails(
      await run(fake, applyContext, {
        action: 'apply',
        directory: at,
        stateToken: stateToken,
      }),
    );

    current = result.directory;

    return result;
  };

  return { root, fake, context, directory, read, apply };
};

export const outsideDirectory = async (): Promise<string> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-slice-outside-');

  return directory;
};

export const appliedPlan = async (): Promise<Setup> => {
  const setup = await setUp();
  const { directory } = await setup.apply();

  return { ...setup, directory };
};
