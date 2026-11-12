import { expect, it } from 'vitest';

import { delegationGuidelines } from './managerPrompt.js';
import { qaGuidePath } from './qaBrief.js';

it('adds one line that names the QA procedure and the guide only when given a procedure path', () => {
  const procedurePath = '/tau/src/skills/shared/qa-launch.md';
  const withGuide = delegationGuidelines(undefined, procedurePath);
  const withoutGuide = delegationGuidelines(undefined, undefined);
  const addedGuidelines = withGuide.filter((guideline) => !withoutGuide.includes(guideline));
  const sharedGuidelines = withGuide.filter((guideline) => withoutGuide.includes(guideline));

  expect(addedGuidelines).toHaveLength(1);
  expect(addedGuidelines[0]).toContain(procedurePath);
  expect(addedGuidelines[0]).toContain(qaGuidePath);
  expect(sharedGuidelines).toEqual(withoutGuide);
  expect(withoutGuide.some((guideline) => guideline.includes(qaGuidePath))).toBe(false);
});
