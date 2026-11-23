import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { codingSetText } from './guideRuns.js';
import type { GuideRuns } from './guideRuns.js';
import {
  bundledInstructionsDirectory,
  instructionTexts,
  readInstructionSections,
  readInstructionSet,
} from './instructions.js';
import type { GuideSnapshot } from './stommeGuides/stommeGuides.js';

const brokenSnapshot = {
  kind: 'broken',
  root: '/project',
  reason: 'the guides are damaged',
} satisfies GuideSnapshot;

const guideRuns = (snapshot: () => Promise<GuideSnapshot>): Pick<GuideRuns, 'snapshot'> => ({
  snapshot,
});

it('reads the selected sets in the fixed order and leaves the coding set to the guides', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-instructions-order-');

  await writeFile(join(directory, 'writing.md'), 'Writing rules.\n');
  await writeFile(join(directory, 'workflow.md'), 'Workflow rules.\n');

  const sections = await readInstructionSections(['workflow', 'coding', 'writing'], directory);

  expect(sections).toEqual([
    { kind: 'file', text: 'Writing rules.' },
    { kind: 'coding' },
    { kind: 'file', text: 'Workflow rules.' },
  ]);
});

it('rejects a blank set with a message that names its path', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-instructions-empty-');
  const path = join(directory, 'writing.md');

  await writeFile(path, '  \n\n');

  await expect(readInstructionSet('writing', directory)).rejects.toThrow(path);
});

it('reads no section for an empty selection', async () => {
  expect(await readInstructionSections([], bundledInstructionsDirectory)).toEqual([]);
});

it('puts the guides of the run into the coding section only', async () => {
  const texts = await instructionTexts(
    [{ kind: 'file', text: 'first set' }, { kind: 'coding' }, { kind: 'file', text: 'last set' }],
    guideRuns(() => Promise.resolve(brokenSnapshot)),
  );

  expect(texts).toEqual(['first set', codingSetText(brokenSnapshot), 'last set']);
});

it('tells the manager to read each item state from its own source', async () => {
  const workflow = await readInstructionSet('workflow', bundledInstructionsDirectory);
  const collapsed = workflow.replaceAll(/\s+/gu, ' ');

  expect(collapsed).toContain(
    "Before you act on or report a set of items, read each item's current state from the system that owns it: repository metadata for archived state, open PRs for finished work, and live terminals for running work.",
  );
});

it('does not read the guides for sections without the coding set', async () => {
  const texts = await instructionTexts(
    [{ kind: 'file', text: 'only set' }],
    guideRuns(() => Promise.reject(new Error('the guides must not be read'))),
  );

  expect(texts).toEqual(['only set']);
});
