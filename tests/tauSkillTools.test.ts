import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import codeReviewExtension from '../src/extensions/codeReview/codeReview.js';
import prExtension from '../src/extensions/pr/pr.js';
import prFeedbackExtension from '../src/extensions/prFeedback/prFeedback.js';
import sliceExtension from '../src/extensions/slice/slice.js';
import trackerExtension from '../src/extensions/tracker/tracker.js';
import { skillTools } from '../src/skillTools.js';
import { fakeExtensionApi } from './extensionApi.js';

it('maps existing skills to registered tools', () => {
  const fake = fakeExtensionApi();

  sliceExtension(fake.pi);
  prExtension(fake.pi);
  prFeedbackExtension(fake.pi);
  codeReviewExtension(fake.pi);
  trackerExtension(fake.pi);

  for (const [skill, tools] of Object.entries(skillTools)) {
    const skillFile = resolve(import.meta.dirname, '../src/skills', skill, 'SKILL.md');

    expect(existsSync(skillFile)).toBe(true);

    for (const tool of tools) {
      expect(fake.tools.has(tool)).toBe(true);
    }
  }
});
