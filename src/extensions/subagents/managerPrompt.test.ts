import { expect, it } from 'vitest';

import { delegationGuidelines } from './managerPrompt.js';

const namesQaGuide = (guideline: string): boolean =>
  guideline.includes('.pi/qa.md') || guideline.includes('QA guide');

it('tells the manager how to use the QA guide only when the repository has one', () => {
  const withGuide = delegationGuidelines(undefined, true);
  const withoutGuide = delegationGuidelines(undefined, false);

  expect(withGuide.filter(namesQaGuide)).toHaveLength(6);
  expect(withGuide.filter((guideline) => guideline.includes('.pi/qa.md'))).toHaveLength(1);
  expect(withoutGuide).toEqual(withGuide.filter((guideline) => !namesQaGuide(guideline)));
});
