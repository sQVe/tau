import { expect, it } from 'vitest';

import { delegationGuidelines } from './managerPrompt.js';
import { qaGuidePath } from './qaBrief.js';

const namesQaGuidePath = (guideline: string): boolean => guideline.includes(qaGuidePath);

it('adds guidelines that point the manager to the QA guide only when the repository has one', () => {
  const withGuide = delegationGuidelines(undefined, true);
  const withoutGuide = delegationGuidelines(undefined, false);
  const sharedGuidelines = withGuide.filter((guideline) => withoutGuide.includes(guideline));

  expect(withGuide.some(namesQaGuidePath)).toBe(true);
  expect(withoutGuide.some(namesQaGuidePath)).toBe(false);
  expect(withGuide.length).toBeGreaterThan(withoutGuide.length);
  expect(sharedGuidelines).toEqual(withoutGuide);
});
