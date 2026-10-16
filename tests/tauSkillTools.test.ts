import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, it } from 'vitest';

import codeReviewExtension from '../src/extensions/codeReview/codeReview.js';
import draftReviewExtension from '../src/extensions/draftReview/draftReview.js';
import fullCheckExtension from '../src/extensions/fullCheck/fullCheck.js';
import handoverExtension from '../src/extensions/handover/handover.js';
import prExtension from '../src/extensions/pr/pr.js';
import prFeedbackExtension from '../src/extensions/prFeedback/prFeedback.js';
import sliceExtension from '../src/extensions/slice/slice.js';
import stackExtension from '../src/extensions/stack/stack.js';
import trackerExtension from '../src/extensions/tracker/tracker.js';
import { skillTools } from '../src/skillTools.js';
import { fakeExtensionApi } from './extensionApi.js';

it('maps existing skills to registered tools', () => {
  const fake = fakeExtensionApi();

  draftReviewExtension(fake.pi);
  fullCheckExtension(fake.pi);
  sliceExtension(fake.pi);
  handoverExtension(fake.pi);
  prExtension(fake.pi);
  prFeedbackExtension(fake.pi);
  stackExtension(fake.pi);
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
