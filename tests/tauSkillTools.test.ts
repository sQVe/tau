import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import codeReviewExtension from '../src/extensions/codeReview/codeReview.js';
import prFeedbackExtension from '../src/extensions/prFeedback/prFeedback.js';
import sliceExtension from '../src/extensions/slice/slice.js';
import tauSkillsExtension from '../src/extensions/tauSkills/tauSkills.js';
import trackerExtension from '../src/extensions/tracker/tracker.js';
import { skillTools } from '../src/tau.js';
import { fakeExtensionApi } from './extensionApi.js';

const skillsDirectory = resolve(import.meta.dirname, '../src/skills');

it.each([
  { skill: 'slice', tool: 'slice' },
  { skill: 'pr-feedback', tool: 'pr_feedback' },
  { skill: 'code-review', tool: 'code_review' },
  { skill: 'tracker', tool: 'tracker_evidence' },
])('keeps $tool off until the $skill skill runs', async ({ skill, tool }) => {
  let active: string[] = [];

  const fake = fakeExtensionApi({
    getActiveTools: () => active,
    setActiveTools: (toolNames: string[]) => {
      active = toolNames;
    },
  });

  tauSkillsExtension(fake.pi, skillsDirectory, skillTools);
  sliceExtension(fake.pi);
  prFeedbackExtension(fake.pi);
  codeReviewExtension(fake.pi);
  trackerExtension(fake.pi);

  expect(fake.tools.get(tool)?.defaultActive).toBe(false);

  await fake.commands.get(skill)?.handler('', { isIdle: () => true } as never);

  expect(active).toEqual([tool]);
});
