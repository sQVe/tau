import { expect, it } from 'vitest';

import { codingSetText } from './guideRuns.js';
import type { GuideRuns } from './guideRuns.js';
import { instructionTexts, readInstructionSections, readInstructionSet } from './instructions.js';
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
  const sections = await readInstructionSections(['workflow', 'coding', 'writing']);

  expect(sections).toEqual([
    { kind: 'file', text: await readInstructionSet('writing') },
    { kind: 'coding' },
    { kind: 'file', text: await readInstructionSet('workflow') },
  ]);
});

it('reads no section for an empty selection', async () => {
  expect(await readInstructionSections([])).toEqual([]);
});

it('puts the guides of the run into the coding section only', async () => {
  const texts = await instructionTexts(
    [{ kind: 'file', text: 'first set' }, { kind: 'coding' }, { kind: 'file', text: 'last set' }],
    guideRuns(() => Promise.resolve(brokenSnapshot)),
  );

  expect(texts).toEqual(['first set', codingSetText(brokenSnapshot), 'last set']);
});

it('does not read the guides for sections without the coding set', async () => {
  const texts = await instructionTexts(
    [{ kind: 'file', text: 'only set' }],
    guideRuns(() => Promise.reject(new Error('the guides must not be read'))),
  );

  expect(texts).toEqual(['only set']);
});
