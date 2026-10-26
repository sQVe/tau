import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import askUserQuestionExtension from './extensions/askUserQuestion/askUserQuestion.js';
import bareRootExtension from './extensions/bareRoot.js';
import codemodeExtension from './extensions/codemode.js';
import codeReviewExtension from './extensions/codeReview/codeReview.js';
import commitExtension from './extensions/commit/commit.js';
import compactionExtension from './extensions/compaction/compaction.js';
import draftReviewExtension from './extensions/draftReview/draftReview.js';
import fullCheckExtension from './extensions/fullCheck/fullCheck.js';
import handoverExtension from './extensions/handover/handover.js';
import herdrBlockedExtension from './extensions/herdrBlocked.js';
import instructionsExtension from './extensions/instructions.js';
import prExtension from './extensions/pr/pr.js';
import prFeedbackExtension from './extensions/prFeedback/prFeedback.js';
import sliceExtension from './extensions/slice/slice.js';
import snippetsExtension from './extensions/snippets/snippets.js';
import stackExtension from './extensions/stack/stack.js';
import staticLoaderExtension from './extensions/staticLoader.js';
import statusbarExtension from './extensions/statusbar/statusbar.js';
import subagentsExtension, { registerCapacityRefusal } from './extensions/subagents/subagents.js';
import tauSkillsExtension from './extensions/tauSkills/tauSkills.js';
import tddExtension from './extensions/tdd/tdd.js';
import trackerExtension from './extensions/tracker/tracker.js';
import webAccessExtension from './extensions/webAccess.js';

const skillsDirectory = fileURLToPath(new URL('./skills/', import.meta.url));

export default async function tauExtension(pi: ExtensionAPI): Promise<void> {
  // Pi stops at the first blocking hook, so capacity refusal must run before other guards.
  const capacityRefusal = registerCapacityRefusal(pi);

  await instructionsExtension(pi);
  codemodeExtension(pi);

  tauSkillsExtension(pi, skillsDirectory);
  commitExtension(pi);
  tddExtension(pi);
  askUserQuestionExtension(pi);
  webAccessExtension(pi);
  snippetsExtension(pi);
  sliceExtension(pi);
  fullCheckExtension(pi);
  handoverExtension(pi);
  draftReviewExtension(pi);
  trackerExtension(pi);
  prExtension(pi);
  prFeedbackExtension(pi);
  stackExtension(pi);
  codeReviewExtension(pi);
  staticLoaderExtension(pi);
  statusbarExtension(pi);
  subagentsExtension(pi, capacityRefusal);
  compactionExtension(pi);
  bareRootExtension(pi);
  herdrBlockedExtension(pi);
}
