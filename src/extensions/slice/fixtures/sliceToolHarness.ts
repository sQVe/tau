import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createLinearFake } from '../../../../tests/linearFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../../tests/toolContext.js';
import { createSliceTool } from '../tool.js';
import type { SliceInput } from '../tool.js';

type Fake = ReturnType<typeof createLinearFake>;

type ToolResult = Record<string, unknown> & { directory: string };

interface Setup {
  root: string;
  fake: Fake;
  context: ExtensionToolContext;
  directory: string;
  read: (container?: string) => Promise<ToolResult>;
  apply: (applyContext?: ExtensionToolContext, at?: string) => Promise<ToolResult>;
}

export const fixtures = join(import.meta.dirname, 'plans');

export const temporaryRepository = (): Promise<string> => createTemporaryRepository(onTestFinished);

export const run = async (
  fake: Fake,
  context: ExtensionToolContext,
  input: SliceInput,
): Promise<ToolResult> => {
  const tool = createSliceTool(fake.exec);
  const result = await tool.execute('call', input, undefined, undefined, context);

  return result.details as Record<string, unknown> & { directory: string };
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

// Runs a read and checks that it changed no draft file and made no Linear write.
export const expectReadOnly = async (
  fake: Fake,
  directory: string,
  read: () => Promise<unknown>,
): Promise<{ value?: unknown; error?: string }> => {
  const draftBefore = await snapshotDraft(directory);
  const writesBefore = fake.writes().length;

  const outcome: { value?: unknown; error?: string } = await read().then(
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
  // Without a UI, any confirm prompt would throw, so every apply here also shows that apply
  // never asks the user.
  const context = noUiContext(root);
  const { directory } = await run(fake, context, { action: 'prepare', id: 'planning' });

  await copyFile(join(fixtures, fixture), join(directory, 'plan.json'));
  await writeFile(join(directory, 'container.md'), 'The design.\n');
  await writeFile(join(directory, 'slice-1.md'), 'Slice one.\n');
  await writeFile(join(directory, 'slice-2.md'), 'Slice two.\n');

  // Follows the draft when apply moves it to the container's identifier.
  let current = directory;

  const read = (container?: string) =>
    run(fake, context, {
      action: 'read',
      directory: current,
      ...(container === undefined ? {} : { container }),
    });

  const apply = async (applyContext: ExtensionToolContext = context, at = current) => {
    const { stateToken } = await run(fake, applyContext, { action: 'read', directory: at });

    const result = await run(fake, applyContext, {
      action: 'apply',
      directory: at,
      stateToken: String(stateToken),
    });

    current = result.directory;

    return result;
  };

  return { root, fake, context, directory, read, apply };
};

export const outsideDirectory = async (): Promise<string> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-slice-outside-');

  return directory;
};

// Creates the container and both slices, then returns the moved draft directory.
export const appliedPlan = async (): Promise<Setup> => {
  const setup = await setUp();
  const { directory } = await setup.apply();

  return { ...setup, directory };
};
