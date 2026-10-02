import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import askUserQuestionExtension from './extensions/askUserQuestion/askUserQuestion.js';
import bareRootExtension from './extensions/bareRoot.js';
import bulkReadExtension from './extensions/bulkRead/bulkRead.js';
import codingExtension from './extensions/coding.js';
import commitExtension from './extensions/commit/commit.js';
import compactionExtension from './extensions/compaction/compaction.js';
import herdrBlockedExtension from './extensions/herdrBlocked.js';
import snippetsExtension from './extensions/snippets/snippets.js';
import statusbarExtension from './extensions/statusbar/statusbar.js';
import subagentsExtension from './extensions/subagents/subagents.js';
import tauSkillsExtension from './extensions/tauSkills/tauSkills.js';
import tddExtension from './extensions/tdd/tdd.js';
import webAccessExtension from './extensions/webAccess.js';
import workflowExtension from './extensions/workflow.js';
import writingExtension from './extensions/writing.js';

const skillsDirectory = fileURLToPath(new URL('./skills/', import.meta.url));

export default async function tauExtension(pi: ExtensionAPI) {
  await writingExtension(pi);
  await codingExtension(pi);
  await workflowExtension(pi);

  tauSkillsExtension(pi, skillsDirectory);
  commitExtension(pi);
  tddExtension(pi);
  bulkReadExtension(pi);
  askUserQuestionExtension(pi);
  webAccessExtension(pi);
  snippetsExtension(pi);
  statusbarExtension(pi);
  subagentsExtension(pi);
  compactionExtension(pi);
  bareRootExtension(pi);
  herdrBlockedExtension(pi);
}
