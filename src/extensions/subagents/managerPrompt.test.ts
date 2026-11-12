import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { expect, it } from 'vitest';

import { delegationGuidelines } from './managerPrompt.js';
import { qaGuidePath } from './qaBrief.js';

it('adds one existing QA procedure path only when the repository has a guide', () => {
  const withGuide = delegationGuidelines(undefined, true);
  const withoutGuide = delegationGuidelines(undefined, false);
  const addedGuidelines = withGuide.filter((guideline) => !withoutGuide.includes(guideline));
  const sharedGuidelines = withGuide.filter((guideline) => withoutGuide.includes(guideline));

  expect(addedGuidelines).toHaveLength(1);
  expect(sharedGuidelines).toEqual(withoutGuide);
  expect(withoutGuide.some((guideline) => guideline.includes(qaGuidePath))).toBe(false);

  const guideline = addedGuidelines[0] ?? '';
  const paths = [...guideline.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  const procedurePaths = paths.filter(isAbsolute);

  expect(guideline).toContain(qaGuidePath);
  expect(procedurePaths).toHaveLength(1);
  expect(existsSync(procedurePaths[0] ?? '')).toBe(true);
});
